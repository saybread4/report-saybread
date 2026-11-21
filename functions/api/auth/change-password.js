// POST /api/auth/change-password   { old, new }
import { getDb } from '../../_lib/db.js';
import { json, errorResponse, readJson, checkOrigin, HttpError } from '../../_lib/http.js';
import { requireUser, audit } from '../../_lib/auth.js';
import { verifyPassword, hashPassword, checkPasswordPolicy, iterFrom } from '../../_lib/security.js';

export async function handle({ request, env }, db) {
  checkOrigin(request);
  const u = await requireUser(db, request, { allowMustChange: true });   // juga dipakai saat wajib ganti
  const body = await readJson(request, 10_000);
  const oldPw = typeof body.old === 'string' ? body.old : '';
  const newPw = typeof body.new === 'string' ? body.new : '';

  const rows = await db.query('SELECT pw_hash, pw_salt, pw_iter FROM users WHERE nik = ? LIMIT 1', [u.nik]);
  if (!rows.length || !(await verifyPassword(oldPw, rows[0]))) {
    await audit(db, { nik: u.nik, aksi: 'ganti_pw_gagal', detail: 'password lama salah' });
    throw new HttpError(400, 'Password lama salah.', 'BAD_OLD');
  }
  const why = checkPasswordPolicy(newPw, u.nik);
  if (why) throw new HttpError(400, why, 'WEAK');
  if (newPw === oldPw) throw new HttpError(400, 'Password baru harus berbeda dari yang lama.', 'SAME');

  const h = await hashPassword(newPw, undefined, iterFrom(env));
  await db.exec(
    'UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ?, must_change = 0, pw_changed_at = UTC_TIMESTAMP() WHERE nik = ?',
    [h.pw_hash, h.pw_salt, h.pw_iter, u.nik]);
  await db.exec('DELETE FROM sessions WHERE nik = ? AND token_hash <> ?', [u.nik, u.tokenHash]);   // sesi lain keluar
  await audit(db, { nik: u.nik, aksi: 'ganti_pw' });
  return json({ ok: true });
}

export async function onRequestPost(ctx) {
  try { return await handle(ctx, await getDb(ctx.env)); } catch (e) { return errorResponse(e); }
}
