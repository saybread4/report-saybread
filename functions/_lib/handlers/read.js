// Fungsi baca yang dipindah dari Supabase (api_get*). Bentuk hasil SAMA dengan fungsi lama;
// yang berbeda: pembatasan area dilakukan di server (scopedKs / allowedNorm), bukan token browser.
import { isPusat } from '../auth.js';
import { bamWhere } from '../scope.js';
import { lastUpdated } from '../dataupdates.js';
import { norm, nz, num } from '../util.js';
import {
  arr, str, ymd, NORM, inList, rnd, chunks, queryAll, allowedNorm, scopedKs, datesInfo, tglRows, overrides, tokoMap,
} from '../ks.js';

const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const pad = (n) => String(n).padStart(2, '0');
const dmy = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : null);
const parts = (d) => ({ y: +d.slice(0, 4), m: +d.slice(5, 7), d: +d.slice(8, 10) });

// Waktu UTC dari DATETIME TiDB -> 'DD/MM/YYYY HH:MM' Asia/Jakarta (UTC+7)
function jakarta(v) {
  if (v == null) return null;
  const dt = v instanceof Date ? v : new Date(String(v).replace(' ', 'T').replace(/Z?$/, 'Z'));
  if (Number.isNaN(dt.getTime())) return null;
  const j = new Date(dt.getTime() + 7 * 3600 * 1000);
  return `${pad(j.getUTCDate())}/${pad(j.getUTCMonth() + 1)}/${j.getUTCFullYear()} ${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}`;
}

// Setara v_sales_bulan: bulan & hari dari tanggal sales terakhir.
async function salesBulan(db) {
  const r = (await db.query('SELECT MAX(tanggal) AS m FROM sales_toko'))[0];
  const m = r && r.m ? ymd(r.m) : '';
  if (!m) return { akhir: '', awal: '', hari: null, bulan: null, tahun: null };
  const p = parts(m);
  return { akhir: m, awal: `${m.slice(0, 8)}01`, hari: p.d, bulan: p.m, tahun: p.y };
}

const selFilter = (ks, pn, cb) => {
  const P = arr(pn).map(str), C = arr(cb).map(str);
  return ks.filter((r) => (!P.length || P.includes(r.cabpnl)) && (!C.length || C.includes(r.cabang)));
};

// ---- Stock (mv_stock_idx) dengan indeks disusun ulang sesuai area -------------------------------
const DIM = [['cab', 'cab', 'i_cab'], ['bas', 'bas', 'i_bas'], ['as', 'as_', 'i_as'], ['tk', 'tk', 'i_tk'], ['ds', 'deskripsi', 'i_ds'], ['jn', 'jn', 'i_jn'], ['md', 'md', 'i_md']];

// light = true: hanya kolom angka/indeks (untuk getrows). Teks panjang (deskripsi, tk JSON, dll.) tidak dibawa, karena getrows
// hanya memetakan ulang indeks; ini memangkas memori/CPU Worker secara besar-besaran pada tabel stock yang ratusan ribu baris
// (batas memori Cloudflare yang terlampaui membuat SEMUA permintaan yang sedang berjalan gagal dengan HTTP 503).
async function stockScoped(db, user, light = false) {
  const [rows, ok] = await Promise.all([
    db.query(light
      ? 'SELECT kode, qty, qpd, i_cab, i_bas, i_as, i_tk, i_ds, i_jn, i_md FROM mv_stock_idx'
      : 'SELECT kode, deskripsi, cab, bas, as_, tk, jn, qty, qpd, md, i_cab, i_bas, i_as, i_tk, i_ds, i_jn, i_md FROM mv_stock_idx'),
    allowedNorm(db, user),
  ]);
  const keep = ok === null ? rows : rows.filter((r) => ok.has(norm(r.kode)));
  if (light) return keep;
  return keep.map((r) => {
    let tk = r.tk;
    if (typeof tk === 'string') { try { tk = JSON.parse(tk); } catch { tk = [tk]; } }
    return { ...r, tk };
  });
}

// Indeks lama bisa berlubang setelah disaring per area, jadi dipetakan ulang 0..n-1 (urutan asli dipertahankan).
function dimMaps(rows) {
  const out = {};
  for (const [name, col, icol] of DIM) {
    const seen = new Map();
    for (const r of rows) { const k = num(r[icol]); if (!seen.has(k)) seen.set(k, r[col]); }
    const keys = [...seen.keys()].sort((a, b) => a - b);
    out[name] = { values: keys.map((k) => seen.get(k)), remap: new Map(keys.map((k, i) => [k, i])) };
  }
  return out;
}

// Toko dalam area pengguna, langsung dari tabel toko.
async function tokoScoped(db, user) {
  const w = bamWhere(user, 'bam');
  return queryAll(db, `SELECT kode, toko, bas, bastr, am, \`as\` AS as_, cabang FROM toko WHERE ${w.sql}`, w.params, 'kode, toko');
}

// Tambahkan toko dari tabel toko ke kamus d (cab/bas/as/tk) dan kembalikan satu baris per toko: [cab, bas, as, tk].
// Toko yang sudah ada di kamus (lewat norm(kode)) memakai indeks yang sama; nilai baru ditambahkan di belakang.
function storeRows(d, toko) {
  const idx = (name) => {
    const m = new Map();
    d[name].forEach((v, i) => { const k = name === 'tk' ? norm(v[0]) : String(v); if (!m.has(k)) m.set(k, i); });
    return (key, make) => {
      let i = m.get(key);
      if (i === undefined) { i = d[name].length; d[name].push(make()); m.set(key, i); }
      return i;
    };
  };
  const cab = idx('cab'), bas = idx('bas'), as = idx('as'), tk = idx('tk');
  const out = [];
  for (const t of toko) {
    const k = norm(t.kode);
    if (!k) continue;
    const c = nz(t.cabang), b = nz(t.bas), a = nz(t.as_);
    out.push([cab(c, () => c), bas(b, () => b), as(a, () => a), tk(k, () => [t.kode, nz(t.toko), nz(t.am), nz(t.bastr)])]);
  }
  return out;
}

// ---- Rank: penjumlahan per grup & tanggal ------------------------------------------------------
// Dikerjakan di DATABASE (GROUP BY), jadi yang dikirim ke server hanya ribuan baris ringkasan, bukan ratusan ribu
// baris harian. Toko dicocokkan lewat kode persis (mv_ks) dan atribut BAS/BASTR/AM/AS lewat norm(kode).
const RANK_G = ['cab', 'pnl', 'bas', 'bastr', 'am', 'as'];
const rankLabel = (c) => `CASE WHEN ${c} IS NULL OR TRIM(${c}) IN ('', '0') THEN '(kosong)' ELSE TRIM(${c}) END`;

async function rankAggSql(db, user, G, names, dt, wantNorm) {
  const where = [], params = [];
  if (wantNorm) { where.push(`${NORM('k.cabang')} IN (${wantNorm.length ? wantNorm.map(() => '?').join(',') : "''"})`); params.push(...wantNorm); }
  if (!isPusat(user)) {
    const w = bamWhere(user, 'x.bam');
    where.push(`${NORM('k.kode')} IN (SELECT ${NORM('x.kode')} FROM toko x WHERE ${w.sql})`);
    params.push(...w.params);
  }
  // Atribut tiap toko (label cabang/PNL/BAS/...) dihitung SEKALI per toko di tabel turunan `s` (~12 ribu baris), lalu digabung ke mv_tgl
  // dengan kode persis. Dulu norm(kode) (REGEXP) dihitung untuk setiap baris harian (ratusan ribu x 6 query) -> sangat berat dan rawan gagal/timeout.
  const stores = `SELECT k.kode AS kode, ${rankLabel('k.cabang')} AS cab, ${rankLabel('k.cabpnl')} AS pnl,
        ${rankLabel('o.bas')} AS bas, ${rankLabel('o.bastr')} AS bastr, ${rankLabel('o.am')} AS am, ${rankLabel('o.as_')} AS as_
      FROM mv_ks k
      LEFT JOIN (SELECT ${NORM('kode')} AS nk, MIN(bas) AS bas, MIN(bastr) AS bastr, MIN(am) AS am, MIN(\`as\`) AS as_
                   FROM toko GROUP BY ${NORM('kode')}) o ON o.nk = ${NORM('k.kode')}
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  const col = { cab: 'cab', pnl: 'pnl', bas: 'bas', bastr: 'bastr', am: 'am', as: 'as_' };
  const sql = (g) => `SELECT s.${col[g]} AS grp, t.tanggal AS tgl, SUM(t.qty) AS q, SUM(t.rp) AS rp, SUM(t.barp) AS b,
        COUNT(*) AS n, SUM(CASE WHEN t.qty > 0 THEN 1 ELSE 0 END) AS nq
      FROM mv_tgl t
      JOIN (${stores}) s ON s.kode = t.kode
     GROUP BY s.${col[g]}, t.tanggal`;
  const agg = {};
  await Promise.all(G.map(async (g) => {
    const m = new Map();
    let rows = await db.query(sql(g), params);
    if (rows.length >= 10000) rows = await queryAll(db, sql(g), params, 'grp, tgl');   // hasil mungkin terpotong di 10.000 baris: baca ulang per halaman
    for (const r of rows) {
      const gi = names[g].get(r.grp), di = dt.di.get(ymd(r.tgl));
      if (gi === undefined || di === undefined) continue;
      m.set(gi * 100000 + di, [gi, di, num(r.q), num(r.rp), num(r.b), num(r.n), num(r.nq)]);
    }
    agg[g] = m;
  }));
  return agg;
}

// Cara lama (cadangan): ambil semua baris harian lalu jumlahkan di server. Toko dicocokkan lewat norm(kode),
// sehingga spasi/huruf berbeda pada kode tidak membuat baris terlewat.
async function rankAggJs(db, stores, G, names, dt) {
  const byNorm = new Map(stores.map((s) => [norm(s.kode), s]));
  const agg = {};
  for (const g of G) agg[g] = new Map();
  for (const v of await tglRows(db, stores.map((s) => s.kode), { cols: 'kode, tanggal, qty, rp, barp' })) {
    const di = dt.di.get(ymd(v.tanggal)); if (di === undefined) continue;
    const s = byNorm.get(norm(v.kode)); if (!s) continue;
    for (const g of G) {
      const gi = names[g].get(s.g[g]), key = gi * 100000 + di;
      const x = agg[g].get(key) || [gi, di, 0, 0, 0, 0, 0];
      x[2] += num(v.qty); x[3] += num(v.rp); x[4] += num(v.barp); x[5] += 1; if (num(v.qty) > 0) x[6] += 1;
      agg[g].set(key, x);
    }
  }
  return agg;
}

export const readHandlers = {
  // ---- Peta cabang / toko -----------------------------------------------------------------
  getcabmeta: {
    need: 'view',
    async run({ db, user }) {
      const ks = await scopedKs(db, user);
      const pnl = [], cab = [], pi = new Map(), ci = new Map();
      for (const r of ks) {
        if (!pi.has(r.cabpnl)) { pi.set(r.cabpnl, pnl.length); pnl.push(r.cabpnl); }
        if (!ci.has(r.cabang)) { ci.set(r.cabang, cab.length); cab.push(r.cabang); }
      }
      const seen = new Set();
      const pairs = [];
      for (const r of ks) {
        const k = pi.get(r.cabpnl) * 100000 + ci.get(r.cabang);
        if (!seen.has(k)) { seen.add(k); pairs.push([pi.get(r.cabpnl), ci.get(r.cabang)]); }
      }
      pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      return { pnl, cab, pairs, stores: ks.map((r) => [r.kode, r.toko, pi.get(r.cabpnl), ci.get(r.cabang)]), warn: '' };
    },
  },

  // ---- Stock ------------------------------------------------------------------------------
  // Kamus filter + daftar toko. Daftar toko diambil dari TABEL TOKO (bukan dari data stock), jadi filter
  // Perform Toko / Monitor Area langsung terisi walau data stock belum diunggah. Isi kamus dari stock tetap
  // di posisi semula; entri yang hanya ada di tabel toko ditambahkan di belakangnya, sehingga indeks baris
  // dari getrows tidak berubah.
  getmeta: {
    need: 'view',
    async run({ db, user }) {
      const [rows, toko] = await Promise.all([stockScoped(db, user), tokoScoped(db, user)]);
      const maps = dimMaps(rows);
      const d = {};
      for (const [name] of DIM) d[name] = [...maps[name].values];
      const srows = storeRows(d, toko);
      const st = (await db.query('SELECT MAX(created_at) AS u, MAX(tanggal) AS t FROM stock'))[0] || {};
      const sb = await salesBulan(db);
      return {
        updated: jakarta((await lastUpdated(db)) || st.u),
        tgl: dmy(ymd(st.t)),
        d,
        srows,
        defaults: { jenis: 'DOUGH' },
        qpd: { bulan: sb.bulan, nama: sb.bulan ? BULAN[sb.bulan - 1] : null, hari: sb.hari },
        warn: '',
      };
    },
  },

  getrows: {
    need: 'view',
    async run({ db, user }) {
      const rows = await stockScoped(db, user, true);
      const m = dimMaps(rows);
      const g = (n, r, c) => m[n].remap.get(num(r[c]));
      return rows.map((r) => [g('cab', r, 'i_cab'), g('bas', r, 'i_bas'), g('as', r, 'i_as'), g('tk', r, 'i_tk'),
        g('ds', r, 'i_ds'), g('jn', r, 'i_jn'), num(r.qty), rnd(r.qpd, 2), g('md', r, 'i_md')]);
    },
  },

  getstockfd: {
    need: 'view',
    async run({ db, user, }, a) {
      const ok = await allowedNorm(db, user);
      let kodes = [...new Set(arr(a[0]).map((x) => str(x).trim().toUpperCase()).filter(Boolean))];
      if (ok !== null) kodes = kodes.filter((k) => ok.has(norm(k)));
      const dari = a[1] ? String(a[1]).slice(0, 10) : '';
      const jenis = str(a[2]).trim().toUpperCase();
      const acc = new Map();
      for (const part of chunks(kodes)) {
        const w = inList('UPPER(TRIM(kode))', part);
        let sql = `SELECT tanggal, SUM(stock_total) AS total FROM stock_toko WHERE ${w.sql}`;
        const params = [...w.params];
        if (dari) { sql += ' AND tanggal >= ?'; params.push(dari); }
        if (jenis) { sql += ' AND UPPER(TRIM(jenis)) = ?'; params.push(jenis); }
        sql += ' GROUP BY tanggal';
        for (const r of await db.query(sql, params)) acc.set(ymd(r.tanggal), (acc.get(ymd(r.tanggal)) || 0) + num(r.total));
      }
      return { stock: Object.fromEntries(acc) };
    },
  },

  getexcelfd: {
    need: 'view',
    async run({ db, user }, a) {
      const bamN = norm(a[0]);
      const empty = { tgl: null, awal: null, akhir: null, items: [], stores: [], cells: [] };
      if (!isPusat(user) && !(user.bam_scope || []).map(norm).includes(bamN)) return empty;
      const toko = await queryAll(db, 'SELECT kode, toko, cabang, cab_pnl, bam FROM toko', [], 'kode, toko');
      const t = toko.filter((r) => norm(r.bam) === bamN)
        .map((r) => ({ kode: r.kode, toko: nz(r.toko), cabang: nz(r.cabang), pnl: nz(r.cab_pnl) }));
      const mx = (await db.query('SELECT MAX(tanggal) AS d FROM stock'))[0];
      const tgl = mx && mx.d ? ymd(mx.d) : '';
      const sb = await salesBulan(db);
      const items = await db.query('SELECT kirim, plu, plu_jual, deskripsi FROM item');
      const itemBy = new Map(items.map((i) => [i.plu, i]));
      const norms = [...new Set(t.map((x) => norm(x.kode)))];
      const stock = new Map();      // norm(kode) -> Map(plu -> qty)
      if (tgl && norms.length) {
        for (const part of chunks(norms)) {
          const w = inList(NORM('kode'), part);
          const rows = await db.query(`SELECT kode, plu, SUM(stock_qty) AS q FROM stock WHERE tanggal = ? AND ${w.sql} GROUP BY kode, plu`, [tgl, ...w.params]);
          for (const r of rows) {
            const k = norm(r.kode);
            if (!stock.has(k)) stock.set(k, new Map());
            const m = stock.get(k); m.set(r.plu, (m.get(r.plu) || 0) + num(r.q));
          }
        }
      }
      const sales = new Map();      // kode -> Map(deskripsi -> qty)
      if (sb.tahun && t.length) {
        for (const part of chunks(t.map((x) => x.kode))) {
          const w = inList('kode', part);
          const rows = await db.query(
            `SELECT kode, TRIM(deskripsi) AS d, SUM(sales_qty) AS q FROM sales_item
              WHERE ket = 'closing' AND tahun = ? AND bulan = ? AND ${w.sql} GROUP BY kode, TRIM(deskripsi)`,
            [sb.tahun, sb.bulan, ...w.params]);
          for (const r of rows) {
            if (!sales.has(r.kode)) sales.set(r.kode, new Map());
            sales.get(r.kode).set(r.d, num(r.q));
          }
        }
      }
      // pengiriman (kirim) terbanyak per toko, dari PLU yang ada di stock
      const kirimOf = new Map();
      for (const x of t) {
        const cnt = new Map();
        for (const plu of (stock.get(norm(x.kode)) || new Map()).keys()) {
          const it = itemBy.get(plu);
          if (it) cnt.set(it.kirim, (cnt.get(it.kirim) || 0) + 1);
        }
        const best = [...cnt].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1))[0];
        if (best) kirimOf.set(x.kode, best[0]);
      }
      const byKirim = new Map();
      for (const i of items) { if (!byKirim.has(i.kirim)) byKirim.set(i.kirim, []); byKirim.get(i.kirim).push(i); }
      const cells = [];
      for (const x of t) {
        const kr = kirimOf.get(x.kode);
        if (kr === undefined) continue;
        const sm = stock.get(norm(x.kode)) || new Map(), lm = sales.get(x.kode) || new Map();
        for (const i of byKirim.get(kr) || []) {
          const stq = sm.get(i.plu) || 0, slq = lm.get(str(i.deskripsi).trim()) || 0;
          if (stq !== 0 || slq !== 0) cells.push([x.kode, i.plu, stq, slq]);
        }
      }
      const cmp = (p, q) => (p < q ? -1 : p > q ? 1 : 0);
      const stores = [...t].sort((p, q) => cmp(p.pnl, q.pnl) || cmp(p.cabang, q.cabang) || cmp(p.kode, q.kode))
        .map((x) => [x.kode, x.toko, x.cabang, x.pnl, kirimOf.get(x.kode) || '']);
      return {
        tgl: tgl || null, awal: sb.awal || null, akhir: sb.akhir || null,
        items: items.map((i) => [i.kirim, i.plu, i.plu_jual, i.deskripsi]), stores, cells,
      };
    },
  },

  // ---- Perform per tanggal ----------------------------------------------------------------
  gettanggal: {
    need: 'view',
    async run({ db, user }, a) {
      const want = norm(a[0]);
      const ks = (await scopedKs(db, user)).filter((r) => norm(r.kode) === want);
      const dt = await datesInfo(db);
      let rows = [];
      if (ks.length) {
        const tg = await tglRows(db, ks.map((r) => r.kode));
        rows = tg.map((v) => [dt.di.get(ymd(v.tanggal)), num(v.stock_qty), num(v.prod), num(v.qty), num(v.rp), num(v.mg), num(v.baq), num(v.barp)])
          .filter((r) => r[0] !== undefined).sort((x, y) => x[0] - y[0]);
      }
      return { dates: dt.list, found: ks.length > 0, warn: '', rows };
    },
  },

  gettanggalcab: {
    need: 'view',
    async run({ db, user }, a) {
      const sel = selFilter(await scopedKs(db, user), a[0], a[1]);
      const dt = await datesInfo(db);
      const g = new Map();
      for (const v of await tglRows(db, sel.map((r) => r.kode))) {
        const di = dt.di.get(ymd(v.tanggal)); if (di === undefined) continue;
        const x = g.get(di) || [di, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        x[1] += num(v.stock_qty); x[2] += num(v.prod); x[3] += num(v.qty); x[4] += num(v.rp);
        x[5] += num(v.mg); x[6] += num(v.baq); x[7] += num(v.barp); x[8] += 1; if (num(v.qty) > 0) x[9] += 1;
        g.set(di, x);
      }
      const rows = [...g.values()].sort((p, q) => p[0] - q[0]);
      return { dates: dt.list, found: rows.length > 0, warn: '', ns: sel.length, rows };
    },
  },

  gettglmentah: {
    need: 'view',
    async run({ db, user }, a) {
      const want = new Set(arr(a[0]).map(norm).filter(Boolean));
      const [all, tk, dt] = await Promise.all([scopedKs(db, user), tokoMap(db), datesInfo(db)]);
      const k = all.filter((r) => !want.size || want.has(norm(r.kode)));
      const li = new Map(k.map((r, i) => [r.kode, i]));
      const tg = await tglRows(db, k.map((r) => r.kode));
      const rows = [];
      for (const v of tg) {
        const di = dt.di.get(ymd(v.tanggal)); if (di === undefined) continue;
        rows.push([li.get(v.kode), di, num(v.stock_qty), num(v.prod), num(v.qty), num(v.rp), num(v.mg), num(v.baq), num(v.barp)]);
      }
      return {
        dates: dt.list,
        ks: k.map((r) => [r.kode, r.toko, r.cabang, r.cabpnl, nz((tk.get(norm(r.kode)) || {}).bas)]),
        rows, warn: '',
      };
    },
  },

  // ---- Rank -------------------------------------------------------------------------------
  getbasdata: {
    need: 'view',
    async run({ db, user }, a) {
      const want = new Set(arr(a[0]).map(norm));
      const k = (await scopedKs(db, user)).filter((r) => want.has(norm(r.kode)));
      const li = new Map(k.map((r, i) => [r.kode, i]));
      const dt = await datesInfo(db);
      const rows = [];
      for (const v of await tglRows(db, k.map((r) => r.kode))) {
        const di = dt.di.get(ymd(v.tanggal)); if (di === undefined) continue;
        rows.push([li.get(v.kode), di, num(v.qty), num(v.rp), num(v.baq), num(v.barp), num(v.prod), num(v.mg)]);
      }
      return { dates: dt.list, ks: k.map((r) => [r.kode, r.toko]), rows, found: rows.length > 0, warn: '', ovr: await overrides(db, 'rank_override') };
    },
  },

  // Penjualan per item dibagi ke tanggal menurut porsi sales harian toko (sama dengan versi Supabase).
  getbasdataitem: {
    need: 'view',
    async run({ db, user }, a) {
      const want = new Set(arr(a[0]).map(norm));
      const ds = [...new Set(arr(a[1]).map((x) => str(x).trim()))];
      const k = (await scopedKs(db, user)).filter((r) => want.has(norm(r.kode)));
      const li = new Map(k.map((r, i) => [r.kode, i]));
      const dt = await datesInfo(db);
      const kodes = k.map((r) => r.kode);
      const out = { dates: dt.list, ks: k.map((r) => [r.kode, r.toko]), rows: [], found: false, warn: '', ovr: await overrides(db, 'rank_override') };
      if (!kodes.length || !ds.length) return out;

      const sel = new Map();   // kode|y|b|ket -> jumlah
      for (const part of chunks(kodes, 500)) {
        const w1 = inList('kode', part), w2 = inList('TRIM(deskripsi)', ds);
        const rows = await db.query(
          `SELECT kode, tahun, bulan, ket, SUM(sales_qty) AS qty, SUM(sales_rp) AS rp, SUM(ba_qty) AS baq, SUM(ba_rp) AS barp,
                  SUM(produksi) AS prod, SUM(margin) AS mg
             FROM sales_item WHERE ${w1.sql} AND ${w2.sql} GROUP BY kode, tahun, bulan, ket`, [...w1.params, ...w2.params]);
        for (const r of rows) sel.set(`${r.kode}|${num(r.tahun)}|${num(r.bulan)}|${r.ket}`, r);
      }
      const tm = new Set((await db.query("SELECT DISTINCT tahun, bulan FROM sales_item WHERE ket = 'tgl_yang_sama'")).map((r) => `${num(r.tahun)}|${num(r.bulan)}`));
      const hr = (await salesBulan(db)).hari;
      const F = ['qty', 'rp', 'baq', 'barp', 'prod', 'mg'];
      const dz = [];
      for (const part of chunks(kodes, 500)) {
        const w = inList('kode', part);
        for (const st of await queryAll(db, `SELECT tanggal, kode, sales_qty FROM sales_toko WHERE ${w.sql}`, w.params, 'kode, tanggal')) {
          const d = ymd(st.tanggal), di = dt.di.get(d); if (di === undefined) continue;
          const p = parts(d);
          const c = sel.get(`${st.kode}|${p.y}|${p.m}|closing`); if (!c) continue;
          const t = sel.get(`${st.kode}|${p.y}|${p.m}|tgl_yang_sama`);
          const sg = !tm.has(`${p.y}|${p.m}`) ? 'x' : p.d <= hr ? 'a' : 'b';
          dz.push({ li: li.get(st.kode), di, kode: st.kode, y: p.y, m: p.m, sg, w: Math.max(num(st.sales_qty), 0), c, t });
        }
      }
      const grp = new Map();
      for (const z of dz) {
        const key = `${z.kode}|${z.y}|${z.m}|${z.sg}`;
        const g = grp.get(key) || { ws: 0, n: 0 }; g.ws += z.w; g.n += 1; grp.set(key, g);
      }
      const dec = { qty: 4, rp: 2, baq: 4, barp: 2, prod: 4, mg: 2 };
      for (const z of dz) {
        const g = grp.get(`${z.kode}|${z.y}|${z.m}|${z.sg}`);
        const sh = g.ws > 0 ? z.w / g.ws : 1 / g.n;
        if (!(sh > 0)) continue;
        const v = F.map((f) => {
          const cv = num(z.c[f]), tv = z.t ? num(z.t[f]) : 0;
          const base = z.sg === 'a' ? tv : z.sg === 'b' ? cv - tv : cv;
          return rnd(base * sh, dec[f]);
        });
        out.rows.push([z.li, z.di, ...v]);
      }
      out.found = out.rows.length > 0;
      return out;
    },
  },

  getrankcab: {
    need: 'view',
    async run({ db, user }, a) {
      const wantRaw = arr(a[0]);
      const allsc = wantRaw.length === 0;          // "semua" = semua toko di area pengguna
      const want = new Set(wantRaw.map(norm));
      const [ks, tk, dt] = await Promise.all([scopedKs(db, user), tokoMap(db), datesInfo(db)]);
      const lab = (x) => (nz(x) === '' ? '(kosong)' : nz(x));
      const G = ['cab', 'pnl', 'bas', 'bastr', 'am', 'as'];
      const stores = [];
      for (const v of ks) {
        if (!(allsc || want.has(norm(v.cabang)))) continue;
        const t = tk.get(norm(v.kode)) || {};
        stores.push({
          ki: v.ki, kode: v.kode,
          g: { cab: v.cabang === '' ? '(kosong)' : v.cabang, pnl: v.cabpnl === '' ? '(kosong)' : v.cabpnl,
            bas: lab(t.bas), bastr: lab(t.bastr), am: lab(t.am), as: lab(t.as_) },
        });
      }
      // indeks nama per dimensi: urut (ki terkecil, nama)
      const names = {}, minKi = {};
      for (const g of G) { names[g] = new Map(); minKi[g] = new Map(); }
      for (const s of stores) for (const g of G) {
        const n = s.g[g];
        if (!minKi[g].has(n) || s.ki < minKi[g].get(n)) minKi[g].set(n, s.ki);
      }
      const order = {};
      for (const g of G) {
        const list = [...minKi[g]].sort((p, q) => p[1] - q[1] || (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0)).map((x) => x[0]);
        order[g] = list; list.forEach((n, i) => names[g].set(n, i));
      }
      const wantNorm = allsc ? null : [...want];
      let agg;
      try {
        agg = await rankAggSql(db, user, G, names, dt, wantNorm);
      } catch (e) {                                   // jaga-jaga: bila SQL agregasi gagal, pakai cara lama (lebih berat)
        console.error('agregasi Rank di database gagal, memakai cara lama', e);
        try { agg = await rankAggJs(db, stores, G, names, dt); }
        catch (e2) { throw new Error('Rank gagal. SQL agregasi: ' + String((e && e.message) || e).slice(0, 200) + ' | cara lama: ' + String((e2 && e2.message) || e2).slice(0, 120)); }
      }
      const out = { dates: dt.list, warn: '', ovr: await overrides(db, 'rank_override') };
      for (const g of G) out[g] = { names: order[g], rows: [...agg[g].values()].sort((p, q) => p[0] - q[0] || p[1] - q[1]) };
      return out;
    },
  },

  // ---- Monitor ----------------------------------------------------------------------------
  getmonitor: {
    need: 'view',
    async run({ db, user }, a) {
      const want = norm(a[0]);
      const empty = { months: [], ds: [], rows: [], same: [], warn: '' };
      const months = await monthList(db);
      const ks = (await scopedKs(db, user)).filter((r) => norm(r.kode) === want);
      if (!ks.length) return { ...empty, months };
      const q = (t) => db.query(`SELECT ds, mi, prod, qty, rp, baq, barp FROM ${t} WHERE knorm = ?`, [want]);
      const [r, rs] = await Promise.all([q('mv_mon_rows'), q('mv_mon_same')]);
      const first = new Map();
      for (const x of r) { const m = num(x.mi); if (!first.has(x.ds) || m < first.get(x.ds)) first.set(x.ds, m); }
      const ds = [...first].sort((p, q2) => p[1] - q2[1] || (p[0] < q2[0] ? -1 : p[0] > q2[0] ? 1 : 0)).map((x) => x[0]);
      const di = new Map(ds.map((d, i) => [d, i]));
      const shape = (rows) => rows.filter((x) => di.has(x.ds))
        .map((x) => [0, di.get(x.ds), num(x.mi), num(x.prod), num(x.qty), num(x.rp), num(x.baq), num(x.barp)])
        .sort((p, q2) => p[1] - q2[1] || p[2] - q2[2]);
      return { months, ds, rows: shape(r), same: shape(rs), warn: '' };
    },
  },

  getmonitorcab: {
    need: 'view',
    async run({ db, user }, a) {
      const sel = selFilter(await scopedKs(db, user), a[0], a[1]);
      const months = await monthList(db);
      const kodes = sel.map((r) => r.kode);
      const ki = new Map(sel.map((r) => [r.kode, r.ki]));
      const sum = (rows) => rows.map((x) => ({ ds: x.ds, mi: num(x.mi), prod: num(x.prod), qty: num(x.qty), rp: num(x.rp), baq: num(x.baq), barp: num(x.barp) }));
      const g = [], gs = [], first = new Map();
      for (const part of chunks(kodes)) {
        const w = inList('kode', part);
        const sql = (t) => `SELECT ds, mi, SUM(prod) AS prod, SUM(qty) AS qty, SUM(rp) AS rp, SUM(baq) AS baq, SUM(barp) AS barp FROM ${t} WHERE ${w.sql} GROUP BY ds, mi`;
        g.push(...sum(await db.query(sql('mv_mon_rows'), w.params)));
        gs.push(...sum(await db.query(sql('mv_mon_same'), w.params)));
        // urutan baris: ki toko terkecil, lalu bulan terkecil, lalu nama
        for (const x of await db.query(`SELECT ds, kode, MIN(mi) AS fmi FROM mv_mon_rows WHERE ${w.sql} GROUP BY ds, kode`, w.params)) {
          const cur = first.get(x.ds) || { fki: Infinity, fmi: Infinity };
          first.set(x.ds, { fki: Math.min(cur.fki, ki.get(x.kode)), fmi: Math.min(cur.fmi, num(x.fmi)) });
        }
      }
      // gabungkan hasil antar-potongan (kalau kode > 2000)
      const merge = (rows) => {
        const m = new Map();
        for (const x of rows) {
          const k = `${x.ds}|${x.mi}`, c = m.get(k);
          if (!c) m.set(k, { ...x }); else for (const f of ['prod', 'qty', 'rp', 'baq', 'barp']) c[f] += x[f];
        }
        return [...m.values()];
      };
      const G = merge(g), GS = merge(gs);
      const ds = [...first].sort((p, q) => p[1].fki - q[1].fki || p[1].fmi - q[1].fmi || (p[0] < q[0] ? -1 : 1)).map((x) => x[0]);
      const di = new Map(ds.map((d, i) => [d, i]));
      const shape = (rows) => rows.filter((x) => di.has(x.ds))
        .map((x) => [0, di.get(x.ds), x.mi, x.prod, x.qty, x.rp, x.baq, x.barp]).sort((p, q) => p[1] - q[1] || p[2] - q[2]);
      return { months, ds, rows: shape(G), same: shape(GS), warn: '' };
    },
  },

  // ---- Trend / histori --------------------------------------------------------------------
  gettrend: {
    need: 'view',
    async run({ db, user }, a) {
      const want = norm(a[0]);
      const ok = await allowedNorm(db, user);
      if (!want || (ok !== null && !ok.has(want))) return { found: false, warn: '', rows: [] };
      const rows = await db.query(
        `SELECT tahun, bulan, jml_hari, produksi, sales_qty, sales_rp, margin, ba_qty, ba_rp FROM trend WHERE ${NORM('kode')} = ?`, [want]);
      const g = new Map();
      for (const r of rows) {
        const k = num(r.tahun) * 100 + num(r.bulan);
        const x = g.get(k) || [num(r.tahun), num(r.bulan), 0, 0, 0, 0, 0, 0, 0];
        x[2] = Math.max(x[2], num(r.jml_hari)); x[3] += num(r.produksi); x[4] += num(r.sales_qty); x[5] += num(r.sales_rp);
        x[6] += num(r.margin); x[7] += num(r.ba_qty); x[8] += num(r.ba_rp);
        g.set(k, x);
      }
      return { found: g.size > 0, warn: '', rows: [...g].sort((p, q) => p[0] - q[0]).map((x) => x[1]) };
    },
  },

  gethistori: {
    need: 'view',
    async run({ db, user }, a) {
      const rows = await trendRows(db, user, a, 'tahun, bulan, kode, jml_hari, produksi, sales_qty, sales_rp, margin, ba_qty, ba_rp');
      const g = new Map();
      for (const r of rows) {
        const k = num(r.tahun) * 100 + num(r.bulan);
        const x = g.get(k) || { y: num(r.tahun), b: num(r.bulan), kodes: new Set(), hr: 0, pr: 0, qy: 0, rp: 0, mg: 0, bq: 0, br: 0 };
        x.kodes.add(r.kode); x.hr += num(r.jml_hari); x.pr += num(r.produksi); x.qy += num(r.sales_qty);
        x.rp += num(r.sales_rp); x.mg += num(r.margin); x.bq += num(r.ba_qty); x.br += num(r.ba_rp);
        g.set(k, x);
      }
      return { rows: [...g].sort((p, q) => p[0] - q[0]).map(([, x]) => [x.y, x.b, x.kodes.size, x.hr, x.pr, x.qy, x.rp, x.mg, x.bq, x.br]) };
    },
  },

  gethistory: {
    need: 'view',
    async run({ db, user }, a) {
      const f = await trendRows(db, user, a, 'tahun, bulan, cab_pnl, cabang, kode, toko, jml_hari, sales_qty, sales_rp, ba_rp, margin, pnl');
      const nc = new Set(f.map((r) => norm(r.cabang))).size, nk = new Set(f.map((r) => norm(r.kode))).size;
      const dim = nc > 1 ? 'cab' : nk > 1 ? 'tk' : '';
      // agregat per bulan
      const ag = new Map(), pcg = new Map(), rk = new Map();
      for (const r of f) {
        const k = num(r.tahun) * 100 + num(r.bulan);
        const x = ag.get(k) || { y: num(r.tahun), b: num(r.bulan), rp: 0, hr: 0, ba: 0, kn: new Set(), qy: 0, mg: 0, pn: 0 };
        x.rp += num(r.sales_rp); x.hr += num(r.jml_hari); x.ba += num(r.ba_rp); x.qy += num(r.sales_qty); x.mg += num(r.margin); x.pn += num(r.pnl);
        if (num(r.sales_rp) > 0) x.kn.add(r.kode);
        ag.set(k, x);
        const pk = `${k}|${r.kode}`; pcg.set(pk, (pcg.get(pk) || 0) + num(r.pnl));
        if (dim) {
          const nm = dim === 'cab' ? r.cabang : r.toko, kd = dim === 'cab' ? '' : r.kode;
          const rkk = `${nm}\u0001${kd}\u0001${k}`;
          const y = rk.get(rkk) || { nm, kd, y: num(r.tahun), b: num(r.bulan), rp: 0, hr: 0, ba: 0 };
          y.rp += num(r.sales_rp); y.hr += num(r.jml_hari); y.ba += num(r.ba_rp); rk.set(rkk, y);
        }
      }
      const pc = new Map();
      for (const [pk, s] of pcg) {
        const k = +pk.split('|')[0], x = pc.get(k) || { gp: 0, gm: 0 };
        if (s > 0) x.gp += 1; else if (s < 0) x.gm += 1;
        pc.set(k, x);
      }
      const rows = [...ag].sort((p, q) => p[0] - q[0]).map(([k, x]) =>
        [x.y, x.b, rnd(x.rp), x.hr, rnd(x.ba), x.kn.size, rnd(x.qy), rnd(x.mg), rnd(x.pn), (pc.get(k) || {}).gp || 0, (pc.get(k) || {}).gm || 0]);
      const rkOut = [...rk.values()].map((y) => [y.nm, y.kd, y.y, y.b, rnd(y.rp), y.hr, rnd(y.ba)]);

      // bulan berjalan (dari data harian) bila diminta dan lebih baru daripada trend terakhir
      let cur = null;
      if (a[3] === true || a[3] === 'true') {
        const lm = (await db.query('SELECT MAX(tahun * 100 + bulan) AS lm FROM trend'))[0];
        const mx = (await db.query('SELECT MAX(tanggal) AS m FROM mv_tgl'))[0];
        const md = mx && mx.m ? ymd(mx.m) : '';
        if (md && lm && lm.lm != null) {
          const p = parts(md);
          if (p.y * 100 + p.m > num(lm.lm)) {
            const P = arr(a[0]).map(norm).filter(Boolean), C = arr(a[1]).map(norm).filter(Boolean), K = arr(a[2]).map(norm).filter(Boolean);
            const ks = (await scopedKs(db, user)).filter((r) =>
              (!P.length || P.includes(norm(r.cabpnl))) && (!C.length || C.includes(norm(r.cabang))) && (!K.length || K.includes(norm(r.kode))));
            const info = new Map(ks.map((r) => [r.kode, r]));
            const cf = await tglRows(db, ks.map((r) => r.kode), { cols: 'kode, qty, rp, mg, barp', from: `${md.slice(0, 8)}01`, to: md });
            const sum = (fn) => cf.reduce((s, r) => s + fn(r), 0);
            const rkc = new Map();
            if (dim) for (const r of cf) {
              const k = info.get(r.kode); if (!k) continue;
              const nm = dim === 'cab' ? k.cabang : k.toko, kd = dim === 'cab' ? '' : r.kode, key = `${nm}\u0001${kd}`;
              const y = rkc.get(key) || { nm, kd, rp: 0, hr: 0, ba: 0 };
              y.rp += num(r.rp); if (num(r.qty) > 0) y.hr += 1; y.ba += num(r.barp); rkc.set(key, y);
            }
            for (const y of rkc.values()) rkOut.push([y.nm, y.kd, p.y, p.m, rnd(y.rp), y.hr, rnd(y.ba)]);
            cur = {
              th: p.y, bl: p.m, dt: p.d,
              x: [rnd(sum((r) => num(r.rp))), cf.filter((r) => num(r.qty) > 0).length, rnd(sum((r) => num(r.barp))),
                new Set(cf.filter((r) => num(r.rp) > 0).map((r) => r.kode)).size, rnd(sum((r) => num(r.qty))), rnd(sum((r) => num(r.mg)))],
            };
          }
        }
      }
      return { dim, ncab: nc, ntk: nk, rows, rk: rkOut, cur };
    },
  },

  // ---- Budged -----------------------------------------------------------------------------
  getbudged: {
    need: 'view',
    async run({ db, user }, a) {
      const sel = selFilter(await scopedKs(db, user), a[0], a[1]);
      const [tk, dt] = await Promise.all([tokoMap(db), datesInfo(db)]);
      const bl = new Map(), cl = new Map(), bn = [], cn = [];
      const st = sel.map((s) => {
        const b = nz((tk.get(norm(s.kode)) || {}).bas) || '(Tanpa BAS)', c = s.cabang || '(Tanpa Cabang)';
        if (!bl.has(b)) { bl.set(b, bn.length); bn.push(b); }
        if (!cl.has(c)) { cl.set(c, cn.length); cn.push(c); }
        return { kode: s.kode, bi: bl.get(b), ci: cl.get(c) };
      });
      const byKode = new Map(st.map((s) => [s.kode, s]));
      const rr = new Map();
      for (const v of await tglRows(db, st.map((s) => s.kode), { cols: 'kode, tanggal, rp, barp' })) {
        const s = byKode.get(v.kode), di = dt.di.get(ymd(v.tanggal)); if (!s || di === undefined) continue;
        const key = `${s.bi}|${s.ci}|${di}`, x = rr.get(key) || [s.bi, s.ci, di, 0, 0];
        x[3] += num(v.rp); x[4] += num(v.barp); rr.set(key, x);
      }
      const budRows = await db.query('SELECT cabang, bulan, tahun, budged FROM budged');
      const cnorm = new Map();
      cn.forEach((c, i) => { const n = norm(c); if (!cnorm.has(n)) cnorm.set(n, []); cnorm.get(n).push(i); });
      const bud = [];
      for (const b of budRows) {
        if (!(num(b.bulan) >= 1 && num(b.bulan) <= 12) || b.tahun == null || str(b.cabang) === '') continue;
        for (const ci of cnorm.get(norm(b.cabang)) || []) bud.push([ci, num(b.bulan), num(b.tahun), num(b.budged)]);
      }
      bud.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
      const hasBud = new Set(bud.map((x) => x[0]));
      return {
        dates: dt.list, bas: bn, cab: cn,
        rows: [...rr.values()].sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]),
        bud, nobud: cn.filter((_, i) => !hasBud.has(i)),
        warn: budRows.length ? '' : 'Tabel budged kosong, halaman Budged tidak akan tampil.',
      };
    },
  },

  getbudovr: { need: 'view', async run({ db }) { return overrides(db, 'budged_override'); } },

  // ---- Gempar (tanggal libur nasional/hari khusus) ------------------------------------------
  getgempar: {
    need: 'view',
    async run({ db }) {
      const rows = await db.query("SELECT DISTINCT tanggal FROM gempar WHERE UPPER(TRIM(COALESCE(ket, ''))) IN ('', 'GEMPAR') ORDER BY tanggal");
      return { warn: '', dates: rows.map((r) => ymd(r.tanggal)) };
    },
  },
};

async function monthList(db) {
  const rows = await db.query('SELECT mk, y, b, hari, mi FROM mv_mon_list ORDER BY mi');
  return rows.map((r) => ({ key: ymd(r.mk).slice(0, 7), b: num(r.b), y: num(r.y), hari: num(r.hari) }));
}

// Baris trend dengan filter [cab_pnl[], cabang[], kode[]] (cocok lewat norm) + batas area pengguna.
async function trendRows(db, user, a, cols) {
  const conds = [], params = [];
  const add = (col, vals) => {
    const v = [...new Set(arr(vals).map(norm))];
    if (v.length) { const w = inList(NORM(col), v); conds.push(w.sql); params.push(...w.params); }
  };
  add('cab_pnl', a[0]); add('cabang', a[1]); add('kode', a[2]);
  const ok = await allowedNorm(db, user);
  if (ok !== null) {
    if (!ok.size) return [];
    const w = inList(NORM('kode'), [...ok]); conds.push(w.sql); params.push(...w.params);
  }
  return db.query(`SELECT ${cols} FROM trend${conds.length ? ' WHERE ' + conds.join(' AND ') : ''}`, params);
}
