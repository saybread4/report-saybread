import test from 'node:test';
import assert from 'node:assert/strict';
import { handlers } from '../functions/_lib/handlers/index.js';

// Meniru driver TiDB: hasil tanpa LIMIT dipotong diam-diam di 10.000 baris.
const TOTAL = 23456;
const all = Array.from({ length: TOTAL }, (_, i) => ({ kode: 'K' + String(i).padStart(6, '0'), qty: 1, qpd: 1, i_cab: 0, i_bas: 0, i_as: 0, i_tk: i % 700, i_ds: i % 30, i_jn: 0, i_md: 0 }));
const full = all.map((r) => ({ ...r, deskripsi: 'D' + r.i_ds, cab: 'C' + r.i_cab, bas: 'B' + r.i_bas, as_: 'A' + r.i_as, tk: JSON.stringify(['K' + r.i_tk, 'Toko ' + r.i_tk]), jn: 'DOUGH', md: 'Aktif' }));
const PUSAT = { jabatan: 'ADMIN_PUSAT', bam_scope: null };
const page = (src, sql, a) => {
  const m = /LIMIT (\d+) OFFSET (\d+)/.exec(sql);
  return m ? src.slice(+m[2], +m[2] + +m[1]) : src.slice(0, 10000);
};
const COL = { i_cab: 'cab', i_bas: 'bas', i_as: 'as_', i_tk: 'tk', i_ds: 'deskripsi', i_jn: 'jn', i_md: 'md' };

// Database tiruan yang mengerti SQL jalur cepat: kamus (GROUP BY) dan halaman baris.
function fastDb({ rowid = true, log = [] } = {}) {
  return {
    log,
    async query(sql, a = []) {
      const s = sql.replace(/\s+/g, ' ');
      log.push(s);
      if (!/FROM mv_stock_idx/.test(s)) return [];
      const g = /SELECT (i_\w+) AS k, .* GROUP BY/.exec(s);
      if (g) {
        const m = new Map();
        for (const r of full) if (!m.has(r[g[1]])) m.set(r[g[1]], r[COL[g[1]]]);
        const rows = [...m].sort((x, y) => x[0] - y[0]).map(([k, v]) => ({ k, v }));
        return page(rows, s, a);
      }
      const r = /_tidb_rowid > \?.*LIMIT (\d+)/.exec(s);
      if (r) {
        if (!rowid) throw new Error('Unknown column _tidb_rowid');
        const start = a[0] + 1;
        return all.slice(start, start + +r[1]).map((x, i) => ({ ...x, rid: start + i }));
      }
      return page(all, s, a);
    },
    async exec() {},
  };
}

test('Stock: getrows membaca SEMUA baris mv_stock_idx, bukan hanya 10.000 pertama', async () => {
  const rows = (await handlers.getrows.run({ db: fastDb(), user: PUSAT }, [])).toJSON();
  assert.equal(rows.length, TOTAL);
  assert.equal(rows[TOTAL - 1][3], (TOTAL - 1) % 700);             // indeks toko terpetakan benar
  assert.equal(rows[0][6], 1);
});

test('Stock: getmeta menyusun kamus lewat GROUP BY (700 toko, 30 deskripsi) tanpa memindai baris', async () => {
  const log = [];
  const base = fastDb({ log });
  const dbm = { ...base, async query(sql, a) { if (/FROM toko/.test(sql) || /FROM stock\b/.test(sql) || /sales_toko|data_updates/.test(sql)) return []; return base.query(sql, a); } };
  const m = await handlers.getmeta.run({ db: dbm, user: PUSAT }, []);
  assert.equal(m.d.tk.length, 700); assert.equal(m.d.ds.length, 30);
  assert.deepEqual(m.d.tk[699], ['K699', 'Toko 699']);
  assert.ok(log.filter((q) => /FROM mv_stock_idx/.test(q)).every((q) => /GROUP BY/.test(q)), 'getmeta tidak boleh memindai baris mentah');
});

test('Stock: halaman dibaca lewat _tidb_rowid (tanpa OFFSET/ORDER BY tabel penuh) dan hasilnya lengkap', async () => {
  const log = [];
  const rows = (await handlers.getrows.run({ db: fastDb({ log }), user: PUSAT }, [])).toJSON();
  assert.equal(rows.length, TOTAL);
  assert.ok(log.filter((q) => /_tidb_rowid|OFFSET/.test(q)).every((q) => !/OFFSET/.test(q) || /GROUP BY/.test(q)));
});

test('Stock: bila _tidb_rowid ditolak, jatuh ke cara OFFSET dan tetap lengkap', async () => {
  const rows = (await handlers.getrows.run({ db: fastDb({ rowid: false }), user: PUSAT }, [])).toJSON();
  assert.equal(rows.length, TOTAL);
});

test('Stock: bila jalur cepat (GROUP BY) ditolak database, cara lama tetap menghasilkan semua baris', async () => {
  const base = fastDb();
  const db = {
    async query(sql, a = []) {
      const s = sql.replace(/\s+/g, ' ');
      if (/GROUP BY|FROM toko x WHERE/.test(s)) throw new Error('ditolak');
      if (/_tidb_rowid/.test(s)) throw new Error('Unknown column _tidb_rowid');
      const m = /LIMIT (\d+) OFFSET (\d+)/.exec(s);
      return (/deskripsi/.test(s) ? full : all).slice(+m[2], +m[2] + +m[1]);
    },
    async exec() {},
  };
  const rows = (await handlers.getrows.run({ db, user: PUSAT }, [])).toJSON();
  assert.equal(rows.length, TOTAL);
  void base;
});
