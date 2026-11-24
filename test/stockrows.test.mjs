import test from 'node:test';
import assert from 'node:assert/strict';
import { handlers } from '../functions/_lib/handlers/index.js';

// Meniru driver TiDB: hasil tanpa LIMIT dipotong diam-diam di 10.000 baris.
const TOTAL = 23456;
const all = Array.from({ length: TOTAL }, (_, i) => ({ kode: 'K' + String(i).padStart(6, '0'), qty: 1, qpd: 1, i_cab: 0, i_bas: 0, i_as: 0, i_tk: i % 700, i_ds: i % 30, i_jn: 0, i_md: 0 }));
const db = {
  async query(sql) {
    if (!/FROM mv_stock_idx/.test(sql)) return [];
    const m = /LIMIT (\d+) OFFSET (\d+)/.exec(sql);
    return m ? all.slice(+m[2], +m[2] + +m[1]) : all.slice(0, 10000);
  },
  async exec() {},
};

test('Stock: getrows membaca SEMUA baris mv_stock_idx, bukan hanya 10.000 pertama', async () => {
  const user = { jabatan: 'ADMIN_PUSAT', bam_scope: null };
  const rows = await handlers.getrows.run({ db, user }, []);
  assert.equal(rows.length, TOTAL);
});
