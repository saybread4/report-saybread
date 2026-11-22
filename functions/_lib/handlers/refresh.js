// Isi ulang tabel ringkasan mv_* dari data mentah (pengganti `refresh materialized view` di Supabase).
// Dipanggil bertahap oleh tombol Refresh: langkah 0..6, satu langkah per permintaan (menghindari batas waktu).
import { num } from '../util.js';
import { touchUpdated } from '../dataupdates.js';

const NORMSQL = (c) => `UPPER(REGEXP_REPLACE(COALESCE(${c}, ''), '[^A-Za-z0-9]', ''))`;
const NZ = (c) => `COALESCE(NULLIF(NULLIF(TRIM(${c}), ''), '0'), '')`;
const MONTH_START = (c) => `DATE_SUB(${c}, INTERVAL (DAYOFMONTH(${c}) - 1) DAY)`;

export const STEPS = 7;

// Langkah 4 dan 5 dikerjakan per bulan (mi) supaya satu transaksi tidak terlalu besar.
const monSql = (table, ket, having) => `
  INSERT INTO ${table} (kode, knorm, ds, mi, prod, qty, rp, baq, barp)
  SELECT i.kode, ${NORMSQL('i.kode')}, TRIM(i.deskripsi), mm.mi,
         SUM(i.produksi), SUM(i.sales_qty), SUM(i.sales_rp), SUM(i.ba_qty), SUM(i.ba_rp)
    FROM sales_item i JOIN mv_mon_list mm ON mm.y = i.tahun AND mm.b = i.bulan
   WHERE i.ket = '${ket}' AND mm.mi = ?
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

  tgl: `INSERT INTO mv_tgl (kode, tanggal, stock_qty, prod, qty, rp, mg, baq, barp)
    SELECT s.kode, s.tanggal, COALESCE(st.q, 0), s.produksi, s.sales_qty, s.sales_rp, s.margin, s.ba_qty, s.ba_rp
      FROM sales_toko s
      LEFT JOIN (SELECT kode, tanggal, SUM(stock_total) AS q FROM stock_toko
                  WHERE UPPER(jenis) LIKE 'DOUGH%' GROUP BY kode, tanggal) st
        ON st.kode = s.kode AND st.tanggal = s.tanggal`,

  monRows: monSql('mv_mon_rows', 'closing', HAVING_NONZERO),
  monSame: monSql('mv_mon_same', 'tgl_yang_sama', ''),

  stockIdx: `INSERT INTO mv_stock_idx (kode, deskripsi, cab, bas, as_, tk, tk_key, jn, qty, qpd, md, i_cab, i_bas, i_as, i_tk, i_ds, i_jn, i_md)
    SELECT b.kode, b.deskripsi, b.cab, b.bas, b.as_, b.tk, b.tk_key, b.jn, b.qty, b.qpd, b.md,
           DENSE_RANK() OVER (ORDER BY b.cab) - 1, DENSE_RANK() OVER (ORDER BY b.bas) - 1,
           DENSE_RANK() OVER (ORDER BY b.as_) - 1, DENSE_RANK() OVER (ORDER BY b.tk_key) - 1,
           DENSE_RANK() OVER (ORDER BY b.deskripsi) - 1, DENSE_RANK() OVER (ORDER BY b.jn) - 1,
           DENSE_RANK() OVER (ORDER BY b.md) - 1
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
              CROSS JOIN (SELECT DAY(MAX(tanggal)) AS hari, YEAR(MAX(tanggal)) AS y, MONTH(MAX(tanggal)) AS m FROM sales_toko) bl
             WHERE s.ket = 'closing' AND s.tahun = bl.y AND s.bulan = bl.m
             GROUP BY s.kode, TRIM(s.deskripsi), bl.hari
          ) q ON q.kode = st.kode AND q.deskripsi = TRIM(st.deskripsi)
          LEFT JOIN (
            SELECT z.nk, z.nd, z.modis
              FROM (SELECT y.nk, y.nd, y.modis, ROW_NUMBER() OVER (PARTITION BY y.nk, y.nd ORDER BY y.id) AS rn
                      FROM (SELECT id, ${NORMSQL('kode')} AS nk, ${NORMSQL('deskripsi')} AS nd, modis
                              FROM modis WHERE ${NZ('modis')} <> '') y) z
             WHERE z.rn = 1
          ) md ON md.nk = ${NORMSQL('st.kode')} AND md.nd = ${NORMSQL('st.deskripsi')}
         WHERE st.tanggal = (SELECT MAX(tanggal) FROM stock)
      ) b`,
};

const TABLES = ['mv_dates', 'mv_ks', 'mv_mon_list', 'mv_tgl', 'mv_mon_rows', 'mv_mon_same', 'mv_stock_idx'];

export async function refreshStep(db, step) {
  if (!Number.isInteger(step) || step < 0 || step >= STEPS) throw Object.assign(new Error('Langkah tidak dikenal.'), { status: 400 });
  await db.exec(`TRUNCATE TABLE ${TABLES[step]}`);
  if (step === 4 || step === 5) {
    const months = await db.query('SELECT mi FROM mv_mon_list ORDER BY mi');
    const sql = step === 4 ? SQL.monRows : SQL.monSame;
    for (const m of months) await db.exec(sql, [num(m.mi)]);
    return;
  }
  await db.exec([SQL.dates, SQL.ks, SQL.monList, SQL.tgl, null, null, SQL.stockIdx][step]);
}

const pad = (n) => String(n).padStart(2, '0');
export const stamp = () => {
  const j = new Date(Date.now() + 7 * 3600 * 1000);
  return `${pad(j.getUTCDate())}/${pad(j.getUTCMonth() + 1)}/${j.getUTCFullYear()} ${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}`;
};

export const refreshHandlers = {
  // adminRefresh(token, langkah) -> { langkah, total, pesan }   token lama diabaikan (identitas dari cookie sesi)
  adminrefresh: {
    need: 'edit',
    async run({ db }, a) {
      const s = Number.parseInt(a[1], 10);
      await refreshStep(db, s);
      if (s === STEPS - 1) await touchUpdated(db, 'refresh');   // langkah terakhir selesai
      return { langkah: s, total: STEPS, pesan: 'Ringkasan diperbarui ' + stamp() };
    },
  },
};
