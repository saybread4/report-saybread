// Cache hasil fungsi baca (get*) di server, supaya membuka Rank/Perform/Monitor berulang kali TIDAK menjalankan query berat lagi
// (tiap query berat = ribuan RU di TiDB Cloud). Data hanya berubah saat ada unggahan/hapus/refresh, jadi hasil aman dipakai ulang
// selama "versi data" sama.
//
//  - Versi data = MAX(updated_at) dari data_updates (satu query kecil). Setiap impor, hapus, refresh, ubah Gempar/override
//    mencatat waktu di tabel itu -> versi berubah -> cache lama otomatis tidak terpakai.
//  - Kunci cache = fungsi + argumen + jabatan + area pengguna + versi + jendela 6 jam (batas atas bila ada yang mengubah data langsung lewat SQL).
//    Area pengguna ikut kunci, jadi hasil yang dibatasi area tidak pernah bocor ke pengguna lain.
//  - Lapis 1: memori isolate Worker (cepat, hilang bila isolate didaur ulang). Lapis 2: Cloudflare Cache API (bila tersedia di situs ini).
//    Bila keduanya tidak tersedia, semuanya tetap jalan seperti biasa (hanya tanpa penghematan). Header X-Cache: HIT/MISS menunjukkan hasilnya.
import { sha256Hex } from './security.js';
import { isPusat } from './auth.js';

const TTL_BUCKET_MS = 6 * 3600 * 1000;
// Naikkan angka ini setiap kali BENTUK keluaran fungsi get* berubah (mis. menambah grup Rank BAM), supaya hasil lama di cache tidak dipakai.
const CACHE_REV = '4';
const MEM = new Map();            // kunci -> teks JSON (urutan masuk = urutan paling lama dulu)
let memBytes = 0;
const MEM_MAX_BYTES = 24 * 1024 * 1024;
const MEM_MAX_ONE = 6 * 1024 * 1024;

export const cacheable = (fn) => /^get/.test(fn);

export async function dataVersion(db) {
  try {
    const r = await db.query('SELECT MAX(updated_at) AS u, COUNT(*) AS n FROM data_updates');
    const x = r[0];
    if (!x || x.u == null) return null;          // tabel kosong/tidak ada: jangan cache (tidak bisa tahu kapan data berubah)
    return `${x.u instanceof Date ? x.u.toISOString() : String(x.u)}#${x.n}`;
  } catch (e) { return null; }
}

export async function cacheKey(fn, a, user, version) {
  const scope = isPusat(user) ? 'ALL' : [user.jabatan, ...(user.bam_scope || [])].join('|');
  return sha256Hex(JSON.stringify([CACHE_REV, fn, a, scope, version, Math.floor(Date.now() / TTL_BUCKET_MS)]));
}

function memPut(key, text) {
  if (text.length > MEM_MAX_ONE) return;
  if (MEM.has(key)) { memBytes -= MEM.get(key).length; MEM.delete(key); }
  MEM.set(key, text); memBytes += text.length;
  while (memBytes > MEM_MAX_BYTES && MEM.size) { const k = MEM.keys().next().value; memBytes -= MEM.get(k).length; MEM.delete(k); }
}

const edgeReq = (origin, key) => new Request(`${origin}/__rpc_cache/${key}`);
const edge = () => { try { return typeof caches !== 'undefined' && caches.default ? caches.default : null; } catch (e) { return null; } };

export async function cacheGet(origin, key) {
  if (MEM.has(key)) return MEM.get(key);
  try {
    const c = edge();
    if (c) {
      const res = await c.match(edgeReq(origin, key));
      if (res) { const t = await res.text(); memPut(key, t); return t; }
    }
  } catch (e) { /* cache tidak tersedia: lanjut tanpa cache */ }
  return null;
}

export async function cachePut(origin, key, text, waitUntil) {
  memPut(key, text);
  try {
    const c = edge();
    if (!c) return;
    const p = c.put(edgeReq(origin, key), new Response(text, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=21600' } }));
    if (typeof waitUntil === 'function') waitUntil(p.catch(() => {})); else await p.catch(() => {});
  } catch (e) { /* abaikan */ }
}

export const _clearForTest = () => { MEM.clear(); memBytes = 0; };
