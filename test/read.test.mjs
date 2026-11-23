import test from 'node:test';
import assert from 'node:assert/strict';
import { handlers } from '../functions/_lib/handlers/index.js';
import { refreshStep, STEPS } from '../functions/_lib/handlers/refresh.js';

const pusat = { jabatan: 'ADMIN_PUSAT', bam_scope: [] };
const bamA = { jabatan: 'BAM', bam_scope: ['BAM A'] };

// DB tiruan: daftar [regex, hasil | fungsi(sql, params)]; SQL yang tidak dikenal => error supaya ketahuan.
const mock = (routes) => {
  const calls = [];
  return {
    calls,
    async query(sql, a = []) {
      const s = sql.replace(/\s+/g, ' ').trim(); calls.push({ s, a });
      for (const [re, res] of routes) if (re.test(s)) return typeof res === 'function' ? res(s, a) : res;
      throw new Error('SQL tidak dikenal: ' + s.slice(0, 100));
    },
    async exec(sql, a = []) { calls.push({ s: sql.replace(/\s+/g, ' ').trim(), a, exec: true }); },
  };
};
const TOKO = [{ kode: 'T-1' }, { kode: 'T-2' }];                      // milik BAM A
const KS = [
  { ki: 0, kode: 'T1', toko: 'Toko 1', cabang: 'C1', cabpnl: 'P1' },
  { ki: 1, kode: 'T2', toko: 'Toko 2', cabang: 'C2', cabpnl: 'P1' },
  { ki: 2, kode: 'X9', toko: 'Toko X', cabang: 'C9', cabpnl: 'P9' },   // BAM lain
];
const DATES = [{ tanggal: '2026-11-01', di: 0 }, { tanggal: '2026-11-02', di: 1 }];
const TGL = [
  { kode: 'T1', tanggal: '2026-11-01', stock_qty: '5', prod: '1', qty: '10', rp: '1000', mg: '100', baq: '1', barp: '50' },
  { kode: 'T1', tanggal: '2026-11-02', stock_qty: '4', prod: '1', qty: '0', rp: '0', mg: '0', baq: '0', barp: '0' },
  { kode: 'T2', tanggal: '2026-11-01', stock_qty: '2', prod: '2', qty: '20', rp: '2000', mg: '200', baq: '2', barp: '60' },
];
const common = [
  [/^SELECT ki, kode, toko, cabang, cabpnl FROM mv_ks/, KS],
  [/^SELECT kode FROM toko WHERE/, TOKO],
  [/^SELECT tanggal, di FROM mv_dates/, DATES],
  [/FROM mv_tgl WHERE kode IN/, (s, a) => TGL.filter((r) => a.includes(r.kode))],
];

test('getcabmeta: area BAM hanya melihat toko miliknya, indeks mulai 0', async () => {
  const r = await handlers.getcabmeta.run({ db: mock(common), user: bamA });
  assert.deepEqual(r.pnl, ['P1']); assert.deepEqual(r.cab, ['C1', 'C2']);
  assert.deepEqual(r.stores, [['T1', 'Toko 1', 0, 0], ['T2', 'Toko 2', 0, 1]]);
  assert.deepEqual(r.pairs, [[0, 0], [0, 1]]);
  const p = await handlers.getcabmeta.run({ db: mock(common), user: pusat });
  assert.deepEqual(p.cab, ['C1', 'C2', 'C9']);
});

test('gettanggal: kode di luar area dianggap tidak ada', async () => {
  const db = mock(common);
  const ok = await handlers.gettanggal.run({ db, user: bamA }, ['T-1']);
  assert.equal(ok.found, true);
  assert.deepEqual(ok.rows, [[0, 5, 1, 10, 1000, 100, 1, 50], [1, 4, 1, 0, 0, 0, 0, 0]]);
  assert.deepEqual(ok.dates, ['2026-11-01', '2026-11-02']);
  const no = await handlers.gettanggal.run({ db, user: bamA }, ['X9']);
  assert.equal(no.found, false); assert.deepEqual(no.rows, []);
});

test('gettanggalcab: jumlah per tanggal dan jumlah toko yang terjual', async () => {
  const r = await handlers.gettanggalcab.run({ db: mock(common), user: bamA }, [[], []]);
  assert.equal(r.ns, 2);
  assert.deepEqual(r.rows[0], [0, 7, 3, 30, 3000, 300, 3, 110, 2, 2]);
  assert.deepEqual(r.rows[1], [1, 4, 1, 0, 0, 0, 0, 0, 1, 0]);
  const f = await handlers.gettanggalcab.run({ db: mock(common), user: bamA }, [['P1'], ['C2']]);
  assert.equal(f.ns, 1);
});

test('getmeta + getrows: indeks disusun ulang dan konsisten setelah disaring area', async () => {
  const IDX = [
    { kode: 'T1', deskripsi: 'Roti A', cab: 'C1', bas: 'B1', as_: 'S1', tk: '["T1","Toko 1","AM","BT"]', jn: 'DOUGH', qty: 5, qpd: '2.345', md: 'Aktif', i_cab: 0, i_bas: 0, i_as: 0, i_tk: 0, i_ds: 0, i_jn: 0, i_md: 0 },
    { kode: 'X9', deskripsi: 'Roti B', cab: 'C9', bas: 'B9', as_: 'S9', tk: ['X9', 'Toko X', '', ''], jn: 'DOUGH', qty: 3, qpd: 1, md: 'Aktif', i_cab: 1, i_bas: 1, i_as: 1, i_tk: 1, i_ds: 1, i_jn: 0, i_md: 0 },
    { kode: 'T2', deskripsi: 'Roti B', cab: 'C2', bas: 'B1', as_: 'S1', tk: '["T2","Toko 2","AM","BT"]', jn: 'DOUGH', qty: 1, qpd: 0, md: 'Aktif', i_cab: 2, i_bas: 0, i_as: 0, i_tk: 2, i_ds: 1, i_jn: 0, i_md: 0 },
  ];
  const routes = [
    [/FROM mv_stock_idx/, IDX], [/^SELECT kode FROM toko WHERE/, TOKO], [/^SELECT kode, toko, bas, bastr/, []],
    [/MAX\(created_at\)/, [{ u: '2026-11-21 02:30:00', t: '2026-11-21' }]],
    [/MAX\(tanggal\) AS m FROM sales_toko/, [{ m: '2026-11-20' }]],
  ];
  const m = await handlers.getmeta.run({ db: mock(routes), user: bamA });
  assert.deepEqual(m.d.cab, ['C1', 'C2']);                       // C9 (BAM lain) tidak bocor
  assert.deepEqual(m.d.tk.map((x) => x[0]), ['T1', 'T2']);
  assert.equal(m.updated, '21/11/2026 09:30'); assert.equal(m.tgl, '21/11/2026');
  assert.deepEqual(m.qpd, { bulan: 11, nama: 'November', hari: 20 });
  const r = await handlers.getrows.run({ db: mock(routes), user: bamA });
  assert.deepEqual(r, [[0, 0, 0, 0, 0, 0, 5, 2.35, 0], [1, 0, 0, 1, 1, 0, 1, 0, 0]]);
  const full = await handlers.getrows.run({ db: mock(routes), user: pusat });
  assert.equal(full.length, 3); assert.equal(full[1][0], 1);
});

test('gethistory: agregat bulanan, dimensi, dan bulan berjalan', async () => {
  const TR = [
    { tahun: 2026, bulan: 10, cab_pnl: 'P1', cabang: 'C1', kode: 'T1', toko: 'Toko 1', jml_hari: 30, sales_qty: 100, sales_rp: 1000.4, ba_rp: 10, margin: 50, pnl: 5 },
    { tahun: 2026, bulan: 10, cab_pnl: 'P1', cabang: 'C2', kode: 'T2', toko: 'Toko 2', jml_hari: 30, sales_qty: 200, sales_rp: 2000, ba_rp: 20, margin: 60, pnl: -3 },
  ];
  const routes = [...common, [/FROM trend WHERE/, TR], [/MAX\(tahun \* 100 \+ bulan\)/, [{ lm: 202610 }]], [/MAX\(tanggal\) AS m FROM mv_tgl/, [{ m: '2026-11-02' }]]];
  const r = await handlers.gethistory.run({ db: mock(routes), user: bamA }, [[], [], [], true]);
  assert.equal(r.dim, 'cab'); assert.equal(r.ncab, 2);
  assert.deepEqual(r.rows, [[2026, 10, 3000, 60, 30, 2, 300, 110, 2, 1, 1]]);
  assert.deepEqual(r.cur, { th: 2026, bl: 11, dt: 2, x: [3000, 2, 110, 2, 30, 300] });
  assert.ok(r.rk.some((x) => x[0] === 'C1' && x[2] === 2026 && x[3] === 11));
  const r2 = await handlers.gethistory.run({ db: mock(routes), user: bamA }, [[], [], []]);
  assert.equal(r2.cur, null);
});

test('getrankcab: nama dan baris per dimensi, nama BAS dari tabel toko', async () => {
  const routes = [...common,
    [/^SELECT kode, toko, bas, bastr, am, `as` AS as_ FROM toko/, [
      { kode: 'T-1', toko: 'Toko 1', bas: 'Ani', bastr: '', am: 'Budi', as_: '' }, { kode: 'T-2', toko: 'Toko 2', bas: 'Ani', bastr: '', am: 'Budi', as_: '' }]],
    [/^SELECT `key` AS k, val FROM rank_override/, [{ k: 'BAS|Ani', val: '3' }]],
  ];
  const r = await handlers.getrankcab.run({ db: mock(routes), user: bamA }, [[]]);
  assert.deepEqual(r.cab.names, ['C1', 'C2']); assert.deepEqual(r.bas.names, ['Ani']);
  assert.deepEqual(r.bastr.names, ['(kosong)']);
  assert.deepEqual(r.bas.rows, [[0, 0, 10, 1000, 50, 2, 1], [0, 1, 0, 0, 0, 1, 0]].map((x, i) => i === 0 ? [0, 0, 30, 3000, 110, 2, 2] : x));
  assert.deepEqual(r.ovr, { 'BAS|Ani': 3 });
});

test('getbasdataitem: pembagian ke tanggal menjumlah kembali ke total bulan', async () => {
  const routes = [...common,
    [/FROM sales_item WHERE kode IN/, [
      { kode: 'T1', tahun: 2026, bulan: 11, ket: 'closing', qty: '30', rp: '3000', baq: '0', barp: '0', prod: '0', mg: '0' }]],
    [/DISTINCT tahun, bulan FROM sales_item/, []],
    [/MAX\(tanggal\) AS m FROM sales_toko/, [{ m: '2026-11-02' }]],
    [/FROM sales_toko WHERE kode IN/, [
      { tanggal: '2026-11-01', kode: 'T1', sales_qty: 10 }, { tanggal: '2026-11-02', kode: 'T1', sales_qty: 20 }]],
    [/FROM rank_override/, []],
  ];
  const r = await handlers.getbasdataitem.run({ db: mock(routes), user: bamA }, [['T1'], ['Roti A']]);
  assert.equal(r.found, true);
  assert.deepEqual(r.rows.map((x) => [x[1], x[2]]), [[0, 10], [1, 20]]);
  assert.equal(r.rows.reduce((s, x) => s + x[3], 0), 3000);
});

test('refresh: TRUNCATE lalu isi ulang; langkah berat dipecah per bulan (dan per bagian kode), satu perintah per permintaan', async () => {
  const db = mock([]);
  assert.deepEqual(await refreshStep(db, 0), { next: null, total: 1 });
  assert.match(db.calls[0].s, /^TRUNCATE TABLE mv_dates$/); assert.match(db.calls[1].s, /^INSERT INTO mv_dates/);
  assert.deepEqual(await refreshStep(mock([]), 0, 3), { next: null, total: 1 });          // langkah ringan: potongan >0 tidak melakukan apa-apa

  // langkah 4: 3 bulan x 4 bagian = 12 potongan; TRUNCATE hanya di potongan pertama
  const d2 = mock([[/FROM mv_mon_list ORDER BY mi/, [{ mi: 0 }, { mi: 1 }, { mi: 2 }]]]);
  let sub = 0, n = 0;
  do { const r = await refreshStep(d2, 4, sub); assert.equal(r.total, 12); sub = r.next; n++; } while (sub != null);
  assert.equal(n, 12);
  assert.equal(d2.calls.filter((c) => /^TRUNCATE TABLE mv_mon_rows$/.test(c.s)).length, 1);
  const ins = d2.calls.filter((c) => /^INSERT INTO mv_mon_rows/.test(c.s));
  assert.equal(ins.length, 12);
  assert.match(ins[0].s, /AND mm\.mi = \? AND \(CRC32\(i\.kode\) % 4\) = \?/);
  assert.deepEqual(ins.map((c) => c.a), [0, 1, 2].flatMap((m) => [0, 1, 2, 3].map((b) => [m, b])));
  const d3 = mock([[/FROM mv_mon_list ORDER BY mi/, [{ mi: 5 }]]]);
  await refreshStep(d3, 5, 2);
  assert.deepEqual(d3.calls.filter((c) => c.exec).map((c) => [c.s.slice(0, 29), c.a]), [['INSERT INTO mv_mon_same (kode', [5, 2]]]);   // tanpa TRUNCATE di potongan > 0

  // langkah 3: satu bulan per potongan, termasuk pergantian tahun
  const d4 = mock([[/FROM sales_toko GROUP BY ym/, [{ ym: '2026-11' }, { ym: '2026-12' }]]]);
  assert.deepEqual(await refreshStep(d4, 3, 0), { next: 1, total: 2 });
  assert.deepEqual(await refreshStep(d4, 3, 1), { next: null, total: 2 });
  assert.deepEqual(d4.calls.filter((c) => /^INSERT INTO mv_tgl/.test(c.s)).map((c) => c.a),
    [['2026-11-01', '2026-12-01', '2026-11-01', '2026-12-01'], ['2026-12-01', '2027-01-01', '2026-12-01', '2027-01-01']]);
  assert.deepEqual(await refreshStep(mock([[/FROM sales_toko GROUP BY ym/, []]]), 3, 0), { next: null, total: 0 });   // belum ada data penjualan

  for (let st = 0; st < STEPS; st++) await refreshStep(mock([[/FROM mv_mon_list/, []], [/FROM sales_toko GROUP BY ym/, []]]), st);
  await assert.rejects(refreshStep(mock([]), 9));
  const r = await handlers.adminrefresh.run({ db: mock([]) }, ['tok', 0]);
  assert.deepEqual([r.langkah, r.total, r.next, r.subTotal], [0, 7, null, 1]);
  assert.match(r.pesan, /^Dashboard diperbarui \d\d\/\d\d\/\d{4} \d\d:\d\d$/);
});

test('refresh: kegagalan database ditampilkan lengkap (langkah, potongan, pesan asli) untuk administrator', async () => {
  const db = mock([[/FROM mv_mon_list ORDER BY mi/, [{ mi: 0 }]]]);
  db.exec = async (sql) => { if (/^INSERT INTO mv_mon_rows/.test(sql.replace(/\s+/g, ' ').trim())) throw new Error('Transaction is too large, size: 104857600'); };
  await assert.rejects(handlers.adminrefresh.run({ db }, ['tok', 4, 1]),
    (e) => { assert.equal(e.status, 500); assert.equal(e.message, 'Langkah 5/7 (penjualan item bulanan) gagal di potongan 2: Transaction is too large, size: 104857600'); return true; });
  await assert.rejects(handlers.adminrefresh.run({ db: mock([]) }, ['tok', 9]), (e) => e.status === 400);
});

test('fungsi baru terdaftar dengan hak akses yang sah', () => {
  for (const k of ['getcabmeta', 'getmeta', 'getrows', 'gettanggal', 'gettanggalcab', 'gettglmentah', 'getbasdata', 'getbasdataitem', 'getrankcab',
    'getmonitor', 'getmonitorcab', 'gettrend', 'gethistori', 'gethistory', 'getbudged', 'getbudovr', 'getgempar', 'getstockfd', 'getexcelfd'])
    assert.equal(handlers[k].need, 'view', k);
  assert.equal(handlers.adminrefresh.need, 'edit');
});
