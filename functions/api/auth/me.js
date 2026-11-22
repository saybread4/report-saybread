// GET /api/auth/me  -> data pengguna yang sedang masuk (dipakai browser saat halaman dibuka)
import { getDb } from '../../_lib/db.js';
import { json, errorResponse } from '../../_lib/http.js';
import { requireUser, publicUser, isPusat } from '../../_lib/auth.js';

// Jumlah permintaan yang menunggu Admin Pusat. Gagal (mis. tabel belum dimigrasi) tidak boleh mengganggu login.
async function pendingCounts(db) {
  try {
    const r = await db.query(
      "SELECT (SELECT COUNT(*) FROM registrations WHERE status = 'PENDING') AS reg, (SELECT COUNT(*) FROM reset_requests WHERE status = 'PENDING') AS rst");
    return { reg: Number(r[0].reg) || 0, rst: Number(r[0].rst) || 0 };
  } catch (e) {
    console.error('hitung permintaan gagal', e);
    return { reg: 0, rst: 0, error: true };
  }
}

export async function handle({ request }, db) {
  const u = await requireUser(db, request, { allowMustChange: true });
  const out = { user: publicUser(u) };
  if (isPusat(u) && !u.must_change) out.pending = await pendingCounts(db);
  return json(out);
}

export async function onRequestGet(ctx) {
  try { return await handle(ctx, await getDb(ctx.env)); } catch (e) { return errorResponse(e); }
}
