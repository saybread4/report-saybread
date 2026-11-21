// POST /api/auth/logout
import { getDb } from '../../_lib/db.js';
import { json, errorResponse, checkOrigin, getCookie, SESSION_COOKIE, clearSessionCookie } from '../../_lib/http.js';
import { sha256Hex } from '../../_lib/security.js';

export async function handle({ request }, db) {
  checkOrigin(request);
  const token = getCookie(request, SESSION_COOKIE);
  if (token && /^[0-9a-f]{64}$/.test(token)) {
    await db.exec('DELETE FROM sessions WHERE token_hash = ?', [await sha256Hex(token)]);
  }
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}

export async function onRequestPost(ctx) {
  try { return await handle(ctx, await getDb(ctx.env)); } catch (e) { return errorResponse(e); }
}
