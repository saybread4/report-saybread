// POST /api/auth/register  { nik, nama, jabatan, area, kontak?, password }
// Pendaftaran mandiri TANPA login. Akun baru dibuat Admin Pusat setelah memverifikasi jabatan & area.
import { getDb } from '../../_lib/db.js';
import { json, errorResponse, readJson, checkOrigin, HttpError } from '../../_lib/http.js';
import { audit, normNik } from '../../_lib/auth.js';
import { hashPassword, checkPasswordPolicy, iterFrom } from '../../_lib/security.js';

// Jabatan yang boleh dipilih saat mendaftar. Jabatan Admin hanya bisa diberikan oleh Admin Pusat.
export const REG_JABATAN = ['KOORBAM', 'BAM', 'BAS', 'BASTR'];
const MAX_PENDING = 300;   // batas antrean, agar tidak bisa dibanjiri pendaftaran palsu

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export async function handle({ request, env }, db) {
  checkOrigin(request);
  const b = await readJson(request, 20_000);
  const nik = normNik(b.nik);
  if (!nik) throw new HttpError(400, 'NIK tidak valid (3–30 karakter huruf/angka).');
  const nama = clean(b.nama, 150);
  if (nama.length < 2) throw new HttpError(400, 'Isi nama lengkap Anda.');
  if (!REG_JABATAN.includes(b.jabatan)) throw new HttpError(400, 'Pilih jabatan Anda.');
  const area = clean(b.area, 200);
  if (!area) throw new HttpError(400, 'Isi area BAM Anda (mis. nama BAM).');
  const kontak = clean(b.kontak, 60);
  const pw = typeof b.password === 'string' ? b.password : '';
  const why = checkPasswordPolicy(pw, nik);
  if (why) throw new HttpError(400, why, 'WEAK');

  if ((await db.query('SELECT 1 FROM users WHERE nik = ? LIMIT 1', [nik])).length)
    throw new HttpError(409, 'NIK ini sudah terdaftar. Silakan masuk, atau gunakan "Lupa password".', 'EXISTS');
  if ((await db.query("SELECT 1 FROM registrations WHERE nik = ? AND status = 'PENDING' LIMIT 1", [nik])).length)
    throw new HttpError(409, 'Pendaftaran NIK ini sudah dikirim dan sedang menunggu verifikasi admin.', 'PENDING');
  const cnt = await db.query("SELECT COUNT(*) AS n FROM registrations WHERE status = 'PENDING'");
  if (Number(cnt[0] && cnt[0].n) >= MAX_PENDING)
    throw new HttpError(429, 'Terlalu banyak pendaftaran yang belum diproses. Coba lagi nanti atau hubungi admin.', 'BUSY');

  const h = await hashPassword(pw, undefined, iterFrom(env));
  await db.exec(
    'INSERT INTO registrations (nik, nama, jabatan_diminta, area_diminta, kontak, pw_hash, pw_salt, pw_iter) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [nik, nama, b.jabatan, area, kontak || null, h.pw_hash, h.pw_salt, h.pw_iter]);
  await audit(db, { nik, aksi: 'daftar', detail: b.jabatan });
  return json({ ok: true });
}

export async function onRequestPost(ctx) {
  try { return await handle(ctx, await getDb(ctx.env)); } catch (e) { return errorResponse(e); }
}
