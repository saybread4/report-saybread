// Daftar fungsi data. Setiap fungsi: { need: 'view'|'edit'|'pusat', run({db,user,env}, a) }
// Semua fungsi baca WAJIB memakai bamWhere()/kodeWhere() supaya data dibatasi sesuai area pengguna.
//
// Tahap ini baru berisi empat fungsi contoh (pola yang sama dipakai untuk sisanya).
import { bamWhere } from '../scope.js';
import { norm, nz, num } from '../util.js';

const byText = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

export const handlers = {
  // Peta organisasi per toko: kode -> [bas, bastr, am, as, wilayah, domain, kriteria]
  getorg: {
    need: 'view',
    async run({ db, user }) {
      const w = bamWhere(user, 'bam');
      const rows = await db.query(
        `SELECT kode, bas, bastr, am, \`as\` AS as_, wilayah, domain, kriteria FROM toko WHERE ${w.sql}`, w.params);
      const m = {};
      for (const r of rows) {
        const k = norm(r.kode);
        if (k) m[k] = [nz(r.bas), nz(r.bastr), nz(r.am), nz(r.as_), nz(r.wilayah), nz(r.domain), nz(r.kriteria)];
      }
      return { warn: '', m };
    },
  },

  // Matriks BAM x Cabang: jumlah toko pada tiap pasangan
  getbam: {
    need: 'view',
    async run({ db, user }) {
      const w = bamWhere(user, 'bam');
      const rows = await db.query(`SELECT bam, cabang FROM toko WHERE ${w.sql}`, w.params);
      const pairs = rows.map((r) => [nz(r.bam), nz(r.cabang)]).filter(([b, c]) => b && c);
      const bams = [...new Set(pairs.map((p) => p[0]))].sort(byText);
      const cabs = [...new Set(pairs.map((p) => p[1]))].sort(byText);
      const bi = new Map(bams.map((v, i) => [v, i]));
      const ci = new Map(cabs.map((v, i) => [v, i]));
      const cnt = new Map();
      for (const [b, c] of pairs) {
        const key = bi.get(b) * 100000 + ci.get(c);
        cnt.set(key, (cnt.get(key) || 0) + 1);
      }
      const out = [...cnt].map(([key, j]) => [Math.floor(key / 100000), key % 100000, j]);
      return { bam: bams, cab: cabs, rows: out, warn: '' };
    },
  },

  // PNL per CAB PNL per bulan — hanya CAB PNL yang dimiliki toko di area pengguna
  getpnlcabang: {
    need: 'view',
    async run({ db, user }) {
      const w = bamWhere(user, 'bam');
      const rows = await db.query(
        `SELECT tahun, bln, cab_pnl, pnl FROM pnl_cabang
          WHERE cab_pnl IN (SELECT DISTINCT cab_pnl FROM toko WHERE ${w.sql})
          ORDER BY tahun, bln, cab_pnl`, w.params);
      return { rows: rows.map((r) => [num(r.tahun), num(r.bln), r.cab_pnl, num(r.pnl)]) };
    },
  },

  // Peta nama deskripsi -> PLU (data master item, sama untuk semua jabatan)
  getplu: {
    need: 'view',
    async run({ db }) {
      const rows = await db.query('SELECT plu, deskripsi FROM item ORDER BY plu');
      const out = {};
      for (const r of rows) {
        const k = norm(r.deskripsi);
        const p = nz(r.plu);
        if (k && p && !String(r.plu).startsWith('#') && !(k in out)) out[k] = r.plu;
      }
      return out;
    },
  },
};
