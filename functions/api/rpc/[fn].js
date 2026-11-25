// POST /api/rpc/<nama>   body: { a: [...argumen lama...] }
// Pengganti /rest/v1/rpc/api_<nama> di Supabase. Posisi argumen TIDAK berubah;
// argumen token lama (a[0] pada fungsi admin) diabaikan karena identitas diambil dari cookie sesi.
import { getDb } from '../../_lib/db.js';
import { json, errorResponse, readJson, checkOrigin, HttpError } from '../../_lib/http.js';
import { requireUser, can } from '../../_lib/auth.js';
import { handlers } from '../../_lib/handlers/index.js';
import { cacheable, dataVersion, cacheKey, cacheGet, cachePut, BIG_FNS, bigGet, bigPut } from '../../_lib/readcache.js';
import { RawJson } from '../../_lib/util.js';

export async function handle(ctx, db) {
  const { request, env, params } = ctx;
  const waitUntil = typeof ctx.waitUntil === 'function' ? (p) => ctx.waitUntil(p) : null;   // tidak boleh dipanggil lepas dari ctx (Illegal invocation)
  checkOrigin(request);
  const user = await requireUser(db, request);
  const raw = Array.isArray(params.fn) ? params.fn[0] : params.fn;
  const fn = String(raw || '').toLowerCase().replace(/^api_/, '');
  const h = Object.prototype.hasOwnProperty.call(handlers, fn) ? handlers[fn] : null;
  if (!h) throw new HttpError(404, `Fungsi '${fn}' belum tersedia.`, 'NOT_FOUND');
  // Fungsi khusus Admin Utama dibuat tampak "tidak ada" bagi jabatan lain (tidak membocorkan keberadaannya).
  if (h.need === 'utama' && !can(user, 'utama')) throw new HttpError(404, `Fungsi '${fn}' belum tersedia.`, 'NOT_FOUND');
  if (!can(user, h.need || 'view')) throw new HttpError(403, 'Anda tidak punya akses untuk ini.', 'FORBIDDEN');
  const body = await readJson(request);
  const a = Array.isArray(body.a) ? body.a : [];
  // Fungsi baca: pakai hasil tersimpan bila data belum berubah (hemat RU TiDB). Hasil dibatasi area pengguna lewat kunci cache.
  let ckey = null, origin = '';
  if (cacheable(fn) && h.need === 'view') {
    try {
      const ver = await dataVersion(db);
      if (ver) {
        origin = new URL(request.url).origin;
        ckey = await cacheKey(fn, a, user, ver);
        const hit = await cacheGet(origin, ckey);
        if (hit != null) return new Response(hit, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Cache': 'HIT' } });
        if (BIG_FNS.has(fn)) {   // hasil besar: cache di TiDB (satu query), jauh lebih murah daripada menghitung ulang
          const big = await bigGet(db, ckey);
          if (big != null) return new Response(big, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Cache': 'HIT-DB' } });
        }
      }
    } catch (e) { ckey = null; }   // cache tidak boleh menggagalkan permintaan
  }
  let result;
  try { result = await h.run({ db, user, env }, a); }
  catch (e) {
    if (e instanceof HttpError || !can(user, 'pusat')) throw e;
    console.error(`rpc ${fn} gagal`, e);
    // Hanya Admin Utama / Administrator: tampilkan penyebab asli supaya mudah dicari (pengguna lain tetap melihat pesan umum).
    throw new HttpError(500, `Fungsi ${fn} gagal: ${String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  const out = result === undefined ? null : result;
  if (out instanceof RawJson && !ckey) return new Response(out.json, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  if (ckey) {
    const text = out instanceof RawJson ? out.json : JSON.stringify(out);
    await cachePut(origin, ckey, text, waitUntil);
    if (BIG_FNS.has(fn) && text.length > 1_000_000) {
      const p = bigPut(db, ckey, text);
      if (waitUntil) waitUntil(p); else await p;
    }
    return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Cache': 'MISS' } });
  }
  return json(out);
}

export async function onRequestPost(ctx) {
  try { return await handle(ctx, await getDb(ctx.env)); } catch (e) { return errorResponse(e); }
}
