// GET /api/auth/area-options   (tanpa login, dipakai form Daftar)
// Hanya daftar NAMA pilihan [KOORBAM, BAM, CABANG] dari tabel toko untuk dropdown; tidak ada angka/data penjualan.
import { getDb } from '../../_lib/db.js';
import { json, errorResponse } from '../../_lib/http.js';
import { loadHierarchy } from '../../_lib/area.js';

export async function handle(ctx, db) {
  const h = await loadHierarchy(db);
  return json({ h: h.map((r) => [r.k, r.b, r.c]) }, 200, { 'Cache-Control': 'public, max-age=300' });
}

export async function onRequestGet(ctx) {
  try { return await handle(ctx, await getDb(ctx.env)); } catch (e) { return errorResponse(e); }
}
