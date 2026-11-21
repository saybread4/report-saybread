// POST /api/rpc/<nama>   body: { a: [...argumen lama...] }
// Pengganti /rest/v1/rpc/api_<nama> di Supabase. Posisi argumen TIDAK berubah;
// argumen token lama (a[0] pada fungsi admin) diabaikan karena identitas diambil dari cookie sesi.
import { getDb } from '../../_lib/db.js';
import { json, errorResponse, readJson, checkOrigin, HttpError } from '../../_lib/http.js';
import { requireUser, can } from '../../_lib/auth.js';
import { handlers } from '../../_lib/handlers/index.js';

export async function handle({ request, env, params }, db) {
  checkOrigin(request);
  const user = await requireUser(db, request);
  const raw = Array.isArray(params.fn) ? params.fn[0] : params.fn;
  const fn = String(raw || '').toLowerCase().replace(/^api_/, '');
  const h = Object.prototype.hasOwnProperty.call(handlers, fn) ? handlers[fn] : null;
  if (!h) throw new HttpError(404, `Fungsi '${fn}' belum tersedia.`, 'NOT_FOUND');
  if (!can(user, h.need || 'view')) throw new HttpError(403, 'Anda tidak punya akses untuk ini.', 'FORBIDDEN');
  const body = await readJson(request);
  const a = Array.isArray(body.a) ? body.a : [];
  const result = await h.run({ db, user, env }, a);
  return json(result === undefined ? null : result);
}

export async function onRequestPost(ctx) {
  try { return await handle(ctx, await getDb(ctx.env)); } catch (e) { return errorResponse(e); }
}
