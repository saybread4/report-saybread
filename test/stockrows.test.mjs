import test from 'node:test';
import assert from 'node:assert/strict';
import { handlers } from '../functions/_lib/handlers/index.js';

// Meniru driver TiDB: hasil tanpa LIMIT dipotong diam-diam di 10.000 baris.
const TOTAL = 23456;
const all = Array.from({ length: TOTAL }, (_, i) => ({ kode: 'K' + String(i).padStart(6, '0'), qty: 1, qpd: 1, i_cab: 0, i_bas: 0, i_as: 0, i_tk: i % 700, i_ds: i % 30, i_jn: 0, i_md: 0 }));
const full = all.map((r) => ({ ...r, deskripsi: 'D' + r.i_ds, cab: 'C' + r.i_cab, bas: 'B' + r.i_bas, as_: 'A' + r.i_as, tk: JSON.stringify(['K' + r.i_tk, 'Toko ' + r.i_tk]), jn: 'DOUGH', md: 'Aktif' }));
const db = {
  async query(sql) {
    if (!/FROM mv_stock_idx/.test(sql)) return [];
    const m = /LIMIT (\d+) OFFSET (\d+)/.exec(sql);
    const src = /deskripsi/.test(sql) ? full : all;
    return m ? src.slice(+m[2], +m[2] + +m[1]) : src.slice(0, 10000);
  },
  async exec() {},
};
const PUSAT = { jabatan: 'ADMIN_PUSAT', bam_scope: null };

test('Stock: getrows membaca SEMUA baris mv_stock_idx, bukan hanya 10.000 pertama', async () => {
  const user = { jabatan: 'ADMIN_PUSAT', bam_scope: null };
  const rows = await handlers.getrows.run({ db, user }, []);
  assert.equal(rows.length, TOTAL);
});

test('Stock: getmeta menyusun kamus dari SEMUA halaman (700 toko, 30 deskripsi) tanpa menyimpan baris', async () => {
  const dbm = { ...db, async query(sql, a) { if (/FROM toko/.test(sql) || /FROM stock\b/.test(sql) || /sales_toko|data_updates/.test(sql)) return []; return db.query(sql, a); } };
  const m = await handlers.getmeta.run({ db: dbm, user: PUSAT }, []);
  assert.equal(m.d.tk.length, 700); assert.equal(m.d.ds.length, 30);
  assert.deepEqual(m.d.tk[699], ['K699', 'Toko 699']);
});

test('Stock: halaman dibaca lewat _tidb_rowid (tanpa OFFSET/ORDER BY tabel penuh) dan hasilnya lengkap', async () => {
  const sqls = [];
  const dbk = {
    async query(sql, a = []) {
      if (!/FROM mv_stock_idx/.test(sql)) return [];
      sqls.push(sql);
      const m = /_tidb_rowid > \?.*LIMIT (\d+)/.exec(sql);
      assert.ok(m, 'harus memakai _tidb_rowid');
      const start = a[0] + 1;
      return all.slice(start, start + +m[1]).map((r, i) => ({ ...r, rid: start + i }));
    },
    async exec() {},
  };
  const rows = await handlers.getrows.run({ db: dbk, user: PUSAT }, []);
  assert.equal(rows.length, TOTAL);
  assert.ok(sqls.every((q) => !/OFFSET/.test(q)));
});

test('Stock: bila _tidb_rowid ditolak, jatuh ke cara OFFSET dan tetap lengkap', async () => {
  const dbf = {
    async query(sql) {
      if (!/FROM mv_stock_idx/.test(sql)) return [];
      if (/_tidb_rowid/.test(sql)) throw new Error('Unknown column _tidb_rowid');
      const m = /LIMIT (\d+) OFFSET (\d+)/.exec(sql);
      return all.slice(+m[2], +m[2] + +m[1]);
    },
    async exec() {},
  };
  assert.equal((await handlers.getrows.run({ db: dbf, user: PUSAT }, [])).length, TOTAL);
});
