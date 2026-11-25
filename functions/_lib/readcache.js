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
const CACHE_REV = '7';
const MEM = new Map();            // kunci -> teks JSON (urutan masuk = urutan paling lama dulu)
let memBytes = 0;
const MEM_MAX_BYTES = 8 * 1024 * 1024;     // kecil dengan sengaja: batas memori Worker 128 MB dipakai bersama semua permintaan
const MEM_MAX_ONE = 1536 * 1024;

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

// ---- Lapis 3: cache besar di TiDB ---------------------------------------------------------------------------------------------------
// Hasil yang terlalu besar untuk memori Worker (getrows ~8 MB) tidak pernah masuk lapis 1, dan Cloudflare Cache API tidak selalu aktif
// (mis. di *.pages.dev). Tanpa lapis ini, SETIAP pembukaan halaman Stock menghitung ulang ratusan ribu baris -> HTTP 503.
// Disimpan terpotong-potong di tabel read_cache (dibuat otomatis, tanpa migrasi). Kunci sudah memuat versi data + area pengguna,
// jadi hasil lama tidak pernah dipakai setelah data berubah. Gagal baca/tulis TIDAK boleh menggagalkan permintaan.
export const BIG_FNS = new Set(['getrows']);
const BIG_DDL = 'CREATE TABLE IF NOT EXISTS read_cache (k VARCHAR(64) NOT NULL, part INT NOT NULL, n INT NOT NULL, body MEDIUMTEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (k, part))';
const BIG_PART = 300000;     // karakter per baris tabel
const BIG_PER_INSERT = 3;    // baris per INSERT (+- 1 MB), supaya jumlah subrequest tetap kecil

export async function bigGet(db, key) {
  try {
    const r = await db.query('SELECT part, n, body FROM read_cache WHERE k = ? ORDER BY part', [key]);
    if (!r.length) return null;
    const n = Number(r[0].n);
    if (r.length !== n || r.some((x, i) => Number(x.part) !== i)) return null;   // tulis terputus: anggap tidak ada
    return r.map((x) => String(x.body)).join('');
  } catch (e) { return null; }
}

export async function bigPut(db, key, text) {
  try {
    await db.exec(BIG_DDL);
    const parts = [];
    for (let i = 0; i < text.length; i += BIG_PART) parts.push(text.slice(i, i + BIG_PART));
    await db.exec('DELETE FROM read_cache WHERE k = ? OR created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY)', [key]);
    for (let i = 0; i < parts.length; i += BIG_PER_INSERT) {
      const grp = parts.slice(i, i + BIG_PER_INSERT);
      await db.exec(`INSERT INTO read_cache (k, part, n, body) VALUES ${grp.map(() => '(?, ?, ?, ?)').join(', ')}`,
        grp.flatMap((b, j) => [key, i + j, parts.length, b]));
    }
  } catch (e) { console.error('read_cache gagal ditulis', e && e.message); }
}
