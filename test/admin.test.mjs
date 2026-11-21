import test from 'node:test';
import assert from 'node:assert/strict';
import { handlers } from '../functions/_lib/handlers/index.js';
import { adminHandlers, _internals as X } from '../functions/_lib/handlers/admin.js';
import { fixKode } from '../functions/_lib/util.js';
import { can } from '../functions/_lib/auth.js';

const pusat = { jabatan: 'ADMIN_PUSAT', bam_scope: [] };
const koor = { jabatan: 'ADMIN_KOORBAM', bam_scope: ['BAM A'] };
const flat = (s) => s.replace(/\s+/g, ' ').trim();

function mk(resp = () => [], onExec = () => {}) {
  const log = [];
  return {
    log,
    async query(sql, a = []) { const s = flat(sql); log.push({ k: 'q', sql: s, a }); return resp(s, a); },
    async exec(sql, a = []) { const s = flat(sql); log.push({ k: 'e', sql: s, a }); return onExec(s, a); },
    execs: () => log.filter((x) => x.k === 'e'),
    queries: () => log.filter((x) => x.k === 'q'),
  };
}
const run = (name, user, a, db) => handlers[name].run({ db, user }, a);
const rejects = (p, status, re) => assert.rejects(p, (e) => { assert.equal(e.status, status); if (re) assert.match(e.message, re); return true; });
const N = (n) => () => [{ n }];

test('fixKode: bentuk tanggal dikembalikan ke kode, kode normal tidak berubah', () => {
  for (const [i, o] of [['7-Feb', 'FEB7'], ['07-Feb-26', 'FEB7'], ['Feb-07', 'FEB7'], ['2/7/2026', 'FEB7'], ['2026-02-07', 'FEB7'], ['T001', 'T001'], ['A-1', 'A-1']])
    assert.equal(fixKode(i), o);
});

test('hak akses: hanya Admin Pusat dan Admin Koorbam yang boleh fungsi admin; Gempar/rank hanya Pusat', () => {
  const need = Object.fromEntries(Object.entries(adminHandlers).map(([k, h]) => [k, h.need]));
  assert.equal(need.adminimport, 'edit'); assert.equal(need.savebudovr, 'edit');
  for (const k of ['saverankovr', 'gemparsave', 'gempardelete', 'gemparlist', 'savegempar', 'deletegempar', 'getgemparlist']) assert.equal(need[k], 'pusat', k);
  for (const j of ['KOORBAM', 'BAM', 'BAS', 'BASTR'])
    for (const [k, n] of Object.entries(need)) assert.equal(can({ jabatan: j }, n), false, `${j} ${k}`);
  for (const [k, n] of Object.entries(need)) assert.equal(can({ jabatan: 'ADMIN_KOORBAM' }, n), n === 'edit', k);
  for (const k of Object.keys(adminHandlers)) assert.ok(handlers[k], 'terdaftar di router: ' + k);
});

test('adminlist: SQL, urutan, id ikut, tipe data dikonversi', async () => {
  const db = mk((s) => (s.startsWith('SELECT COUNT') ? [{ n: '120' }] : [{ id: '5', tanggal: '2026-01-05', kode: 'T1', toko: 'X', plu: '1', deskripsi: 'D', jenis: 'J', stock_qty: '12.000000' }]));
  const r = await run('adminlist', pusat, ['tok', 'stock', '2026-01-01', '2026-01-31', 't1, t2', '', 500, -5], db);
  assert.deepEqual(r, { total: 120, rows: [{ id: 5, tanggal: '2026-01-05', kode: 'T1', toko: 'X', plu: '1', deskripsi: 'D', jenis: 'J', stock_qty: 12 }] });
  const sel = db.queries()[1];
  assert.match(sel.sql, /^SELECT `id`, `tanggal`, `kode`/);
  assert.match(sel.sql, /WHERE `tanggal` >= \? AND `tanggal` <= \? AND UPPER\(TRIM\(`kode`\)\) IN \(\?,\?\) ORDER BY `tanggal` DESC, `id` LIMIT 200 OFFSET 0$/);
  assert.deepEqual(sel.a, ['2026-01-01', '2026-01-31', 'T1', 'T2']);
});

test('adminlist/ym: urut tahun-bulan desc, filter bulan numerik, ket', async () => {
  const db = mk(N(0));
  await run('adminlist', pusat, ['t', 'sales_item', '202601', '202603', '', 'closing', 50, 0], db);
  const s = db.queries()[1];
  assert.match(s.sql, /WHERE \(tahun\*100\+bulan\) >= \? AND \(tahun\*100\+bulan\) <= \? AND `ket` = \? ORDER BY `tahun` DESC, `bulan` DESC, `ket`, `tahun`/);
  assert.deepEqual(s.a, [202601, 202603, 'closing']);
});

test('adminlist: tabel tak dikenal 400; Admin Koorbam dibatasi area; tabel item 403', async () => {
  await rejects(run('adminlist', pusat, ['t', 'users'], mk()), 400, /Tabel tidak dikenal/);
  await rejects(run('adminlist', pusat, ['t', 'constructor'], mk()), 400, /Tabel tidak dikenal/);
  await rejects(run('adminlist', pusat, ['t', 'stock', 'bukan-tanggal'], mk()), 400, /Tanggal tidak valid/);
  await rejects(run('adminlist', koor, ['t', 'item'], mk()), 403, /administrator utama/);
  const db = mk(N(0));
  await run('adminlist', koor, ['t', 'toko'], db);
  assert.match(db.queries()[0].sql, /WHERE UPPER\(TRIM\(bam\)\) IN \(\?\)$/);
  assert.deepEqual(db.queries()[0].a, ['BAM A']);
  const db2 = mk(N(0));
  await run('adminlist', koor, ['t', 'stock', '2026-01-01'], db2);
  assert.match(db2.queries()[0].sql, /UPPER\(TRIM\(kode\)\) IN \(SELECT UPPER\(TRIM\(x\.kode\)\) FROM toko x WHERE UPPER\(TRIM\(x\.bam\)\) IN \(\?\)\)/);
  assert.deepEqual(db2.queries()[0].a, ['2026-01-01', 'BAM A']);
});

test('admincount: jumlah dan penanda filter', async () => {
  assert.deepEqual(await run('admincount', pusat, ['t', 'stock'], mk(N('7'))), { n: 7, filter: false });
  assert.deepEqual(await run('admincount', pusat, ['t', 'stock', '2026-01-01'], mk(N(3))), { n: 3, filter: true });
});

test('admindelete: wajib filter atau hapus-semua; hitung lalu hapus dengan LIMIT; Koorbam dibatasi', async () => {
  await rejects(run('admindelete', pusat, ['t', 'stock', '', '', '', '', 5000, false], mk()), 400, /Tentukan rentang/);
  const db = mk(N(5000));
  const r = await run('admindelete', pusat, ['t', 'stock', '2026-01-01', '', '', '', 5000, false], db);
  assert.deepEqual(r, { terhapus: 5000, lagi: true });
  assert.match(db.queries()[0].sql, /SELECT COUNT\(\*\) AS n FROM \(SELECT 1 FROM `stock` WHERE `tanggal` >= \? LIMIT 5000\) x/);
  assert.match(db.execs()[0].sql, /^DELETE FROM `stock` WHERE `tanggal` >= \? LIMIT 5000$/);
  const db2 = mk(N(0));
  assert.deepEqual(await run('admindelete', pusat, ['t', 'stock', '', '', '', '', 99999, true], db2), { terhapus: 0, lagi: false });
  assert.equal(db2.execs().length, 0);                                       // tidak ada yang dihapus
  assert.match(db2.queries()[0].sql, /LIMIT 20000\) x/);                    // batas atas 20000
  const db3 = mk(N(2));
  await run('admindelete', koor, ['t', 'sales_toko', '', '', 'a', '', 5000, false], db3);
  assert.match(db3.execs()[0].sql, /IN \(SELECT UPPER\(TRIM\(x\.kode\)\) FROM toko x/);
  assert.deepEqual(db3.execs()[0].a, ['A', 'BAM A']);
});

test('admininfo: ringkasan per tabel; Koorbam tidak melihat item', async () => {
  const resp = (s) => (s.includes('DATE_FORMAT') ? [{ n: '10', mn: '2026-01-01', mx: '2026-01-31' }] : s.includes('tahun*100') ? [{ n: 4, mn: '202601', mx: '202603' }] : [{ n: 9 }]);
  const r = await run('admininfo', pusat, ['t'], mk(resp));
  assert.deepEqual(Object.keys(r).sort(), ['budged', 'item', 'modis', 'sales_item', 'sales_toko', 'stock', 'stock_toko', 'toko', 'trend']);
  assert.deepEqual(r.stock, { n: 10, min: '2026-01-01', max: '2026-01-31' });
  assert.deepEqual(r.trend, { n: 4, min: '202601', max: '202603' });
  assert.deepEqual(r.item, { n: 9, min: null, max: null });
  const k = await run('admininfo', koor, ['t'], mk(resp));
  assert.equal('item' in k, false);
});

test('adminupdate: validasi, area, tidak ketemu, sukses, duplikat', async () => {
  const U = (u, a, db) => run('adminupdate', u, ['t', ...a], db);
  await rejects(U(pusat, ['stock', { id: 1 }, { nama_ngawur: 1 }], mk()), 400, /Kolom nama_ngawur tidak dikenal/);
  await rejects(U(pusat, ['stock', {}, { toko: 'x' }], mk()), 400, /Kunci baris tidak lengkap/);
  await rejects(U(pusat, ['stock', 'x', { toko: 'x' }], mk()), 400, /Data tidak valid/);
  assert.deepEqual(await U(pusat, ['stock', { id: 1 }, {}], mk()), { n: 0 });
  await rejects(U(koor, ['item', { plu: '1' }, { deskripsi: 'x' }], mk()), 403);
  await rejects(U(koor, ['toko', { kode: 'T1' }, { bam: 'BAM B' }], mk()), 400, /BAM harus BAM A/);
  await rejects(U(koor, ['stock', { id: 1 }, { kode: 'T9' }], mk(() => [])), 400, /tidak termasuk BAM BAM A/);
  await rejects(U(pusat, ['stock', { id: 1 }, { toko: 'x' }], mk(N(0))), 404, /Baris tidak ditemukan/);

  const db = mk(N(1));
  assert.deepEqual(await U(pusat, ['sales_toko', { tanggal: '2026-01-05', kode: 'T1' }, { kode: '7-Feb', sales_qty: null, produksi: '2.5' }], db), { n: 1 });
  assert.match(db.execs()[0].sql, /^UPDATE `sales_toko` SET `kode` = \?, `sales_qty` = \?, `produksi` = \? WHERE `tanggal` = \? AND `kode` = \?$/);
  assert.deepEqual(db.execs()[0].a, ['FEB7', 0, 2.5, '2026-01-05', 'T1']);          // fixKode, kosong -> 0, angka dari teks

  const dup = mk(N(1), () => { throw new Error("Duplicate entry 'x' for key 'PRIMARY'"); });
  await rejects(U(pusat, ['toko', { kode: 'A' }, { kode: 'B' }], dup), 409, /kunci yang sama/);
  const ok = mk((s) => (s.startsWith('SELECT 1') ? [{ x: 1 }] : [{ n: 1 }]));
  await U(koor, ['stock', { id: 3 }, { kode: 't1' }], ok);                            // kode milik areanya -> lolos
  assert.match(ok.execs()[0].sql, /UPDATE `stock` SET `kode` = \? WHERE `id` = \? AND UPPER\(TRIM\(kode\)\) IN/);
});

test('admindeleterow', async () => {
  await rejects(run('admindeleterow', pusat, ['t', 'toko', {}], mk()), 400, /Kunci baris tidak lengkap/);
  const db = mk(N(1));
  assert.deepEqual(await run('admindeleterow', pusat, ['t', 'toko', { kode: 'T1' }], db), { n: 1 });
  assert.match(db.execs()[0].sql, /^DELETE FROM `toko` WHERE `kode` = \?$/);
  const none = mk(N(0));
  assert.deepEqual(await run('admindeleterow', koor, ['t', 'toko', { kode: 'T1' }], none), { n: 0 });
  assert.equal(none.execs().length, 0);
});

test('adminimport (kunci unik): upsert, hitung baru/ubah, dedupe, fixKode, nol, kolom asing dibuang', async () => {
  const db = mk(N(1));
  const rows = [{ tanggal: '2026-01-05', kode: '7-Feb', produksi: '10', sales_qty: null, sales_rp: 5, x: 1 },
                { tanggal: '2026-01-05', kode: 'FEB7', produksi: '11' },        // kunci sama setelah fixKode -> yang terakhir menang
                { tanggal: '2026-01-06', kode: 'T2' }];
  const r = await run('adminimport', pusat, ['t', 'sales_toko', rows, ['tanggal', 'kode', 'produksi', 'sales_qty', 'sales_rp', 'x'], false], db);
  assert.deepEqual(r, { masuk: 2, baru: 1, ubah: 1 });
  assert.match(db.queries()[0].sql, /^SELECT COUNT\(\*\) AS n FROM `sales_toko` WHERE \(`tanggal`,`kode`\) IN \(\(\?,\?\),\(\?,\?\)\)$/);
  assert.match(db.execs()[0].sql, /^INSERT INTO `sales_toko` \(`tanggal`,`kode`,`produksi`,`sales_qty`,`sales_rp`\) VALUES \(\?,\?,\?,\?,\?\),\(\?,\?,\?,\?,\?\) ON DUPLICATE KEY UPDATE `produksi` = VALUES\(`produksi`\), `sales_qty` = VALUES\(`sales_qty`\), `sales_rp` = VALUES\(`sales_rp`\)$/);
  assert.deepEqual(db.execs()[0].a, ['2026-01-05', 'FEB7', 11, 0, 0, '2026-01-06', 'T2', 0, 0, 0]);
});

test('adminimport: hanya kolom kunci -> ON DUPLICATE KEY tanpa kolom lain', async () => {
  const db = mk(N(0));
  await run('adminimport', pusat, ['t', 'item', [{ plu: '1' }], ['plu'], false], db);
  assert.match(db.execs()[0].sql, /ON DUPLICATE KEY UPDATE `plu` = `plu`$/);
});

test('adminimport: validasi masukan', async () => {
  const I = (a, u = pusat) => run('adminimport', u, ['t', ...a], mk(N(0)));
  await rejects(I(['stock', 'bukan-array', []]), 400, /Data tidak valid/);
  assert.deepEqual(await I(['stock', [], ['tanggal']]), { masuk: 0, baru: 0, ubah: 0 });
  await rejects(I(['stock', Array(5001).fill({ tanggal: '2026-01-01', kode: 'A', plu: '1' }), ['tanggal', 'kode', 'plu']]), 400, /Maksimal 5000/);
  await rejects(I(['stock', [{ tanggal: '2026-01-01', kode: 'A' }], ['tanggal', 'kode']]), 400, /Kolom kunci wajib ada: tanggal, kode, plu/);
  await rejects(I(['stock', [{ tanggal: '2026-01-01', kode: 'A', plu: '' }], ['tanggal', 'kode', 'plu']]), 400, /Baris 1: kolom kunci plu kosong/);
  await rejects(I(['sales_toko', [{ tanggal: '2026-01-01', kode: 'A' }, { tanggal: '2026-01-02', kode: 'B', sales_rp: 'abc' }], ['tanggal', 'kode', 'sales_rp']]), 400, /Baris 2: kolom sales_rp bukan angka/);
  await rejects(I(['sales_toko', [{ tanggal: '31/02/2026', kode: 'A' }], ['tanggal', 'kode']]), 400, /Baris 1: kolom tanggal bukan tanggal/);
  await rejects(I(['sales_toko', [{ tanggal: '2026-02-30', kode: 'A' }], ['tanggal', 'kode']]), 400, /bukan tanggal/);
  await rejects(I(['sales_toko', ['teks'], ['tanggal', 'kode']]), 400, /Data tidak valid/);
  await rejects(I(['users', [{}], ['x']]), 400, /Tabel tidak dikenal/);
});

test('adminimport: Admin Koorbam hanya boleh memasukkan data areanya', async () => {
  const I = (tbl, rows, cols, resp) => run('adminimport', koor, ['t', tbl, rows, cols, false], mk(resp || (() => [])));
  await rejects(I('item', [{ plu: '1' }], ['plu']), 403, /administrator utama/);
  await rejects(I('toko', [{ kode: 'T1', bam: 'bam b' }, { kode: 'T2' }], ['kode', 'bam']), 400, /BAM harus BAM A.*BAM B.*\(kosong\)/);
  await rejects(I('toko', [{ kode: 'T1', bam: 'bam a' }], ['kode', 'bam'], () => [{ b: 'BAM B' }]), 400, /sudah dipakai BAM lain/);
  await rejects(I('stock', [{ tanggal: '2026-01-01', kode: 'T9', plu: '1' }], ['tanggal', 'kode', 'plu'], () => [{ k: 'T1' }]), 400, /tidak termasuk BAM BAM A.*T9/);
  await rejects(I('stock', [{ tanggal: '2026-01-01', kode: 'T1', plu: '1' }], ['tanggal', 'kode', 'plu'], () => []), 400, /tidak termasuk BAM/);   // area tanpa toko
  const ok = mk((s) => (s.startsWith('SELECT DISTINCT') ? [{ k: 'T1' }] : [{ n: 0 }]));
  const r = await run('adminimport', koor, ['t', 'stock', [{ tanggal: '2026-01-01', kode: 't1', plu: '1' }], ['tanggal', 'kode', 'plu'], false], ok);
  assert.deepEqual(r, { masuk: 1, baru: 1, ubah: 0 });
});

test('adminimport (tanpa kunci unik): hapus kunci lama lalu isi; mode Ganti melewati penghapusan', async () => {
  const rows = [{ tanggal: '2026-01-05', kode: 'T1', jenis: 'DOUGH', stock_total: 5 },
                { tanggal: '2026-01-05', kode: 'T1', jenis: 'DOUGH', stock_total: 6 },
                { tanggal: '2026-01-05', kode: 'T2', jenis: 'DOUGH', stock_total: 7 }];
  const cols = ['tanggal', 'kode', 'jenis', 'stock_total'];
  const db = mk(N(1));
  assert.deepEqual(await run('adminimport', pusat, ['t', 'stock_toko', rows, cols, false], db), { masuk: 2, baru: 1, ubah: 1 });
  assert.match(db.execs()[0].sql, /^DELETE FROM `stock_toko` WHERE \(`tanggal`,`kode`,`jenis`\) IN \(\(\?,\?,\?\),\(\?,\?,\?\)\)$/);
  assert.match(db.execs()[1].sql, /^INSERT INTO `stock_toko` \(`tanggal`,`kode`,`jenis`,`stock_total`\) VALUES \(\?,\?,\?,\?\),\(\?,\?,\?,\?\)$/);   // tanpa ON DUPLICATE
  assert.deepEqual(db.execs()[1].a, ['2026-01-05', 'T1', 'DOUGH', 6, '2026-01-05', 'T2', 'DOUGH', 7]);
  const g = mk(N(0));
  assert.deepEqual(await run('adminimport', pusat, ['t', 'stock_toko', rows, cols, true], g), { masuk: 2, baru: 2, ubah: 0 });
  assert.equal(g.execs().length, 1); assert.equal(g.queries().length, 0);
});

test('adminimport budged: Koorbam hanya menghapus baris BAM-nya; kunci NULL aman', async () => {
  const db = mk(N(0));
  await run('adminimport', koor, ['t', 'budged', [{ cab_pnl: 'P1', cabang: null, bam: 'BAM A', bulan: 1, tahun: 2026, budged: 100 }], ['cab_pnl', 'cabang', 'bam', 'bulan', 'tahun', 'budged'], false], db);
  assert.match(db.execs()[0].sql, /^DELETE FROM `budged` WHERE \(\(`cab_pnl` = \? AND `cabang` IS NULL AND `bulan` = \? AND `tahun` = \?\)\) AND UPPER\(TRIM\(bam\)\) IN \(\?\)$/);
  assert.deepEqual(db.execs()[0].a, ['P1', 1, 2026, 'BAM A']);
});

test('keyCond & dedupe', () => {
  const k = X.keyCond(['a', 'b'], [[1, 2], [3, null]]);
  assert.equal(k.sql, '(`a`,`b`) IN ((?,?)) OR (`a` = ? AND `b` IS NULL)');
  assert.deepEqual(k.params, [1, 2, 3]);
  const d = X.dedupe([{ a: 1, b: null, v: 'x' }, { a: 1, b: null, v: 'y' }, { a: 1, b: 'null', v: 'z' }], ['a', 'b']);
  assert.deepEqual(d.map((r) => r.v), ['y', 'z']);
});

test('adminimport: 2500 baris dipecah beberapa INSERT (maks ~10000 parameter)', async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => ({ ket: 'closing', tahun: 2026, bulan: 1, kode: 'T' + i, deskripsi: 'D' }));
  const db = mk(N(0));
  const r = await run('adminimport', pusat, ['t', 'sales_item', rows, ['ket', 'tahun', 'bulan', 'kode', 'deskripsi'], false], db);
  assert.equal(r.masuk, 2500);
  assert.equal(db.execs().length, 2);                                              // 5 kolom -> 2000 baris per INSERT
  assert.ok(db.execs().every((e) => e.a.length <= 10000));
});

test('Gempar: daftar tanggal, simpan, ubah, hapus, dan versi per-ID', async () => {
  const dates = () => [{ tanggal: '2026-03-02' }, { tanggal: new Date('2026-03-01T00:00:00Z') }];
  assert.deepEqual(await run('getgemparlist', pusat, ['t'], mk(dates)), ['2026-03-02', '2026-03-01']);

  const add = mk((s) => (s.startsWith('SELECT COUNT') ? [{ n: 0 }] : dates()));
  assert.deepEqual(await run('savegempar', pusat, ['t', '', '2026-03-05'], add), ['2026-03-02', '2026-03-01']);
  assert.deepEqual(add.execs()[0], { k: 'e', sql: 'INSERT INTO gempar (tanggal) VALUES (?)', a: ['2026-03-05'] });
  await rejects(run('savegempar', pusat, ['t', '', ''], mk()), 400, /Tanggal wajib diisi/);
  await rejects(run('savegempar', pusat, ['t', '', '2026-03-05'], mk(N(1))), 400, /Tanggal 05-03-2026 sudah ada/);
  await rejects(run('savegempar', pusat, ['t', '2026-03-01', '2026-03-05'], mk((s, a) => [{ n: a[0] === '2026-03-05' ? 0 : 0 }])), 400, /Tanggal 01-03-2026 tidak ditemukan/);
  const ch = mk((s) => (s.startsWith('SELECT COUNT') ? [{ n: 1 }] : dates()));
  await run('savegempar', pusat, ['t', '2026-03-01', '2026-03-01'], ch);
  assert.deepEqual(ch.execs()[0].a, ['2026-03-01', '2026-03-01']);
  const del = mk(dates);
  await run('deletegempar', pusat, ['t', '2026-03-01'], del);
  assert.deepEqual(del.execs()[0], { k: 'e', sql: 'DELETE FROM gempar WHERE tanggal = ?', a: ['2026-03-01'] });

  assert.deepEqual(await run('gemparlist', pusat, ['t'], mk(() => [{ id: '3', tanggal: '2026-03-02', ket: 'GEMPAR' }])), [{ id: 3, tanggal: '2026-03-02', ket: 'GEMPAR' }]);
  const s1 = mk();
  assert.equal(await run('gemparsave', pusat, ['t', '', '2026-03-05', ' libur '], s1), true);
  assert.deepEqual(s1.execs()[0].a, ['2026-03-05', 'LIBUR']);
  const s2 = mk();
  await run('gemparsave', pusat, ['t', '7', '2026-03-05', ''], s2);
  assert.match(s2.execs()[0].sql, /UPDATE gempar SET tanggal = \?, ket = \? WHERE id = \?/);
  assert.deepEqual(s2.execs()[0].a, ['2026-03-05', 'GEMPAR', 7]);
  await rejects(run('gemparsave', pusat, ['t', '', 'ngawur', 'x'], mk()), 400, /Tanggal tidak valid/);
  await rejects(run('gemparsave', pusat, ['t', '', '2026-03-05', 'x'], mk(() => [], () => { throw new Error('Duplicate entry'); })), 409, /sudah ada/);
  const gd = mk();
  assert.equal(await run('gempardelete', pusat, ['t', '4'], gd), true);
  assert.deepEqual(gd.execs()[0].a, [4]);
  await rejects(run('gempardelete', pusat, ['t', 'x'], mk()), 400, /ID tidak valid/);
});

test('override budged: validasi kunci/angka, simpan, hapus, dan batas area Koorbam', async () => {
  const S = (u, k, v, db) => run('savebudovr', u, ['t', k, v], db);
  const KEY = 'BUD|CAB|CABANG X|2026-03';
  await rejects(S(pusat, 'BUD|XX|a|2026-03', 1, mk()), 400, /Kunci tidak valid/);
  await rejects(S(pusat, 'BAS|a', 1, mk()), 400, /Kunci tidak valid/);
  await rejects(S(pusat, KEY, 'abc', mk()), 400, /Angka tidak valid/);
  await rejects(S(pusat, KEY, '0x10', mk()), 400, /Angka tidak valid/);
  await rejects(S(pusat, KEY, -1, mk()), 400, /tidak masuk akal/);
  await rejects(S(pusat, KEY, 2e12, mk()), 400, /tidak masuk akal/);

  const map = mk((s) => (s.startsWith('SELECT `key`') ? [{ key: KEY, val: '1500.5' }] : []));
  assert.deepEqual(await S(pusat, KEY, '1500.5', map), { [KEY]: 1500.5 });
  assert.match(map.execs()[0].sql, /INSERT INTO budged_override \(`key`, val\) VALUES \(\?, \?\) ON DUPLICATE KEY UPDATE val = VALUES\(val\), updated_at = UTC_TIMESTAMP\(\)/);
  assert.deepEqual(map.execs()[0].a, [KEY, 1500.5]);
  const del = mk(() => []);
  assert.deepEqual(await S(pusat, KEY, null, del), {});
  assert.match(del.execs()[0].sql, /^DELETE FROM budged_override WHERE `key` = \?$/);
  const blank = mk(); await S(pusat, KEY, '  ', blank);
  assert.match(blank.execs()[0].sql, /^DELETE/);

  await rejects(S(koor, KEY, 5, mk(() => [])), 403, /di luar area/);                           // cabang bukan milik areanya
  const ok = mk((s) => (s.startsWith('SELECT 1') ? [{ x: 1 }] : []));
  await S(koor, 'BUD|TK|T-001|2026-03', 5, ok);
  assert.deepEqual(ok.queries()[0].a, ['T-001', 'T001', 'BAM A']);
  assert.equal(ok.execs().length, 1);
});

test('override rank: hanya kunci BAS| dan hanya Admin Pusat', async () => {
  await rejects(run('saverankovr', pusat, ['t', 'XYZ|a', 1], mk()), 400, /Kunci tidak valid/);
  const db = mk((s) => (s.startsWith('SELECT') ? [{ key: 'BAS|a', val: 3 }] : []));
  assert.deepEqual(await run('saverankovr', pusat, ['t', 'BAS|a', 3], db), { 'BAS|a': 3 });
  assert.match(db.execs()[0].sql, /INSERT INTO rank_override/);
  assert.equal(can(koor, handlers.saverankovr.need), false);
});
