// GET /api/auth/me  -> data pengguna yang sedang masuk (dipakai browser saat halaman dibuka)
import { getDb } from '../../_lib/db.js';
import { json, errorResponse } from '../../_lib/http.js';
import { requireUser, publicUser } from '../../_lib/auth.js';

export async function handle({ request }, db) {
  const u = await requireUser(db, request, { allowMustChange: true });
  return json({ user: publicUser(u) });
}

export async function onRequestGet(ctx) {
  try { return await handle(ctx, await getDb(ctx.env)); } catch (e) { return errorResponse(e); }
}
