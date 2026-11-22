// Permintaan masuk — khusus Admin Pusat.
//   GET  /api/admin/requests                       pendaftaran & permintaan reset yang menunggu
//   POST {action:'approve', id, jabatan, bam_scope}  setujui pendaftaran -> akun aktif (password = pilihan pendaftar)
//   POST {action:'reject',  id, catatan?}            tolak pendaftaran
//   POST {action:'reset',   id}                      proses permintaan reset -> password sementara (tampil sekali)
//   POST {action:'dismiss', id}                      abaikan permintaan reset
import { getDb } from '../../_lib/db.js';
import { json, errorResponse, readJson, checkOrigin, HttpError } from '../../_lib/http.js';
import { requireUser, audit, JABATAN, LABEL, normScope, isUtama, isFullRole } from '../../_lib/auth.js';
import { hashPassword, tempPassword, iterFrom } from '../../_lib/security.js';

async function bamList(db) {
  const r = await db.query("SELECT DISTINCT UPPER(TRIM(bam)) AS bam FROM toko WHERE bam IS NOT NULL AND TRIM(bam) <> '' ORDER BY 1");
  return r.map((x) => x.bam);
}

export async function handleGet({ request }, db) {
  const me = await requireUser(db, request, { need: 'pusat' });
  const regs = await db.query(
    "SELECT id, nik, nama, jabatan_diminta, area_diminta, kontak, created_at FROM registrations WHERE status = 'PENDING' ORDER BY id");
  const rst = await db.query(
    "SELECT r.id, r.nik, r.kontak, r.created_at, u.nama, u.jabatan FROM reset_requests r LEFT JOIN users u ON u.nik = r.nik WHERE r.status = 'PENDING' ORDER BY r.id");
  return json({
    registrations: regs.map((r) => ({ id: Number(r.id), nik: r.nik, nama: r.nama, jabatan_diminta: r.jabatan_diminta,
      label_diminta: LABEL[r.jabatan_diminta] || r.jabatan_diminta, area_diminta: r.area_diminta, kontak: r.kontak || '', created_at: r.created_at || null })),
    resets: rst.map((r) => ({ id: Number(r.id), nik: r.nik, nama: r.nama || '', label: LABEL[r.jabatan] || '', kontak: r.kontak || '', created_at: r.created_at || null })),
    bamList: await bamList(db),
    jabatan: JABATAN.filter((k) => isUtama(me) || k !== 'ADMIN_PUSAT').map((k) => ({ key: k, label: LABEL[k] })),
  });
}

export async function handlePost({ request, env }, db) {
  checkOrigin(request);
  const me = await requireUser(db, request, { need: 'pusat' });
  const b = await readJson(request, 50_000);
  const id = Number(b.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'ID permintaan tidak valid.');

  if (b.action === 'approve' || b.action === 'reject') {
    const r = await db.query('SELECT id, nik, nama, pw_hash, pw_salt, pw_iter, status FROM registrations WHERE id = ? LIMIT 1', [id]);
    if (!r.length) throw new HttpError(404, 'Pendaftaran tidak ditemukan.');
    const reg = r[0];
    if (reg.status !== 'PENDING') throw new HttpError(409, 'Pendaftaran ini sudah diproses.', 'DONE');

    if (b.action === 'reject') {
      const catatan = String(b.catatan == null ? '' : b.catatan).replace(/\s+/g, ' ').trim().slice(0, 250);
      await db.exec("UPDATE registrations SET status = 'REJECTED', catatan = ?, diproses_oleh = ?, diproses_at = UTC_TIMESTAMP() WHERE id = ?",
        [catatan || null, me.nik, id]);
      await audit(db, { nik: me.nik, aksi: 'tolak_daftar', target: reg.nik, detail: catatan });
      return json({ ok: true });
    }

    if (!JABATAN.includes(b.jabatan)) throw new HttpError(400, 'Tentukan jabatan yang benar.');
    if (b.jabatan === 'ADMIN_PUSAT' && !isUtama(me)) throw new HttpError(403, 'Tidak diizinkan.', 'FORBIDDEN');
    let scope = null;
    if (!isFullRole(b.jabatan)) {
      scope = normScope(b.bam_scope);
      if (!scope.length) throw new HttpError(400, 'Tentukan minimal satu BAM untuk area jabatan ini.', 'NO_SCOPE');
    }
    if ((await db.query('SELECT 1 FROM users WHERE nik = ? LIMIT 1', [reg.nik])).length)
      throw new HttpError(409, 'NIK itu sudah ada di daftar pengguna.', 'EXISTS');
    await db.exec(
      'INSERT INTO users (nik, nama, jabatan, bam_scope, aktif, pw_hash, pw_salt, pw_iter, must_change, pw_changed_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 0, UTC_TIMESTAMP())',
      [reg.nik, reg.nama, b.jabatan, scope ? JSON.stringify(scope) : null, reg.pw_hash, reg.pw_salt, reg.pw_iter]);
    await db.exec("UPDATE registrations SET status = 'APPROVED', diproses_oleh = ?, diproses_at = UTC_TIMESTAMP() WHERE id = ?", [me.nik, id]);
    await audit(db, { nik: me.nik, aksi: 'setuju_daftar', target: reg.nik, detail: b.jabatan });
    const known = new Set(await bamList(db));
    return json({ ok: true, nik: reg.nik, unknownBam: (scope || []).filter((x) => !known.has(x)) });
  }

  if (b.action === 'reset' || b.action === 'dismiss') {
    const r = await db.query('SELECT id, nik, status FROM reset_requests WHERE id = ? LIMIT 1', [id]);
    if (!r.length) throw new HttpError(404, 'Permintaan tidak ditemukan.');
    const rq = r[0];
    if (rq.status !== 'PENDING') throw new HttpError(409, 'Permintaan ini sudah diproses.', 'DONE');

    if (b.action === 'dismiss') {
      await db.exec("UPDATE reset_requests SET status = 'REJECTED', diproses_oleh = ?, diproses_at = UTC_TIMESTAMP() WHERE id = ?", [me.nik, id]);
      return json({ ok: true });
    }
    const u = await db.query('SELECT nik, jabatan, aktif FROM users WHERE nik = ? LIMIT 1', [rq.nik]);
    if (!u.length || Number(u[0].aktif) !== 1) {
      await db.exec("UPDATE reset_requests SET status = 'REJECTED', diproses_oleh = ?, diproses_at = UTC_TIMESTAMP() WHERE id = ?", [me.nik, id]);
      throw new HttpError(404, 'Pengguna tidak ditemukan atau sudah nonaktif; permintaan ditutup.');
    }
    if (u[0].jabatan === 'ADMIN_PUSAT' && !isUtama(me)) throw new HttpError(403, 'Tidak diizinkan.', 'FORBIDDEN');
    const pw = tempPassword();
    const h = await hashPassword(pw, undefined, iterFrom(env));
    await db.exec(
      'UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ?, must_change = 1, failed_count = 0, locked_until = NULL WHERE nik = ?',
      [h.pw_hash, h.pw_salt, h.pw_iter, rq.nik]);
    await db.exec('DELETE FROM sessions WHERE nik = ?', [rq.nik]);
    await db.exec("UPDATE reset_requests SET status = 'DONE', diproses_oleh = ?, diproses_at = UTC_TIMESTAMP() WHERE id = ?", [me.nik, id]);
    await audit(db, { nik: me.nik, aksi: 'reset_pw', target: rq.nik, detail: 'via permintaan' });
    return json({ ok: true, nik: rq.nik, tempPassword: pw });
  }

  throw new HttpError(400, 'Aksi tidak dikenal.');
}

export async function onRequestGet(ctx) {
  try { return await handleGet(ctx, await getDb(ctx.env)); } catch (e) { return errorResponse(e); }
}
export async function onRequestPost(ctx) {
  try { return await handlePost(ctx, await getDb(ctx.env)); } catch (e) { return errorResponse(e); }
}
