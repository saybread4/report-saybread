import test from 'node:test';
import assert from 'node:assert/strict';
import { handlers } from '../functions/_lib/handlers/index.js';

const mock = (rows) => { const calls = []; return { calls, async query(sql, a) { calls.push({ sql: sql.replace(/\s+/g, ' '), a }); return rows; } }; };
const pusat = { jabatan: 'ADMIN_PUSAT', bam_scope: [] };
const bam = { jabatan: 'BAM', bam_scope: ['BAM A'] };

test('getorg: bentuk hasil sama dengan fungsi lama, dan berparameter area', async () => {
  const db = mock([
    { kode: 'T-001', bas: 'Ani', bastr: '0', am: ' Budi ', as_: null, wilayah: 'W1', domain: 'D', kriteria: 'K' },
    { kode: '--', bas: 'x' },
  ]);
  const r = await handlers.getorg.run({ db, user: bam });
  assert.deepEqual(r, { warn: '', m: { T001: ['Ani', '', 'Budi', '', 'W1', 'D', 'K'] } });
  assert.deepEqual(db.calls[0].a, ['BAM A']);
  assert.match(db.calls[0].sql, /UPPER\(TRIM\(bam\)\) IN \(\?\)/);
  const db2 = mock([]); await handlers.getorg.run({ db: db2, user: pusat });
  assert.deepEqual(db2.calls[0].a, []);
});

test('getbam: indeks BAM/cabang dan jumlah toko', async () => {
  const db = mock([
    { bam: 'B1', cabang: 'C1' }, { bam: 'B1', cabang: 'C1' }, { bam: 'B1', cabang: 'C2' },
    { bam: 'B2', cabang: 'C2' }, { bam: '', cabang: 'C9' }, { bam: 'B3', cabang: '0' },
  ]);
  const r = await handlers.getbam.run({ db, user: pusat });
  assert.deepEqual(r.bam, ['B1', 'B2']);
  assert.deepEqual(r.cab, ['C1', 'C2']);
  assert.deepEqual(r.rows.sort(), [[0, 0, 2], [0, 1, 1], [1, 1, 1]].sort());
  assert.equal(r.warn, '');
});

test('getpnlcabang: angka dikonversi, difilter lewat area', async () => {
  const db = mock([{ tahun: '2026', bln: '3', cab_pnl: 'P1', pnl: '12.5' }]);
  const r = await handlers.getpnlcabang.run({ db, user: bam });
  assert.deepEqual(r, { rows: [[2026, 3, 'P1', 12.5]] });
  assert.deepEqual(db.calls[0].a, ['BAM A']);
  assert.match(db.calls[0].sql, /cab_pnl IN \(SELECT DISTINCT cab_pnl FROM toko WHERE UPPER\(TRIM\(bam\)\) IN \(\?\)\)/);
});

test('getplu: PLU pertama per deskripsi, abaikan yang kosong dan berawalan #', async () => {
  const db = mock([
    { plu: '#X1', deskripsi: 'Roti Coklat' }, { plu: '100', deskripsi: 'Roti Coklat' },
    { plu: '101', deskripsi: 'roti  coklat' }, { plu: '200', deskripsi: 'Kue' },
    { plu: '', deskripsi: 'Kosong' }, { plu: '300', deskripsi: '' },
  ]);
  const r = await handlers.getplu.run({ db, user: bam });
  assert.deepEqual(r, { ROTICOKLAT: '100', KUE: '200' });
});

test('semua fungsi terdaftar bertipe hak akses yang sah', () => {
  for (const [k, h] of Object.entries(handlers)) {
    assert.ok(['view', 'edit', 'pusat'].includes(h.need), k);
    assert.equal(typeof h.run, 'function', k);
  }
});
