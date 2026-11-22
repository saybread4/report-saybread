// POST /api/auth/login   { nik, password }
import { getDb } from '../../_lib/db.js';
import { json, errorResponse, readJson, checkOrigin, HttpError, setSessionCookie } from '../../_lib/http.js';
import { verifyPassword, DUMMY } from '../../_lib/security.js';
import { startSession, audit, publicUser, normNik, SESSION_HOURS, REMEMBER_HOURS, MAX_FAILED, LOCK_MINUTES } from '../../_lib/auth.js';

export async function handle({ request }, db) {
  checkOrigin(request);
  const body = await readJson(request, 10_000);
  const nik = normNik(body.nik);
  const pw = typeof body.password === 'string' ? body.password : '';
  if (!nik || !pw || pw.length > 128) throw new HttpError(400, 'Isi NIK dan password.');

  const rows = await db.query(
    `SELECT nik, nama, jabatan, bam_scope, aktif, must_change, pw_hash, pw_salt, pw_iter, failed_count,
            (locked_until IS NOT NULL AND locked_until > UTC_TIMESTAMP()) AS is_locked
       FROM users WHERE nik = ? LIMIT 1`, [nik]);
  const u = rows[0];
  const bad = () => new HttpError(401, 'NIK atau password salah.', 'BAD_LOGIN');   // pesan sama untuk semua kegagalan

  if (!u) {
    // Belum jadi pengguna: mungkin pendaftarannya masih menunggu / ditolak. Pesan khusus hanya diberikan
    // bila password cocok dengan yang didaftarkan, supaya status NIK orang lain tidak bisa diintip.
    let reg = null;
    try {
      reg = (await db.query('SELECT status, catatan, pw_hash, pw_salt, pw_iter FROM registrations WHERE nik = ? ORDER BY id DESC LIMIT 1', [nik]))[0] || null;
    } catch (e) { console.error('registrations belum ada?', e); }       // tabel belum dimigrasi: perlakukan seperti NIK tak dikenal
    if (reg && reg.status !== 'APPROVED') {
      if (await verifyPassword(pw, reg)) {
        await audit(db, { nik, aksi: 'login_ditolak', detail: 'pendaftaran ' + reg.status });
        if (reg.status === 'PENDING')
          throw new HttpError(403, 'Pendaftaran Anda masih menunggu verifikasi admin. Anda bisa masuk setelah disetujui.', 'PENDING');
        throw new HttpError(403, 'Pendaftaran Anda ditolak' + (reg.catatan ? ': ' + reg.catatan : '.') + ' Silakan hubungi admin.', 'REJECTED');
      }
    } else {
      await verifyPassword(pw, DUMMY);                     // samakan waktu respons
    }
    await audit(db, { nik, aksi: 'login_gagal', detail: 'nik tidak terdaftar' });
    throw bad();
  }
  if (Number(u.is_locked) === 1) {
    await audit(db, { nik, aksi: 'login_ditolak', detail: 'akun terkunci' });
    throw new HttpError(429, `Akun terkunci sementara karena terlalu banyak percobaan. Coba lagi dalam ${LOCK_MINUTES} menit.`, 'LOCKED');
  }

  const ok = await verifyPassword(pw, u);
  if (!ok) {
    const n = Number(u.failed_count || 0) + 1;
    if (n >= MAX_FAILED) {
      await db.exec('UPDATE users SET failed_count = 0, locked_until = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE) WHERE nik = ?', [LOCK_MINUTES, nik]);
      await audit(db, { nik, aksi: 'akun_terkunci', detail: `${MAX_FAILED}x salah password` });
    } else {
      await db.exec('UPDATE users SET failed_count = ? WHERE nik = ?', [n, nik]);
      await audit(db, { nik, aksi: 'login_gagal', detail: 'password salah' });
    }
    throw bad();
  }
  if (Number(u.aktif) !== 1) {
    await audit(db, { nik, aksi: 'login_ditolak', detail: 'akun nonaktif' });
    throw bad();
  }

  await db.exec('UPDATE users SET failed_count = 0, locked_until = NULL, last_login = UTC_TIMESTAMP() WHERE nik = ?', [nik]);
  await db.exec('DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()');
  const remember = body.remember === true;                  // "Ingat saya": sesi 30 hari, cookie menetap
  const hours = remember ? REMEMBER_HOURS : SESSION_HOURS;
  const token = await startSession(db, nik, hours);
  await audit(db, { nik, aksi: 'login_ok', detail: remember ? 'ingat saya' : null });
  return json({ ok: true, user: publicUser(u) }, 200, { 'Set-Cookie': setSessionCookie(token, remember ? hours * 3600 : null) });
}

export async function onRequestPost(ctx) {
  try { return await handle(ctx, await getDb(ctx.env)); } catch (e) { return errorResponse(e); }
}
