// Kelola pengguna — khusus Admin Pusat.
//   GET  /api/admin/users                                   daftar pengguna + daftar BAM yang ada
//   POST /api/admin/users {action:'create', nik, nama, jabatan, area?:{koorbam[],bam[],cabang[]} | bam_scope?, password?}
//   POST /api/admin/users {action:'update', nik, nama?, jabatan?, area? | bam_scope?, aktif?}
//   POST /api/admin/users {action:'reset',  nik}            password sementara (tampil satu kali)
import { getDb } from '../../_lib/db.js';
import { json, errorResponse, readJson, checkOrigin, HttpError } from '../../_lib/http.js';
import { requireUser, audit, JABATAN, LABEL, normNik, normScope, parseScope, isUtama, isFullRole } from '../../_lib/auth.js';
import { hashPassword, tempPassword, checkPasswordPolicy, iterFrom } from '../../_lib/security.js';
import { loadHierarchySafe, hasSelection, resolveArea, packArea, readArea, areaText } from '../../_lib/area.js';

const row = (r) => ({
  nik: r.nik, nama: r.nama, jabatan: r.jabatan, label: LABEL[r.jabatan] || r.jabatan,
  bam_scope: isFullRole(r.jabatan) ? null : parseScope(r.bam_scope),
  cabang_scope: isFullRole(r.jabatan) ? null : readArea(r.bam_scope).cabang,
  area_sel: isFullRole(r.jabatan) ? null : readArea(r.bam_scope).sel,
  area_text: isFullRole(r.jabatan) ? '' : areaText(readArea(r.bam_scope)),
  aktif: Number(r.aktif) === 1, must_change: Number(r.must_change) === 1,
  last_login: r.last_login || null, pw_changed_at: r.pw_changed_at || null, created_at: r.created_at || null,
});

async function bamList(db) {
  const r = await db.query("SELECT DISTINCT UPPER(TRIM(bam)) AS bam FROM toko WHERE bam IS NOT NULL AND TRIM(bam) <> '' ORDER BY 1");
  return r.map((x) => x.bam);
}

// Nama BAM yang diketik tapi tidak ada di data toko (kemungkinan salah ketik) — peringatan, bukan error.
async function unknownBam(db, scope) {
  if (!scope.length) return [];
  const known = new Set(await bamList(db));
  return scope.filter((b) => !known.has(b));
}

function scopeFor(jabatan, input) {
  if (isFullRole(jabatan)) return null;
  const s = normScope(input);
  if (!s.length) throw new HttpError(400, 'Tentukan minimal satu BAM untuk area jabatan ini.', 'NO_SCOPE');
  return s;
}

// Nilai yang disimpan di users.bam_scope: null (akses penuh) | array BAM (cara lama) | objek {bam, cabang, sel} (pilihan KOORBAM/BAM/CABANG).
// Tanpa pilihan baru, area yang sudah ada dipertahankan apa adanya (mis. hanya jabatan yang diubah tidak menghapus pembatas cabang).
async function scopeStore(db, jabatan, b, existingRaw) {
  if (isFullRole(jabatan)) return null;
  if (hasSelection(b.area)) return packArea(await resolveArea(db, b.area));
  if (b.bam_scope !== undefined) return scopeFor(jabatan, b.bam_scope);
  const cur = readArea(existingRaw);
  if (!cur.bam.length) throw new HttpError(400, 'Tentukan minimal satu BAM untuk area jabatan ini.', 'NO_SCOPE');
  return cur.cabang.length || cur.sel.k.length || cur.sel.b.length || cur.sel.c.length ? packArea(cur) : cur.bam;
}
const scopeBam = (v) => (Array.isArray(v) ? v : v ? v.bam : []);

// Hanya Admin Utama yang boleh memberi/mengubah jabatan Admin Utama. Pembatasan ini sengaja tidak dijelaskan
// kepada Administrator (pesan umum saja), supaya batas akses Administrator tidak mudah dilewati.
const FORBID = () => new HttpError(403, 'Tidak diizinkan.', 'FORBIDDEN');

export async function handleGet({ request }, db) {
  const me = await requireUser(db, request, { need: 'pusat' });
  const users = await db.query(
    'SELECT nik, nama, jabatan, bam_scope, aktif, must_change, last_login, pw_changed_at, created_at FROM users ORDER BY jabatan, nama');
  return json({
    users: users.filter((u) => isUtama(me) || u.jabatan !== 'ADMIN_PUSAT').map(row),   // Administrator tidak melihat akun Admin Utama
    bamList: await bamList(db),
    hier: (await loadHierarchySafe(db)).map((r) => [r.k, r.b, r.c]),
    jabatan: JABATAN.filter((k) => isUtama(me) || k !== 'ADMIN_PUSAT').map((k) => ({ key: k, label: LABEL[k] })),
  });
}

export async function handlePost({ request, env }, db) {
  checkOrigin(request);
  const me = await requireUser(db, request, { need: 'pusat' });
  const b = await readJson(request, 100_000);
  const nik = normNik(b.nik);
  if (!nik) throw new HttpError(400, 'NIK tidak valid (3–30 karakter huruf/angka).');

  if (b.action === 'create') {
    const nama = String(b.nama || '').trim();
    if (!nama || nama.length > 150) throw new HttpError(400, 'Nama wajib diisi (maksimal 150 karakter).');
    if (!JABATAN.includes(b.jabatan)) throw new HttpError(400, 'Jabatan tidak dikenal.');
    if (b.jabatan === 'ADMIN_PUSAT' && !isUtama(me)) throw FORBID();
    const scope = await scopeStore(db, b.jabatan, b, null);
    if ((await db.query('SELECT 1 FROM users WHERE nik = ? LIMIT 1', [nik])).length)
      throw new HttpError(409, 'NIK itu sudah terdaftar.', 'DUP');

    let pw = typeof b.password === 'string' && b.password ? b.password : '';
    let generated = false;
    if (pw) {
      const why = checkPasswordPolicy(pw, nik);
      if (why) throw new HttpError(400, why, 'WEAK');
    } else { pw = tempPassword(); generated = true; }

    const h = await hashPassword(pw, undefined, iterFrom(env));
    await db.exec(
      'INSERT INTO users (nik, nama, jabatan, bam_scope, aktif, pw_hash, pw_salt, pw_iter, must_change) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1)',
      [nik, nama, b.jabatan, scope ? JSON.stringify(scope) : null, h.pw_hash, h.pw_salt, h.pw_iter]);
    await audit(db, { nik: me.nik, aksi: 'buat_user', target: nik, detail: b.jabatan });
    return json({ ok: true, nik, tempPassword: generated ? pw : undefined, unknownBam: Array.isArray(scope) ? await unknownBam(db, scope) : [] });
  }

  const found = await db.query('SELECT nik, jabatan, aktif FROM users WHERE nik = ? LIMIT 1', [nik]);
  if (!found.length) throw new HttpError(404, 'Pengguna tidak ditemukan.');
  const target = found[0];
  if (target.jabatan === 'ADMIN_PUSAT' && !isUtama(me)) throw FORBID();   // Administrator tidak boleh menyentuh akun Admin Utama

  if (b.action === 'update') {
    const sets = [], args = [];
    let newScope = null;
    if (b.nama !== undefined) {
      const nama = String(b.nama).trim();
      if (!nama || nama.length > 150) throw new HttpError(400, 'Nama tidak valid.');
      sets.push('nama = ?'); args.push(nama);
    }
    const jab = b.jabatan !== undefined ? b.jabatan : target.jabatan;
    if (b.jabatan !== undefined) {
      if (!JABATAN.includes(b.jabatan)) throw new HttpError(400, 'Jabatan tidak dikenal.');
      if (b.jabatan === 'ADMIN_PUSAT' && !isUtama(me)) throw FORBID();
      sets.push('jabatan = ?'); args.push(b.jabatan);
    }
    if (b.jabatan !== undefined || b.bam_scope !== undefined || b.area !== undefined) {
      const cur = b.bam_scope === undefined && !hasSelection(b.area) ? (await db.query('SELECT bam_scope FROM users WHERE nik = ?', [nik]))[0].bam_scope : null;
      newScope = await scopeStore(db, jab, b, cur);
      sets.push('bam_scope = ?'); args.push(newScope ? JSON.stringify(newScope) : null);
    }
    if (b.aktif !== undefined) { sets.push('aktif = ?'); args.push(b.aktif ? 1 : 0); }
    if (!sets.length) return json({ ok: true, changed: 0 });

    if (nik === me.nik && ((b.aktif !== undefined && !b.aktif) || !isFullRole(jab)))
      throw new HttpError(400, 'Anda tidak bisa menonaktifkan atau menurunkan jabatan akun sendiri.', 'SELF');

    await db.exec(`UPDATE users SET ${sets.join(', ')} WHERE nik = ?`, [...args, nik]);
    await db.exec('DELETE FROM sessions WHERE nik = ?', [nik]);    // perubahan area/jabatan langsung berlaku
    await audit(db, { nik: me.nik, aksi: 'ubah_user', target: nik, detail: Object.keys(b).filter((k) => k !== 'action' && k !== 'nik').join(',') });
    return json({ ok: true, unknownBam: Array.isArray(newScope) ? await unknownBam(db, newScope) : [] });
  }

  if (b.action === 'reset') {
    const pw = tempPassword();
    const h = await hashPassword(pw, undefined, iterFrom(env));
    await db.exec(
      'UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ?, must_change = 1, failed_count = 0, locked_until = NULL WHERE nik = ?',
      [h.pw_hash, h.pw_salt, h.pw_iter, nik]);
    await db.exec('DELETE FROM sessions WHERE nik = ?', [nik]);
    await audit(db, { nik: me.nik, aksi: 'reset_pw', target: nik });
    return json({ ok: true, nik, tempPassword: pw });
  }

  throw new HttpError(400, 'Aksi tidak dikenal.');
}

export async function onRequestGet(ctx) {
  try { return await handleGet(ctx, await getDb(ctx.env)); } catch (e) { return errorResponse(e); }
}
export async function onRequestPost(ctx) {
  try { return await handlePost(ctx, await getDb(ctx.env)); } catch (e) { return errorResponse(e); }
}
