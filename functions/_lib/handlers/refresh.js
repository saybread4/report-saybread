// Isi ulang tabel ringkasan mv_* dari data mentah (pengganti `refresh materialized view` di Supabase).
// Tabel ringkasan = hasil hitung yang disimpan di TiDB supaya halaman Rank/Perform/Monitor cepat dibuka.
// Dipanggil bertahap oleh tombol "Perbarui Dashboard": 7 langkah besar, dan langkah yang berat (3, 4, 5) dipecah lagi
// menjadi potongan kecil (langkah 4: jendela 10 hari; langkah 5-6: per bulan x bagian kode toko). Satu permintaan = satu perintah SQL yang
// ukurannya terbatas, sehingga tidak melewati batas transaksi/memori/waktu TiDB.
import { num } from '../util.js';
import { touchUpdated } from '../dataupdates.js';
import { HttpError } from '../http.js';

const NORMSQL = (c) => `UPPER(REGEXP_REPLACE(COALESCE(${c}, ''), '[^A-Za-z0-9]', ''))`;
const NZ = (c) => `COALESCE(NULLIF(NULLIF(TRIM(${c}), ''), '0'), '')`;
const MONTH_START = (c) => `DATE_SUB(${c}, INTERVAL (DAYOFMONTH(${c}) - 1) DAY)`;

export const STEPS = 7;
export const STEP_NAMA = ['tanggal', 'daftar toko', 'daftar bulan', 'penjualan harian', 'penjualan item bulanan', 'penjualan item tanggal sama', 'stock'];
const BUCKETS = 4;   // langkah 4 & 5: tiap bulan dibagi 4 bagian menurut kode toko
const STOCK_BUCKETS = 8; // langkah stock dibagi 8 agar query tidak memakan memori TiDB terlalu besar

// Langkah 4 dan 5 dikerjakan per bulan (mi) DAN per bagian kode, supaya satu transaksi tidak terlalu besar.
const monSql = (table, ket, having) => `
  INSERT INTO ${table} (kode, knorm, ds, mi, prod, qty, rp, baq, barp)
  SELECT i.kode, ${NORMSQL('i.kode')}, TRIM(i.deskripsi), mm.mi,
         SUM(i.produksi), SUM(i.sales_qty), SUM(i.sales_rp), SUM(i.ba_qty), SUM(i.ba_rp)
    FROM sales_item i JOIN mv_mon_list mm ON mm.y = i.tahun AND mm.b = i.bulan
   WHERE i.ket = '${ket}' AND mm.mi = ? AND (CRC32(i.kode) % ${BUCKETS}) = ?
   GROUP BY i.kode, TRIM(i.deskripsi), mm.mi ${having}`;

const HAVING_NONZERO = `HAVING COALESCE(SUM(i.produksi), 0) <> 0 OR COALESCE(SUM(i.sales_qty), 0) <> 0
   OR COALESCE(SUM(i.sales_rp), 0) <> 0 OR COALESCE(SUM(i.ba_qty), 0) <> 0 OR COALESCE(SUM(i.ba_rp), 0) <> 0`;

export const SQL = {
  dates: `INSERT INTO mv_dates (tanggal, di)
    SELECT x.tanggal, ROW_NUMBER() OVER (ORDER BY x.tanggal) - 1 FROM (SELECT DISTINCT tanggal FROM sales_toko) x`,

  ks: `INSERT INTO mv_ks (ki, kode, toko, cabang, cabpnl)
    SELECT ROW_NUMBER() OVER (ORDER BY k.kode) - 1, k.kode,
           ${NZ('t.toko')},
           COALESCE(NULLIF(${NZ('t.cabang')}, ''), r.cabang, ''),
           COALESCE(NULLIF(${NZ('t.cab_pnl')}, ''), r.cab_pnl, '')
      FROM (SELECT kode FROM sales_toko GROUP BY kode) k
      LEFT JOIN toko t ON ${NORMSQL('t.kode')} = ${NORMSQL('k.kode')}
      LEFT JOIN sales_kode_ref r ON r.kode = k.kode`,

  monList: `INSERT INTO mv_mon_list (mk, y, b, hari, mi)
    SELECT s.mk, s.y, s.b, s.hari, ROW_NUMBER() OVER (ORDER BY s.mk) - 1
      FROM (
        SELECT r.mk, r.y, r.b, r.hari
          FROM (
            SELECT m.mk, m.y, m.b, m.hari, ROW_NUMBER() OVER (ORDER BY m.mk DESC) AS rn
              FROM (SELECT ${MONTH_START('tanggal')} AS mk, YEAR(tanggal) AS y, MONTH(tanggal) AS b, COUNT(DISTINCT tanggal) AS hari
                      FROM sales_toko GROUP BY ${MONTH_START('tanggal')}, YEAR(tanggal), MONTH(tanggal)) m
          ) r
         WHERE r.rn <= 12
           AND r.mk = DATE_SUB((SELECT MAX(${MONTH_START('tanggal')}) FROM sales_toko), INTERVAL (r.rn - 1) MONTH)
      ) s`,

  // Penjualan harian per toko, dikerjakan per bulan: parameter = [awal, akhir(tidak termasuk), awal, akhir]
  tglMonth: `INSERT INTO mv_tgl (kode, tanggal, stock_qty, prod, qty, rp, mg, baq, barp)
    SELECT s.kode, s.tanggal, COALESCE(st.q, 0), s.produksi, s.sales_qty, s.sales_rp, s.margin, s.ba_qty, s.ba_rp
      FROM sales_toko s
      LEFT JOIN (SELECT kode, tanggal, SUM(stock_total) AS q FROM stock_toko
                  WHERE UPPER(jenis) LIKE 'DOUGH%' AND tanggal >= ? AND tanggal < ? GROUP BY kode, tanggal) st
        ON st.kode = s.kode AND st.tanggal = s.tanggal
     WHERE s.tanggal >= ? AND s.tanggal < ?`,

  monRows: monSql('mv_mon_rows', 'closing', HAVING_NONZERO),
  monSame: monSql('mv_mon_same', 'tgl_yang_sama', ''),

  stockIdx: (bucket) => `INSERT INTO mv_stock_idx (kode, deskripsi, cab, bas, as_, tk, tk_key, jn, qty, qpd, md, i_cab, i_bas, i_as, i_tk, i_ds, i_jn, i_md)
    SELECT b.kode, b.deskripsi, b.cab, b.bas, b.as_, b.tk, b.tk_key, b.jn, b.qty, b.qpd, b.md,
           MOD(CRC32(COALESCE(b.cab, '')), 2000000000),
           MOD(CRC32(COALESCE(b.bas, '')), 2000000000),
           MOD(CRC32(COALESCE(b.as_, '')), 2000000000),
           MOD(CRC32(COALESCE(b.tk_key, '')), 2000000000),
           MOD(CRC32(COALESCE(b.deskripsi, '')), 2000000000),
           MOD(CRC32(COALESCE(b.jn, '')), 2000000000),
           MOD(CRC32(COALESCE(b.md, '')), 2000000000)
      FROM (
        SELECT st.kode, TRIM(st.deskripsi) AS deskripsi,
               ${NZ('t.cabang')} AS cab, ${NZ('t.bas')} AS bas, ${NZ('t.`as`')} AS as_,
               JSON_ARRAY(st.kode, ${NZ('t.toko')}, ${NZ('t.am')}, ${NZ('t.bastr')}) AS tk,
               CONCAT_WS('|', st.kode, ${NZ('t.toko')}, ${NZ('t.am')}, ${NZ('t.bastr')}) AS tk_key,
               COALESCE(st.jenis, '') AS jn, COALESCE(st.stock_qty, 0) AS qty,
               COALESCE(q.qpd, 0) AS qpd, COALESCE(md.modis, 'Tidak Aktif') AS md
          FROM stock st
          LEFT JOIN toko t ON ${NORMSQL('t.kode')} = ${NORMSQL('st.kode')}
          LEFT JOIN (
            SELECT s.kode, TRIM(s.deskripsi) AS deskripsi, SUM(s.sales_qty) / NULLIF(bl.hari, 0) AS qpd
              FROM sales_item s
              JOIN (SELECT DISTINCT kode, TRIM(deskripsi) AS deskripsi FROM stock
                     WHERE tanggal = (SELECT MAX(tanggal) FROM stock)
                       AND MOD(CRC32(kode), ${STOCK_BUCKETS}) = ${bucket}) sk
                ON sk.kode = s.kode AND sk.deskripsi = TRIM(s.deskripsi)
              CROSS JOIN (SELECT DAY(MAX(tanggal)) AS hari, YEAR(MAX(tanggal)) AS y, MONTH(MAX(tanggal)) AS m FROM sales_toko) bl
             WHERE s.ket = 'closing' AND s.tahun = bl.y AND s.bulan = bl.m
             GROUP BY s.kode, TRIM(s.deskripsi), bl.hari
          ) q ON q.kode = st.kode AND q.deskripsi = TRIM(st.deskripsi)
          LEFT JOIN (
            SELECT z.nk, z.nd, z.modis
              FROM (SELECT y.nk, y.nd, y.modis, ROW_NUMBER() OVER (PARTITION BY y.nk, y.nd ORDER BY y.id) AS rn
                      FROM (SELECT id, ${NORMSQL('kode')} AS nk, ${NORMSQL('deskripsi')} AS nd, modis
                              FROM modis WHERE ${NZ('modis')} <> ''
                                AND MOD(CRC32(kode), ${STOCK_BUCKETS}) = ${bucket}) y) z
             WHERE z.rn = 1
          ) md ON md.nk = ${NORMSQL('st.kode')} AND md.nd = ${NORMSQL('st.deskripsi')}
         WHERE st.tanggal = (SELECT MAX(tanggal) FROM stock)
           AND MOD(CRC32(st.kode), ${STOCK_BUCKETS}) = ${bucket}
      ) b`
};

// ---- Pembanding "isi sama?" supaya potongan yang tidak berubah TIDAK ditulis ulang -------------------------------------
// Tulis ke TiDB adalah bagian termahal (RU). Sebelum mengganti satu potongan, jumlah beberapa kolom di tabel sumber dibandingkan
// dengan jumlah di tabel ringkasan; bila sama persis potongan dilewati. Tombol "Perbarui Dashboard" + Shift (force) memaksa hitung ulang penuh.
const TGL_SRC = `SELECT COUNT(*) AS n, COALESCE(SUM(s.produksi), 0) AS prod, COALESCE(SUM(s.sales_qty), 0) AS qty, COALESCE(SUM(s.sales_rp), 0) AS rp,
         COALESCE(SUM(s.margin), 0) AS mg, COALESCE(SUM(s.ba_qty), 0) AS baq, COALESCE(SUM(s.ba_rp), 0) AS barp, COALESCE(SUM(COALESCE(st.q, 0)), 0) AS stock_qty
    FROM sales_toko s
    LEFT JOIN (SELECT kode, tanggal, SUM(stock_total) AS q FROM stock_toko
                WHERE UPPER(jenis) LIKE 'DOUGH%' AND tanggal >= ? AND tanggal < ? GROUP BY kode, tanggal) st
      ON st.kode = s.kode AND st.tanggal = s.tanggal
   WHERE s.tanggal >= ? AND s.tanggal < ?`;
const TGL_DST = `SELECT COUNT(*) AS n, COALESCE(SUM(prod), 0) AS prod, COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(rp), 0) AS rp,
         COALESCE(SUM(mg), 0) AS mg, COALESCE(SUM(baq), 0) AS baq, COALESCE(SUM(barp), 0) AS barp, COALESCE(SUM(stock_qty), 0) AS stock_qty
    FROM mv_tgl WHERE tanggal >= ? AND tanggal < ?`;
const MON_SRC = `SELECT COALESCE(SUM(i.produksi), 0) AS prod, COALESCE(SUM(i.sales_qty), 0) AS qty, COALESCE(SUM(i.sales_rp), 0) AS rp,
         COALESCE(SUM(i.ba_qty), 0) AS baq, COALESCE(SUM(i.ba_rp), 0) AS barp
    FROM sales_item i JOIN mv_mon_list mm ON mm.y = i.tahun AND mm.b = i.bulan WHERE i.ket = ? AND mm.mi = ?`;
const monDst = (table) => `SELECT COALESCE(SUM(prod), 0) AS prod, COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(rp), 0) AS rp,
         COALESCE(SUM(baq), 0) AS baq, COALESCE(SUM(barp), 0) AS barp FROM ${table} WHERE mi = ?`;

// Sidik jari data sumber langkah stock. Bila sama dengan yang tersimpan di mv_meta, seluruh langkah (8 INSERT berat) dilewati.
const STOCK_FP = `SELECT
  (SELECT CONCAT_WS('|', MAX(tanggal), COUNT(*), COALESCE(SUM(stock_qty), 0), COALESCE(SUM(CRC32(CONCAT_WS('|', kode, plu, jenis, stock_qty))), 0))
     FROM stock WHERE tanggal = (SELECT MAX(tanggal) FROM stock)) AS a,
  (SELECT CONCAT_WS('|', COUNT(*), COALESCE(SUM(CRC32(CONCAT_WS('|', kode, toko, cabang, bas, bastr, am, \`as\`))), 0)) FROM toko) AS b,
  (SELECT CONCAT_WS('|', COUNT(*), COALESCE(SUM(CRC32(CONCAT_WS('|', kode, plu, modis))), 0)) FROM modis) AS c,
  (SELECT MAX(tanggal) FROM sales_toko) AS d,
  (SELECT CONCAT_WS('|', COUNT(*), COALESCE(SUM(sales_qty), 0)) FROM sales_item
    WHERE ket = 'closing' AND tahun * 100 + bulan = (SELECT MAX(YEAR(tanggal) * 100 + MONTH(tanggal)) FROM sales_toko)) AS e`;

const META_DDL = 'CREATE TABLE IF NOT EXISTS mv_meta (k VARCHAR(60) NOT NULL, v VARCHAR(600), PRIMARY KEY (k))';

const close = (x, y) => Math.abs((Number(x) || 0) - (Number(y) || 0)) < 0.001;
// true hanya bila KEDUA sisi berhasil dibaca dan semua kolomnya sama; bila ragu -> false (hitung ulang).
const sameRow = (a, b) => !!a && !!b && Object.keys(a).length > 0 && Object.keys(a).every((k) => k in b && close(a[k], b[k]));
async function same(db, srcSql, srcArgs, dstSql, dstArgs) {
  try {
    const a = (await db.query(srcSql, srcArgs))[0], b = (await db.query(dstSql, dstArgs))[0];
    return sameRow(a, b);
  } catch (e) { return false; }
}
async function metaGet(db, k) {
  try { const r = await db.query('SELECT v FROM mv_meta WHERE k = ?', [k]); return r[0] ? String(r[0].v) : null; } catch (e) { return null; }
}
async function metaSet(db, k, v) {
  try { await db.exec('REPLACE INTO mv_meta (k, v) VALUES (?, ?)', [k, v]); } catch (e) { /* tidak boleh menggagalkan refresh */ }
}
async function stockFingerprint(db) {
  try {
    const r = (await db.query(STOCK_FP))[0];
    if (!r) return null;
    const v = ['a', 'b', 'c', 'd', 'e'].map((k) => (r[k] == null ? '' : String(r[k]))).join('#');
    return /[0-9]/.test(v) ? v : null;
  } catch (e) { return null; }
}

const TABLES = ['mv_dates', 'mv_ks', 'mv_mon_list', 'mv_tgl', 'mv_mon_rows', 'mv_mon_same', 'mv_stock_idx'];

const nextMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

// Beberapa perintah sebagai satu kesatuan: bila salah satu gagal, semuanya dibatalkan dan isi lama tabel TETAP UTUH.
// (Dulu tabel dikosongkan dulu baru diisi; kalau gagal di tengah, hasilnya setengah kosong, mis. data November hilang.)
// Bila db tidak punya tx (database tiruan di tes), perintah dijalankan berurutan.
const atomic = (db, fn) => (typeof db.tx === 'function' ? db.tx(fn) : fn(db));

// Penjualan harian dipecah menjadi jendela 10 harian per bulan: [awal, akhir) -> perintah kecil dan cepat.
export const WINDOW_DAYS = [1, 11, 21];
export function tglWindows(months) {
  const out = [];
  for (const ym of months) {
    const end = nextMonth(ym);
    WINDOW_DAYS.forEach((d, i) => {
      const a = `${ym}-${String(d).padStart(2, '0')}`;
      const b = i + 1 < WINDOW_DAYS.length ? `${ym}-${String(WINDOW_DAYS[i + 1]).padStart(2, '0')}` : end;
      out.push([a, b]);
    });
  }
  return out;
}

// Menjalankan satu potongan dari satu langkah. Mengembalikan { next, total }: next = nomor potongan berikutnya (null = langkah selesai).
export async function refreshStep(db, step, sub = 0, force = false) {
  if (!Number.isInteger(step) || step < 0 || step >= STEPS) throw Object.assign(new Error('Langkah tidak dikenal.'), { status: 400 });
  if (!Number.isInteger(sub) || sub < 0) sub = 0;

  if (step === 3) {                                         // penjualan harian: satu jendela 10 hari per potongan, diganti secara atomik
    const months = (await db.query("SELECT DATE_FORMAT(tanggal, '%Y-%m') AS ym FROM sales_toko GROUP BY ym ORDER BY ym")).map((r) => r.ym);
    const wins = tglWindows(months);
    if (sub === 0) {                                        // buang hanya sisa di luar rentang data penjualan; isi lama tetap ada sampai diganti
      if (!months.length) await db.exec('DELETE FROM mv_tgl');
      else await db.exec('DELETE FROM mv_tgl WHERE tanggal < ? OR tanggal >= ?', [`${months[0]}-01`, nextMonth(months[months.length - 1])]);
    }
    const w = wins[sub];
    if (!w) return { next: null, total: wins.length };
    const nxt = sub + 1 < wins.length ? sub + 1 : null;
    if (!force && await same(db, TGL_SRC, [w[0], w[1], w[0], w[1]], TGL_DST, [w[0], w[1]])) return { next: nxt, total: wins.length };   // jendela ini tidak berubah: tidak ditulis ulang
    await atomic(db, async (t) => {
      await t.exec('DELETE FROM mv_tgl WHERE tanggal >= ? AND tanggal < ?', [w[0], w[1]]);
      await t.exec(SQL.tglMonth, [w[0], w[1], w[0], w[1]]);
    });
    return { next: sub + 1 < wins.length ? sub + 1 : null, total: wins.length };
  }
  if (step === 4 || step === 5) {                           // item bulanan: satu bulan x satu bagian kode per potongan; bulan yang tidak berubah dilewati
    const table = TABLES[step], ket = step === 4 ? 'closing' : 'tgl_yang_sama';
    const months = (await db.query('SELECT mi FROM mv_mon_list ORDER BY mi')).map((r) => num(r.mi));
    const total = months.length * BUCKETS;
    if (sub === 0) {
      if (force) await db.exec(`TRUNCATE TABLE ${table}`);
      else await db.exec(`DELETE FROM ${table} WHERE mi >= ? OR mi < 0`, [months.length]);   // buang sisa bulan yang sudah tidak ada di daftar
    }
    if (sub >= total) return { next: null, total };
    const m = Math.floor(sub / BUCKETS), bucket = sub % BUCKETS;
    if (!force && bucket === 0) {
      if (await same(db, MON_SRC, [ket, months[m]], monDst(table), [months[m]]))
        return { next: (m + 1) * BUCKETS < total ? (m + 1) * BUCKETS : null, total };       // bulan ini tidak berubah: lewati keempat bagiannya
      await db.exec(`DELETE FROM ${table} WHERE mi = ?`, [months[m]]);
    }
    await db.exec(step === 4 ? SQL.monRows : SQL.monSame, [months[m], bucket]);
    return { next: sub + 1 < total ? sub + 1 : null, total };
  }
  if (step === 6) {                                         // stock: dibagi per bagian kode agar query tetap ringan
    if (sub === 0) {
      let fp = null;
      try { await db.exec(META_DDL); fp = await stockFingerprint(db); } catch (e) { fp = null; }
      if (!force && fp && (await metaGet(db, 'stock_fp')) === fp) return { next: null, total: 1 };   // data sumber sama dengan refresh terakhir: lewati
      await metaSet(db, 'stock_fp', fp ? 'building:' + fp : '');
      await db.exec(`TRUNCATE TABLE ${TABLES[step]}`);
    }
    if (sub >= STOCK_BUCKETS) return { next: null, total: STOCK_BUCKETS };
    await db.exec(SQL.stockIdx(sub));
    if (sub + 1 >= STOCK_BUCKETS) {                         // semua bagian selesai: tandai sidik jari sebagai sah
      const v = await metaGet(db, 'stock_fp');
      if (v && v.startsWith('building:')) await metaSet(db, 'stock_fp', v.slice(9));
    }
    return { next: sub + 1 < STOCK_BUCKETS ? sub + 1 : null, total: STOCK_BUCKETS };
  }
  if (sub === 0) {                                          // langkah ringan: hapus + isi dalam satu transaksi (gagal -> isi lama tetap)
    await atomic(db, async (t) => {
      await t.exec(`DELETE FROM ${TABLES[step]}`);
      await t.exec([SQL.dates, SQL.ks, SQL.monList][step]);
    });
  }
  return { next: null, total: 1 };
}

const pad = (n) => String(n).padStart(2, '0');
export const stamp = () => {
  const j = new Date(Date.now() + 7 * 3600 * 1000);
  return `${pad(j.getUTCDate())}/${pad(j.getUTCMonth() + 1)}/${j.getUTCFullYear()} ${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}`;
};

export const refreshHandlers = {
  // adminRefresh(token, langkah, potongan) -> { langkah, total, next, subTotal, pesan }   token lama diabaikan (identitas dari cookie sesi)
  // next != null berarti masih ada potongan berikutnya untuk langkah yang sama (panggil lagi dengan potongan = next).
  adminrefresh: {
    need: 'edit',
    async run({ db }, a) {
      const s = Number.parseInt(a[1], 10);
      const sub = Number.parseInt(a[2], 10) || 0;
      const force = a[3] === 'full';                       // Shift+klik di tombol: hitung ulang penuh, tanpa melewati potongan yang tidak berubah
      let r;
      try {
        r = await refreshStep(db, s, sub, force);
      } catch (e) {
        if (e && e.status === 400) throw new HttpError(400, e.message);
        console.error('refresh gagal: langkah', s, 'potongan', sub, e);
        // Hanya administrator yang bisa sampai sini, jadi pesan aslinya ditampilkan agar penyebabnya mudah dicari.
        throw new HttpError(500, `Langkah ${s + 1}/${STEPS} (${STEP_NAMA[s]}) gagal${sub ? ' di potongan ' + (sub + 1) : ''}: ${String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 300)}`);
      }
      if (s === STEPS - 1 && r.next == null) await touchUpdated(db, 'refresh');   // langkah terakhir selesai
      return { langkah: s, total: STEPS, next: r.next, subTotal: r.total, pesan: 'Dashboard diperbarui ' + stamp() };
    },
  },
};
