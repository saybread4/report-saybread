// Fungsi admin data yang dipindah dari Supabase (api_admin*, Gempar, override budged/rank).
// Posisi argumen SAMA dengan fungsi lama; a[0] (token lama) diabaikan karena identitas dari cookie sesi.
//
// Perbedaan dari versi Postgres:
//  * Pembatasan area memakai jabatan baru: Admin Pusat = semua; Admin Koorbam = hanya BAM di areanya.
//  * Trigger trg_fix_kode diganti fixKode() di sini (saat impor/ubah).
//  * Tanpa transaksi: kalau impor berhenti di tengah, jalankan ulang (upsert aman diulang; lihat catatan di bawah).
//  * Jumlah baru/diubah dihitung lewat query hitung, bukan dari "rows affected" (hasilnya berbeda di MySQL/TiDB).
import { HttpError } from '../http.js';
import { isPusat } from '../auth.js';
import { bamWhere, kodeWhere } from '../scope.js';
import { fixKode, norm } from '../util.js';
import { ymd, chunks } from '../ks.js';
import { touchUpdated } from '../dataupdates.js';

const q = (c) => '`' + c + '`';          // hanya dipakai untuk nama tabel/kolom dari daftar putih di bawah
const ph = (n) => Array(n).fill('?').join(',');
const bad = (msg, code) => new HttpError(400, msg, code);

// ---- Konfigurasi tabel (setara admin_tcfg) ------------------------------------------------------
const T = {
  toko: { cols: ['kode', 'toko', 'cab_pnl', 'cabang', 'bam', 'bas', 'bastr', 'am', 'as', 'wilayah', 'kriteria', 'domain'],
    nk: ['kode'], uq: true, pk: ['kode'], kcol: 'kode' },
  stock: { cols: ['tanggal', 'kode', 'toko', 'plu', 'deskripsi', 'jenis', 'stock_qty'],
    nk: ['tanggal', 'kode', 'plu'], uq: true, pk: ['id'], dcol: 'tanggal', kcol: 'kode', zero: ['stock_qty'],
    date: ['tanggal'], num: ['stock_qty'] },
  stock_toko: { cols: ['tanggal', 'kode', 'jenis', 'stock_total'],
    nk: ['tanggal', 'kode', 'jenis'], uq: false, pk: ['id'], dcol: 'tanggal', kcol: 'kode', zero: ['stock_total'],
    date: ['tanggal'], num: ['stock_total'] },
  sales_toko: { cols: ['tanggal', 'kode', 'produksi', 'sales_qty', 'sales_rp', 'margin', 'ba_qty', 'ba_rp'],
    nk: ['tanggal', 'kode'], uq: true, pk: ['tanggal', 'kode'], dcol: 'tanggal', kcol: 'kode',
    zero: ['produksi', 'sales_qty', 'sales_rp', 'margin', 'ba_qty', 'ba_rp'],
    date: ['tanggal'], num: ['produksi', 'sales_qty', 'sales_rp', 'margin', 'ba_qty', 'ba_rp'] },
  sales_item: { cols: ['ket', 'tahun', 'bulan', 'kode', 'deskripsi', 'produksi', 'sales_qty', 'margin', 'sales_rp', 'ba_qty', 'ba_rp'],
    nk: ['ket', 'tahun', 'bulan', 'kode', 'deskripsi'], uq: true, pk: ['ket', 'tahun', 'bulan', 'kode', 'deskripsi'],
    ym: true, kcol: 'kode', ket: true, zero: ['produksi', 'sales_qty', 'margin', 'sales_rp', 'ba_qty', 'ba_rp'],
    num: ['tahun', 'bulan', 'produksi', 'sales_qty', 'margin', 'sales_rp', 'ba_qty', 'ba_rp'] },
  modis: { cols: ['kode', 'toko', 'modis', 'kirim', 'plu', 'plu_jual', 'deskripsi'],
    nk: ['kode', 'modis', 'plu'], uq: true, pk: ['id'], kcol: 'kode' },
  item: { cols: ['plu', 'plu_jual', 'deskripsi', 'kirim'], nk: ['plu'], uq: true, pk: ['plu'] },
  budged: { cols: ['cab_pnl', 'cabang', 'bam', 'bulan', 'tahun', 'budged'],
    nk: ['cab_pnl', 'cabang', 'bulan', 'tahun'], uq: false, pk: ['id'], ym: true, zero: ['budged'],
    num: ['bulan', 'tahun', 'budged'] },
  trend: { cols: ['tahun', 'bulan', 'cab_pnl', 'cabang', 'kode', 'toko', 'jml_hari', 'produksi', 'sales_qty', 'sales_rp', 'qpd', 'spd', 'margin', 'ba_qty', 'ba_rp'],
    nk: ['tahun', 'bulan', 'kode'], uq: false, pk: ['id'], ym: true, kcol: 'kode',
    zero: ['jml_hari', 'produksi', 'sales_qty', 'sales_rp', 'qpd', 'spd', 'margin', 'ba_qty', 'ba_rp'],
    num: ['tahun', 'bulan', 'jml_hari', 'produksi', 'sales_qty', 'sales_rp', 'qpd', 'spd', 'margin', 'ba_qty', 'ba_rp'] },
};
const INFO_TABLES = ['toko', 'stock', 'stock_toko', 'sales_toko', 'sales_item', 'modis', 'item', 'budged', 'trend'];

function getCfg(name) {
  const t = String(name == null ? '' : name).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(T, t)) throw bad('Tabel tidak dikenal.');
  return { t, cfg: T[t] };
}
const typeOf = (cfg, col) => (col === 'id' || (cfg.num || []).includes(col) ? 'n' : (cfg.date || []).includes(col) ? 'd' : 's');

// ---- Pembatasan area (setara admin_scope_pred) --------------------------------------------------
const SCOPE_BAM = new Set(['toko', 'budged']);
const SCOPE_KODE = new Set(['stock', 'stock_toko', 'sales_toko', 'sales_item', 'modis', 'trend']);

// Admin Pusat -> null (tanpa pembatasan). Admin Koorbam -> {sql, params}. Tabel item -> ditolak.
function scopePred(user, table, alias = '') {
  if (isPusat(user)) return null;
  const p = alias ? alias + '.' : '';
  if (SCOPE_BAM.has(table)) return bamWhere(user, p + 'bam');
  if (SCOPE_KODE.has(table)) return kodeWhere(user, p + 'kode');
  throw new HttpError(403, 'Tabel ini khusus administrator utama.', 'FORBIDDEN');
}

// ---- Nilai & filter -----------------------------------------------------------------------------
const has = (v) => v != null && String(v) !== '';

function dateStr(v, msg = 'Tanggal tidak valid.') {
  const s = String(v == null ? '' : v).trim().slice(0, 10);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00Z') : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw bad(msg);
  return s;
}

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
function numVal(v, msg) {
  const n = typeof v === 'number' ? v : NUM_RE.test(String(v).trim()) ? Number(String(v).trim()) : NaN;
  if (!Number.isFinite(n)) throw bad(msg);
  return n;
}

// Nilai satu sel sesuai tipe kolomnya. Kosong -> null.
function coerce(cfg, col, v, label) {
  if (v === undefined || v === null) return null;
  const t = typeOf(cfg, col);
  if (t === 'n') return String(v).trim() === '' ? null : numVal(v, `${label}kolom ${col} bukan angka yang valid.`);
  if (t === 'd') return String(v).trim() === '' ? null : dateStr(v, `${label}kolom ${col} bukan tanggal yang valid.`);
  return String(v);
}

const kodesOf = (s) => String(s == null ? '' : s).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);

// Setara admin_where: filter rentang tanggal/bulan, kode, dan ket.
function filterWhere(cfg, d1, d2, kodes, ket) {
  const w = [], p = [];
  if (cfg.dcol) {
    if (has(d1)) { w.push(`${q(cfg.dcol)} >= ?`); p.push(dateStr(d1)); }
    if (has(d2)) { w.push(`${q(cfg.dcol)} <= ?`); p.push(dateStr(d2)); }
  } else if (cfg.ym) {
    if (has(d1)) { w.push('(tahun*100+bulan) >= ?'); p.push(numVal(d1, 'Bulan awal tidak valid.')); }
    if (has(d2)) { w.push('(tahun*100+bulan) <= ?'); p.push(numVal(d2, 'Bulan akhir tidak valid.')); }
  }
  if (kodes.length && cfg.kcol) { w.push(`UPPER(TRIM(${q(cfg.kcol)})) IN (${ph(kodes.length)})`); p.push(...kodes); }
  if (has(ket) && cfg.ket) { w.push('`ket` = ?'); p.push(String(ket)); }
  return { w, p };
}

// Gabungkan filter + pembatasan area menjadi 'WHERE ...' (atau '').
function buildWhere(user, t, cfg, a, alias = '') {
  const f = filterWhere(cfg, a[2], a[3], kodesOf(a[4]), a[5]);
  const sc = scopePred(user, t, alias);
  const w = [...f.w], p = [...f.p];
  if (sc) { w.push(sc.sql); p.push(...sc.params); }
  return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p, filtered: f.w.length > 0 };
}

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

// ---- Daftar, hitung, info -----------------------------------------------------------------------
function outRow(cfg, row, cols) {
  const o = {};
  for (const c of cols) {
    const v = row[c];
    const t = typeOf(cfg, c);
    o[c] = v == null ? null : t === 'n' ? Number(v) : t === 'd' ? ymd(v) : v;
  }
  return o;
}

async function adminList(db, user, a) {
  const { t, cfg } = getCfg(a[1]);
  const wh = buildWhere(user, t, cfg, a);
  const lim = clamp(Math.trunc(Number(a[6])) || 50, 1, 200);
  const off = Math.max(Math.trunc(Number(a[7])) || 0, 0);
  const cols = (cfg.pk.length === 1 && cfg.pk[0] === 'id' ? ['id'] : []).concat(cfg.cols);
  const ord = (cfg.dcol ? `${q(cfg.dcol)} DESC, ` : cfg.ym ? '`tahun` DESC, `bulan` DESC, ' : '') + cfg.pk.map(q).join(', ');
  const total = await db.query(`SELECT COUNT(*) AS n FROM ${q(t)} ${wh.sql}`, wh.params);
  const rows = await db.query(
    `SELECT ${cols.map(q).join(', ')} FROM ${q(t)} ${wh.sql} ORDER BY ${ord} LIMIT ${lim} OFFSET ${off}`, wh.params);
  return { total: Number(total[0].n) || 0, rows: rows.map((r) => outRow(cfg, r, cols)) };
}

async function adminCount(db, user, a) {
  const { t, cfg } = getCfg(a[1]);
  const wh = buildWhere(user, t, cfg, a);
  const r = await db.query(`SELECT COUNT(*) AS n FROM ${q(t)} ${wh.sql}`, wh.params);
  return { n: Number(r[0].n) || 0, filter: wh.filtered };
}

async function adminInfo(db, user) {
  const list = INFO_TABLES.filter((t) => isPusat(user) || t !== 'item');
  const parts = await Promise.all(list.map(async (t) => {
    const cfg = T[t];
    const sc = scopePred(user, t);
    const wh = sc ? `WHERE ${sc.sql}` : '';
    const args = sc ? sc.params : [];
    if (cfg.dcol) {
      const c = q(cfg.dcol);
      const r = (await db.query(`SELECT COUNT(*) AS n, DATE_FORMAT(MIN(${c}), '%Y-%m-%d') AS mn, DATE_FORMAT(MAX(${c}), '%Y-%m-%d') AS mx FROM ${q(t)} ${wh}`, args))[0];
      return [t, { n: Number(r.n) || 0, min: r.mn == null ? null : String(r.mn), max: r.mx == null ? null : String(r.mx) }];
    }
    if (cfg.ym) {
      const r = (await db.query(`SELECT COUNT(*) AS n, CAST(MIN(tahun*100+bulan) AS CHAR) AS mn, CAST(MAX(tahun*100+bulan) AS CHAR) AS mx FROM ${q(t)} ${wh}`, args))[0];
      return [t, { n: Number(r.n) || 0, min: r.mn == null ? null : String(r.mn), max: r.mx == null ? null : String(r.mx) }];
    }
    const r = (await db.query(`SELECT COUNT(*) AS n FROM ${q(t)} ${wh}`, args))[0];
    return [t, { n: Number(r.n) || 0, min: null, max: null }];
  }));
  return Object.fromEntries(parts);
}

// ---- Hapus --------------------------------------------------------------------------------------
async function adminDelete(db, user, a) {
  const { t, cfg } = getCfg(a[1]);
  const mx = clamp(Math.trunc(Number(a[6])) || 5000, 1, 20000);
  const wh = buildWhere(user, t, cfg, a);
  if (!wh.filtered && !(a[7] === true || a[7] === 'true'))
    throw bad('Tentukan rentang atau kode, atau pilih hapus seluruh isi tabel.');
  // hitung dulu (maksimal mx), baru hapus mx baris — jumlah terhapus tidak diambil dari "rows affected"
  const c = await db.query(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${q(t)} ${wh.sql} LIMIT ${mx}) x`, wh.params);
  const n = Number(c[0].n) || 0;
  if (n > 0) { await db.exec(`DELETE FROM ${q(t)} ${wh.sql} LIMIT ${mx}`, wh.params); await touchUpdated(db, t); }
  return { terhapus: n, lagi: n >= mx };
}

function rowKey(cfg, k) {
  if (k === null || typeof k !== 'object' || Array.isArray(k)) throw bad('Data tidak valid.');
  if (!cfg.pk.every((p) => k[p] !== undefined && k[p] !== null)) throw bad('Kunci baris tidak lengkap.');
  return cfg.pk.map((p) => {
    const v = coerce(cfg, p, k[p], '');
    if (v == null) throw bad('Kunci baris tidak lengkap.');
    return v;
  });
}
const pkWhere = (cfg, vals, user, t) => {
  const w = cfg.pk.map((p) => `${q(p)} = ?`), p = [...vals];
  const sc = scopePred(user, t);
  if (sc) { w.push(sc.sql); p.push(...sc.params); }
  return { sql: w.join(' AND '), params: p };
};

async function adminDeleteRow(db, user, a) {
  const { t, cfg } = getCfg(a[1]);
  const vals = rowKey(cfg, a[2]);
  const w = pkWhere(cfg, vals, user, t);
  const c = await db.query(`SELECT COUNT(*) AS n FROM ${q(t)} WHERE ${w.sql}`, w.params);
  const n = Number(c[0].n) || 0;
  if (n > 0) { await db.exec(`DELETE FROM ${q(t)} WHERE ${w.sql}`, w.params); await touchUpdated(db, t); }
  return { n };
}

// ---- Ubah satu baris ----------------------------------------------------------------------------
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

async function adminUpdate(db, user, a) {
  const { t, cfg } = getCfg(a[1]);
  const k = a[2], ch = a[3];
  if (!isObj(k) || !isObj(ch)) throw bad('Data tidak valid.');
  for (const x of Object.keys(ch)) if (!cfg.cols.includes(x)) throw bad(`Kolom ${x} tidak dikenal.`);
  const vals = rowKey(cfg, k);
  const keys = Object.keys(ch);
  if (!keys.length) return { n: 0 };
  scopePred(user, t);                                      // item -> 403 untuk Admin Koorbam

  const set = [], args = [];
  for (const c of keys) {
    let v = coerce(cfg, c, ch[c], '');
    if (c === 'kode' && v != null) v = String(fixKode(v)).trim();
    if (v == null && (cfg.zero || []).includes(c)) v = 0;
    set.push(`${q(c)} = ?`); args.push(v);
  }

  if (!isPusat(user)) {
    const sc = user.bam_scope || [];
    if (SCOPE_BAM.has(t) && 'bam' in ch && !sc.includes(String(ch.bam == null ? '' : ch.bam).trim().toUpperCase()))
      throw bad(`BAM harus ${sc.join('/')} untuk akun Anda.`);
    if (!SCOPE_BAM.has(t) && 'kode' in ch) {
      const w = bamWhere(user, 'bam');
      const r = await db.query(`SELECT 1 AS x FROM toko WHERE UPPER(TRIM(kode)) = ? AND ${w.sql} LIMIT 1`,
        [String(ch.kode == null ? '' : ch.kode).trim().toUpperCase(), ...w.params]);
      if (!r.length) throw bad(`Kode toko itu tidak termasuk BAM ${sc.join('/')}.`);
    }
  }

  const w = pkWhere(cfg, vals, user, t);
  const c = await db.query(`SELECT COUNT(*) AS n FROM ${q(t)} WHERE ${w.sql}`, w.params);
  if (!(Number(c[0].n) > 0)) throw new HttpError(404, 'Baris tidak ditemukan (mungkin sudah berubah).', 'NOT_FOUND');
  try {
    await db.exec(`UPDATE ${q(t)} SET ${set.join(', ')} WHERE ${w.sql}`, [...args, ...w.params]);
  } catch (e) {
    if (/duplicate entry|\b1062\b/i.test(String(e && e.message))) throw new HttpError(409, 'Data dengan kunci yang sama sudah ada.', 'DUP');
    throw e;
  }
  await touchUpdated(db, t);
  return { n: 1 };
}

// ---- Impor massal (api_adminimport) -------------------------------------------------------------
function prepRows(cfg, rows, pc) {
  return rows.map((r, i) => {
    if (!isObj(r)) throw bad('Data tidak valid.');
    const label = `Baris ${i + 1}: `;
    const o = {};
    for (const c of pc) {
      let v = coerce(cfg, c, r[c], label);
      if (c === 'kode' && v != null) v = String(fixKode(v)).trim();
      if (v == null && (cfg.zero || []).includes(c)) v = 0;
      o[c] = v;
    }
    return o;
  });
}

// Satu baris per kunci (yang terakhir menang), seperti DISTINCT ON pada versi Postgres.
function dedupe(rows, nk) {
  const m = new Map();
  for (const r of rows) m.set(nk.map((c) => (r[c] == null ? '\u0000' : String(r[c]))).join('\u0001'), r);
  return [...m.values()];
}

// Admin Koorbam: setiap baris yang masuk harus milik BAM di areanya.
async function checkImportScope(db, user, t, rows) {
  if (isPusat(user)) return;
  const sc = user.bam_scope || [];
  scopePred(user, t);                                      // item -> 403
  const up = (v) => String(v == null ? '' : v).trim().toUpperCase();
  if (SCOPE_BAM.has(t)) {
    const salah = [...new Set(rows.filter((r) => !sc.includes(up(r.bam))).map((r) => up(r.bam) || '(kosong)'))];
    if (salah.length) throw bad(`Kolom BAM harus ${sc.join('/')} untuk akun Anda (ditemukan: ${salah.slice(0, 5).join(', ')}).`);
    if (t === 'toko') {
      for (const part of chunks([...new Set(rows.map((r) => up(r.kode)))], 1000)) {
        const ex = await db.query(`SELECT UPPER(TRIM(bam)) AS b FROM toko WHERE UPPER(TRIM(kode)) IN (${ph(part.length)})`, part);
        if (ex.some((x) => !sc.includes(String(x.b == null ? '' : x.b)))) throw bad('Ada kode toko yang sudah dipakai BAM lain.');
      }
    }
    return;
  }
  const w = bamWhere(user, 'bam');
  const own = new Set((await db.query(`SELECT DISTINCT UPPER(TRIM(kode)) AS k FROM toko WHERE ${w.sql}`, w.params)).map((x) => x.k));
  const salah = [...new Set(rows.map((r) => up(r.kode)).filter((k) => !own.has(k)).map((k) => k || '(kosong)'))];
  if (salah.length) throw bad(`Kode toko tidak termasuk BAM ${sc.join('/')} (upload data Toko dulu): ${salah.slice(0, 5).join(', ')}`);
}

// Kondisi kunci yang aman untuk NULL (setara "is not distinct from").
function keyCond(nk, keys) {
  const full = keys.filter((k) => k.every((v) => v != null));
  const part = keys.filter((k) => k.some((v) => v == null));
  const parts = [], params = [];
  if (full.length) {
    parts.push(`(${nk.map(q).join(',')}) IN (${full.map(() => `(${ph(nk.length)})`).join(',')})`);
    params.push(...full.flat());
  }
  for (const k of part) {
    parts.push('(' + nk.map((c, i) => (k[i] == null ? `${q(c)} IS NULL` : `${q(c)} = ?`)).join(' AND ') + ')');
    params.push(...k.filter((v) => v != null));
  }
  return { sql: parts.join(' OR '), params };
}

async function adminImport(db, user, a) {
  const { t, cfg } = getCfg(a[1]);
  const rws = a[2];
  if (!Array.isArray(rws)) throw bad('Data tidak valid.');
  if (!rws.length) return { masuk: 0, baru: 0, ubah: 0 };
  if (rws.length > 5000) throw bad('Maksimal 5000 baris per kiriman.');
  const given = Array.isArray(a[3]) ? a[3].map(String) : [];
  const pc = [...new Set(given.filter((x) => cfg.cols.includes(x)))];
  const skip = a[4] === true || a[4] === 'true';
  if (!cfg.nk.every((c) => pc.includes(c))) throw bad(`Kolom kunci wajib ada: ${cfg.nk.join(', ')}`);
  scopePred(user, t);                                      // item -> 403 untuk Admin Koorbam

  let rows = prepRows(cfg, rws, pc);
  if (cfg.uq) rows.forEach((r, i) => cfg.nk.forEach((c) => {
    if (r[c] == null || r[c] === '') throw bad(`Baris ${i + 1}: kolom kunci ${c} kosong.`);
  }));
  await checkImportScope(db, user, t, rows);
  rows = dedupe(rows, cfg.nk);

  const perStmt = Math.max(1, Math.floor(10000 / pc.length));
  const insertSql = (n, tail) =>
    `INSERT INTO ${q(t)} (${pc.map(q).join(',')}) VALUES ${Array(n).fill(`(${ph(pc.length)})`).join(',')}${tail || ''}`;
  const flat = (part) => part.flatMap((r) => pc.map((c) => r[c]));

  if (cfg.uq) {
    // Tabel dengan kunci unik: upsert. Hitung dulu berapa kunci yang sudah ada => "ubah"; sisanya "baru".
    let ada = 0;
    for (const part of chunks(rows, 1000)) {
      const k = keyCond(cfg.nk, part.map((r) => cfg.nk.map((c) => r[c])));
      const r = await db.query(`SELECT COUNT(*) AS n FROM ${q(t)} WHERE ${k.sql}`, k.params);
      ada += Number(r[0].n) || 0;
    }
    const upd = pc.filter((c) => !cfg.nk.includes(c)).map((c) => `${q(c)} = VALUES(${q(c)})`);
    const tail = ' ON DUPLICATE KEY UPDATE ' + (upd.length ? upd.join(', ') : `${q(cfg.nk[0])} = ${q(cfg.nk[0])}`);
    for (const part of chunks(rows, perStmt)) await db.exec(insertSql(part.length, tail), flat(part));
    await touchUpdated(db, t);
    return { masuk: rows.length, baru: rows.length - ada, ubah: ada };
  }

  // Tabel tanpa kunci unik: hapus baris lama dengan kunci yang sama (kecuali mode Ganti, data lama sudah dihapus), lalu isi.
  let hapus = 0;
  if (!skip) {
    const scoped = !isPusat(user) && t === 'budged' ? bamWhere(user, 'bam') : null;
    for (const part of chunks(rows, 500)) {
      const k = keyCond(cfg.nk, part.map((r) => cfg.nk.map((c) => r[c])));
      const sql = scoped ? `(${k.sql}) AND ${scoped.sql}` : k.sql;
      const params = scoped ? [...k.params, ...scoped.params] : k.params;
      const c = await db.query(`SELECT COUNT(*) AS n FROM ${q(t)} WHERE ${sql}`, params);
      hapus += Number(c[0].n) || 0;
      await db.exec(`DELETE FROM ${q(t)} WHERE ${sql}`, params);
    }
  }
  for (const part of chunks(rows, perStmt)) await db.exec(insertSql(part.length), flat(part));
  await touchUpdated(db, t);
  const ubah = Math.min(hapus, rows.length);
  const baru = Math.max(rows.length - hapus, 0);
  return { masuk: baru + ubah, baru, ubah };
}

// ---- Gempar -------------------------------------------------------------------------------------
const dmy = (s) => `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}`;
const optDate = (v) => (has(v) ? dateStr(v) : null);

async function gemparDates(db) {
  const r = await db.query('SELECT DISTINCT tanggal FROM gempar WHERE tanggal IS NOT NULL ORDER BY tanggal DESC');
  return r.map((x) => ymd(x.tanggal));
}

async function saveGempar(db, a) {            // [tok, tanggalLama, tanggalBaru] -> daftar tanggal
  const o = optDate(a[1]), n = optDate(a[2]);
  if (!n) throw bad('Tanggal wajib diisi.');
  const ada = async (d) => Number((await db.query('SELECT COUNT(*) AS n FROM gempar WHERE tanggal = ?', [d]))[0].n) > 0;
  if (!o) {
    if (await ada(n)) throw bad(`Tanggal ${dmy(n)} sudah ada di tabel Gempar.`);
    await db.exec('INSERT INTO gempar (tanggal) VALUES (?)', [n]);
    await touchUpdated(db, 'cache');
  } else {
    if (o !== n && (await ada(n))) throw bad(`Tanggal ${dmy(n)} sudah ada di tabel Gempar.`);
    if (!(await ada(o))) throw bad(`Tanggal ${dmy(o)} tidak ditemukan di tabel Gempar.`);
    await db.exec('UPDATE gempar SET tanggal = ? WHERE tanggal = ?', [n, o]);
    await touchUpdated(db, 'cache');
  }
  return gemparDates(db);
}

async function deleteGempar(db, a) {          // [tok, tanggal] -> daftar tanggal
  const d = optDate(a[1]);
  if (d) { await db.exec('DELETE FROM gempar WHERE tanggal = ?', [d]); await touchUpdated(db, 'cache'); }
  return gemparDates(db);
}

async function gemparList(db) {               // -> [{id, tanggal, ket}]
  const r = await db.query('SELECT id, tanggal, ket FROM gempar ORDER BY tanggal DESC, id DESC');
  return r.map((x) => ({ id: Number(x.id), tanggal: ymd(x.tanggal), ket: x.ket }));
}

async function gemparSave(db, a) {            // [tok, id, tanggal, ket]
  let d;
  try { d = dateStr(a[2]); } catch { throw bad('Tanggal tidak valid.'); }
  let k = String(a[3] == null ? '' : a[3]).trim().toUpperCase();
  if (k === '') k = 'GEMPAR';
  try {
    if (!has(a[1])) await db.exec('INSERT INTO gempar (tanggal, ket) VALUES (?, ?)', [d, k]);
    else await db.exec('UPDATE gempar SET tanggal = ?, ket = ? WHERE id = ?', [d, k, numVal(a[1], 'ID tidak valid.')]);
  } catch (e) {
    if (/duplicate entry|\b1062\b/i.test(String(e && e.message))) throw new HttpError(409, 'Tanggal dan keterangan itu sudah ada.', 'DUP');
    throw e;
  }
  await touchUpdated(db, 'cache');
  return true;
}

async function gemparDelete(db, a) {          // [tok, id]
  await db.exec('DELETE FROM gempar WHERE id = ?', [numVal(a[1], 'ID tidak valid.')]);
  await touchUpdated(db, 'cache');
  return true;
}

// ---- Override budged & rank ---------------------------------------------------------------------
async function overrideMap(db, table) {
  const r = await db.query(`SELECT \`key\`, val FROM ${table}`);
  return Object.fromEntries(r.map((x) => [x.key, Number(x.val)]));
}

// null = hapus override; angka = simpan
function ovrValue(v) {
  if (v == null || String(v).trim() === '') return null;
  return numVal(v, 'Angka tidak valid.');
}

async function putOverride(db, table, key, val) {
  if (val == null) await db.exec(`DELETE FROM ${table} WHERE \`key\` = ?`, [key]);
  else await db.exec(`INSERT INTO ${table} (\`key\`, val) VALUES (?, ?) ON DUPLICATE KEY UPDATE val = VALUES(val), updated_at = UTC_TIMESTAMP()`, [key, val]);
  await touchUpdated(db, 'cache');
}

async function saveBudOvr(db, user, a) {      // [tok, key, nilai] — key 'BUD|CAB|nama|YYYY-MM' atau 'BUD|TK|kode|YYYY-MM'
  const key = String(a[1] == null ? '' : a[1]);
  if (!/^BUD\|(CAB|TK)\|[^|]+\|[0-9]{4}-[0-9]{2}$/.test(key) || key.length > 180) throw bad('Kunci tidak valid.');
  const val = ovrValue(a[2]);
  if (val != null && (val < 0 || val > 1e12)) throw bad('Budged tidak masuk akal.');

  if (!isPusat(user)) {                       // Admin Koorbam: cabang/toko yang diubah harus ada di areanya
    const [, kind, nama] = key.split('|');
    const N = String(nama).trim().toUpperCase();
    const w = bamWhere(user, 'bam');
    const cond = kind === 'CAB'
      ? '(UPPER(TRIM(cabang)) = ? OR UPPER(TRIM(cab_pnl)) = ?)'
      : '(UPPER(TRIM(kode)) = ? OR UPPER(REGEXP_REPLACE(COALESCE(kode, \'\'), \'[^A-Za-z0-9]\', \'\')) = ?)';
    const prm = kind === 'CAB' ? [N, N] : [N, norm(nama)];
    const r = await db.query(`SELECT 1 AS x FROM toko WHERE ${cond} AND ${w.sql} LIMIT 1`, [...prm, ...w.params]);
    if (!r.length) throw new HttpError(403, 'Cabang/toko itu di luar area Anda.', 'FORBIDDEN');
  }
  await putOverride(db, 'budged_override', key, val);
  return overrideMap(db, 'budged_override');
}

async function saveRankOvr(db, a) {           // [tok, key, nilai] — key 'BAS|...'
  const key = String(a[1] == null ? '' : a[1]);
  if (!/^BAS\|/.test(key) || key.length > 180) throw bad('Kunci tidak valid.');
  await putOverride(db, 'rank_override', key, ovrValue(a[2]));
  return overrideMap(db, 'rank_override');
}

// ---- Pendaftaran --------------------------------------------------------------------------------
export const adminHandlers = {
  adminlist:      { need: 'edit',  run: ({ db, user }, a) => adminList(db, user, a) },
  admincount:     { need: 'edit',  run: ({ db, user }, a) => adminCount(db, user, a) },
  admininfo:      { need: 'edit',  run: ({ db, user }) => adminInfo(db, user) },
  adminupdate:    { need: 'edit',  run: ({ db, user }, a) => adminUpdate(db, user, a) },
  admindeleterow: { need: 'edit',  run: ({ db, user }, a) => adminDeleteRow(db, user, a) },
  admindelete:    { need: 'edit',  run: ({ db, user }, a) => adminDelete(db, user, a) },
  adminimport:    { need: 'edit',  run: ({ db, user }, a) => adminImport(db, user, a) },
  savebudovr:     { need: 'edit',  run: ({ db, user }, a) => saveBudOvr(db, user, a) },
  saverankovr:    { need: 'utama', run: ({ db }, a) => saveRankOvr(db, a) },
  getgemparlist:  { need: 'pusat', run: ({ db }) => gemparDates(db) },
  savegempar:     { need: 'pusat', run: ({ db }, a) => saveGempar(db, a) },
  deletegempar:   { need: 'pusat', run: ({ db }, a) => deleteGempar(db, a) },
  gemparlist:     { need: 'pusat', run: ({ db }) => gemparList(db) },
  gemparsave:     { need: 'pusat', run: ({ db }, a) => gemparSave(db, a) },
  gempardelete:   { need: 'pusat', run: ({ db }, a) => gemparDelete(db, a) },
};

// Untuk pengujian
export const _internals = { T, filterWhere, keyCond, dedupe, coerce, prepRows, ovrValue, dateStr };
