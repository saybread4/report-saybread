// Daftar fungsi data. Setiap fungsi: { need: 'view'|'edit'|'pusat', run({db,user,env}, a) }
// Semua fungsi baca WAJIB memakai bamWhere()/kodeWhere() supaya data dibatasi sesuai area pengguna.
//
import { bamWhere } from '../scope.js';
import { canRankBam } from '../auth.js';
import { norm, nz, num } from '../util.js';
import { queryAll } from '../ks.js';
import { readHandlers } from './read.js';
import { refreshHandlers } from './refresh.js';
import { adminHandlers } from './admin.js';

const byText = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

const baseHandlers = {
  // Peta organisasi per toko: kode -> [bas, bastr, am, as, wilayah, domain, kriteria]
  getorg: {
    need: 'view',
    async run({ db, user }) {
      const w = bamWhere(user, 'bam');
      const rows = await queryAll(db,
        `SELECT kode, bas, bastr, am, \`as\` AS as_, wilayah, domain, kriteria FROM toko WHERE ${w.sql}`, w.params, 'kode');
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
      const rows = await queryAll(db, `SELECT bam, cabang FROM toko WHERE ${w.sql}`, w.params, 'bam, cabang');
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

  // Filter KOORBAM di halaman Rank: kombinasi (k_bam, bam, cabang) dari kolom toko.k_bam. Hanya untuk jabatan yang boleh melihat Rank BAM
  // (jabatan lain mendapat daftar kosong) dan dibatasi area pengguna. Toko tanpa k_bam diabaikan (di layar: "(Belum ada KOORBAM)").
  // Bila kolom k_bam belum ada di tabel toko, hasilnya kosong + warn (filter KOORBAM kosong, filter lain tetap jalan).
  getkoorbam: {
    need: 'view',
    async run({ db, user }) {
      if (!canRankBam(user)) return { list: [] };
      const w = bamWhere(user, 'bam');
      try {
        const rows = await queryAll(db,
          `SELECT TRIM(k_bam) AS kb, TRIM(bam) AS bam, TRIM(cabang) AS cab FROM toko
            WHERE ${w.sql} AND TRIM(COALESCE(k_bam, '')) NOT IN ('', '0') GROUP BY TRIM(k_bam), TRIM(bam), TRIM(cabang)`,
          w.params, 'kb, bam, cab');
        return { list: rows.map((r) => [String(r.kb), String(r.bam == null ? '' : r.bam), String(r.cab == null ? '' : r.cab)]) };
      } catch (e) {
        return { list: [], warn: 'Kolom k_bam belum ada di tabel toko.' };
      }
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

export const handlers = { ...baseHandlers, ...readHandlers, ...refreshHandlers, ...adminHandlers };
