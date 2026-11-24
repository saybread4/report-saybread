// Pembantu untuk fungsi baca: pembatasan area lewat daftar toko, format tanggal, pembulatan.
import { isPusat } from './auth.js';
import { norm, num } from './util.js';
import { bamWhere } from './scope.js';

// Driver TiDB memotong SETIAP hasil SELECT di 10.000 baris tanpa pesan galat (terbukti dari data: Perform Cabang berhenti tepat di baris ke-10.000).
// queryAll membaca per halaman 9.000 baris; sql TIDAK boleh sudah punya ORDER BY / LIMIT, dan `order` harus urutan yang tetap (kolom unik / hampir unik).
export const PAGE = 9000;
export async function queryAll(db, sql, params = [], order) {
  const out = [];
  for (let off = 0; ; off += PAGE) {
    const rows = await db.query(`${sql} ORDER BY ${order} LIMIT ${PAGE} OFFSET ${off}`, params);
    for (const r of rows) out.push(r);
    if (rows.length < PAGE) break;
  }
  return out;
}

export const arr = (x) => (Array.isArray(x) ? x : []);
export const str = (x) => (x == null ? '' : String(x));
export const byText = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

// DATE dari driver bisa berupa string 'YYYY-MM-DD' atau objek Date.
export const ymd = (v) => {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

// Setara norm() Postgres, untuk dipakai di dalam SQL TiDB.
export const NORM = (col) => `UPPER(REGEXP_REPLACE(COALESCE(${col}, ''), '[^A-Za-z0-9]', ''))`;

export const inList = (col, vals) =>
  vals.length ? { sql: `${col} IN (${vals.map(() => '?').join(',')})`, params: [...vals] } : { sql: '1=0', params: [] };

// Pembulatan seperti round() Postgres (setengah menjauhi nol).
export const rnd = (x, d = 0) => {
  const v = Number(x) || 0, f = 10 ** d;
  return (Math.sign(v) * Math.round(Math.abs(v) * f)) / f;
};

export const chunks = (a, n = 2000) => {
  const out = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};

// null = semua toko (Admin Pusat); selain itu Set norm(kode) toko di area pengguna.
export async function allowedNorm(db, user) {
  if (isPusat(user)) return null;
  const w = bamWhere(user, 'bam');
  const rows = await queryAll(db, `SELECT kode FROM toko WHERE ${w.sql}`, w.params, 'kode');
  return new Set(rows.map((r) => norm(r.kode)).filter(Boolean));
}

// Daftar toko ringkasan (mv_ks) yang boleh dilihat, urut ki.
export async function scopedKs(db, user) {
  const [rows, ok] = await Promise.all([
    queryAll(db, 'SELECT ki, kode, toko, cabang, cabpnl FROM mv_ks', [], 'ki'),
    allowedNorm(db, user),
  ]);
  const all = rows.map((r) => ({ ki: num(r.ki), kode: str(r.kode), toko: str(r.toko), cabang: str(r.cabang), cabpnl: str(r.cabpnl) }));
  return ok === null ? all : all.filter((r) => ok.has(norm(r.kode)));
}

// Daftar tanggal ringkasan: { list: ['YYYY-MM-DD'...] urut, di: Map tanggal -> indeks }
export async function datesInfo(db) {
  const rows = await db.query('SELECT tanggal, di FROM mv_dates ORDER BY tanggal');
  const list = [], di = new Map();
  for (const r of rows) { const d = ymd(r.tanggal); list.push(d); di.set(d, num(r.di)); }
  return { list, di };
}

// Baris harian (mv_tgl) untuk sekumpulan kode toko. opts.from / opts.to = batas tanggal (opsional).
export async function tglRows(db, kodes, opts = {}) {
  const cols = opts.cols || 'kode, tanggal, stock_qty, prod, qty, rp, mg, baq, barp';
  const out = [];
  for (const part of chunks(kodes)) {
    const w = inList('kode', part);
    let sql = `SELECT ${cols} FROM mv_tgl WHERE ${w.sql}`;
    const params = [...w.params];
    if (opts.from) { sql += ' AND tanggal >= ?'; params.push(opts.from); }
    if (opts.to) { sql += ' AND tanggal <= ?'; params.push(opts.to); }
    for (const r of await queryAll(db, sql, params, 'kode, tanggal')) out.push(r);
  }
  return out;
}

export async function overrides(db, table) {
  const rows = await db.query(`SELECT \`key\` AS k, val FROM ${table}`);
  const o = {};
  for (const r of rows) o[r.k] = num(r.val);
  return o;
}

// Peta nama toko -> bas (dll.) dari tabel toko, kunci norm(kode).
export async function tokoMap(db) {
  const rows = await queryAll(db, 'SELECT kode, toko, bam, bas, bastr, am, `as` AS as_ FROM toko', [], 'kode, toko');
  const m = new Map();
  for (const r of rows) { const k = norm(r.kode); if (k && !m.has(k)) m.set(k, r); }
  return m;
}
