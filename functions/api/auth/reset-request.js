// POST /api/auth/reset-request  { nik, kontak? }
// Lupa password: hanya MEMINTA reset. Password baru dibuat Admin Pusat dan disampaikan langsung ke pemilik akun.
// Jawaban selalu sama, apa pun status NIK-nya, agar daftar NIK terdaftar tidak bisa ditebak.
import { getDb } from '../../_lib/db.js';
import { json, errorResponse, readJson, checkOrigin, HttpError } from '../../_lib/http.js';
import { audit, normNik } from '../../_lib/auth.js';

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
export const RESET_MSG = 'Permintaan reset diteruskan ke admin (jika NIK terdaftar). Admin akan menghubungi Anda dan memberikan password sementara.';

export async function handle({ request }, db) {
  checkOrigin(request);
  const b = await readJson(request, 10_000);
  const nik = normNik(b.nik);
  if (!nik) throw new HttpError(400, 'NIK tidak valid.');
  const kontak = clean(b.kontak, 60);
  const ada = await db.query('SELECT 1 FROM users WHERE nik = ? AND aktif = 1 LIMIT 1', [nik]);
  if (ada.length) {
    const sudah = await db.query("SELECT 1 FROM reset_requests WHERE nik = ? AND status = 'PENDING' LIMIT 1", [nik]);
    if (!sudah.length) {
      await db.exec('INSERT INTO reset_requests (nik, kontak) VALUES (?, ?)', [nik, kontak || null]);
      await audit(db, { nik, aksi: 'minta_reset' });
    }
  }
  return json({ ok: true, message: RESET_MSG });
}

export async function onRequestPost(ctx) {
  try { return await handle(ctx, await getDb(ctx.env)); } catch (e) { return errorResponse(e); }
}
