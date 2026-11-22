// Menjalankan handler terhadap database SQL sungguhan (SQLite bawaan Node) supaya SQL-nya benar-benar dieksekusi.
// Kolom kode memakai COLLATE RTRIM agar meniru perilaku TiDB/MySQL (spasi di belakang diabaikan saat membandingkan).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handlers } from '../functions/_lib/handlers/index.js';
import { norm, nz } from '../functions/_lib/util.js';

function sqliteDb(setup) {
  const raw = new DatabaseSync(':memory:');
  raw.function('REGEXP_REPLACE', (s, p, r) => String(s == null ? '' : s).replace(new RegExp(p, 'g'), r));
  raw.function('UTC_TIMESTAMP', () => '2026-11-22 04:30:00');
  raw.exec(`
    CREATE TABLE toko (kode TEXT COLLATE RTRIM, toko TEXT, cab_pnl TEXT, cabang TEXT, bam TEXT, bas TEXT, bastr TEXT, am TEXT, "as" TEXT, wilayah TEXT, kriteria TEXT, domain TEXT);
    CREATE TABLE mv_ks (ki INT, kode TEXT COLLATE RTRIM, toko TEXT, cabang TEXT, cabpnl TEXT);
    CREATE TABLE mv_dates (tanggal TEXT, di INT);
    CREATE TABLE mv_tgl (kode TEXT COLLATE RTRIM, tanggal TEXT, stock_qty INT, prod REAL, qty REAL, rp REAL, mg REAL, baq REAL, barp REAL);
    CREATE TABLE rank_override (key TEXT, val REAL, updated_at TEXT);
    CREATE TABLE mv_stock_idx (kode TEXT, deskripsi TEXT, cab TEXT, bas TEXT, as_ TEXT, tk TEXT, tk_key TEXT, jn TEXT, qty INT, qpd REAL, md TEXT, i_cab INT, i_bas INT, i_as INT, i_tk INT, i_ds INT, i_jn INT, i_md INT);
    CREATE TABLE stock (tanggal TEXT, created_at TEXT);
    CREATE TABLE sales_toko (tanggal TEXT, kode TEXT);
    CREATE TABLE data_updates (nama TEXT PRIMARY KEY, updated_at TEXT);
  `);
  setup(raw);
  const db = {
    raw, log: [],
    async query(sql, a = []) { db.log.push(sql); return raw.prepare(sql).all(...a).map((r) => ({ ...r })); },
    async exec(sql, a = []) { db.log.push(sql); raw.prepare(sql).run(...a); },
  };
  return db;
}
const ins = (raw, table, rows) => {
  for (const r of rows) {
    const k = Object.keys(r);
    raw.prepare(`INSERT INTO ${table} (${k.map((c) => (c === 'as' ? '"as"' : c)).join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map((c) => r[c]));
  }
};

// ---- data sintetis untuk Rank ---------------------------------------------------------------------
const DATES = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-11-01', '2026-11-02', '2026-11-03'];
function rankData(raw) {
  const cab = ['SURABAYA', 'MALANG', 'KEDIRI', ''];
  const toko = [], ks = [], tgl = [];
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 24; i++) {
    const kode = 'G' + String(100 + i), c = cab[i % 4], bam = i % 3 === 0 ? 'BAM B' : 'BAM A';
    toko.push({ kode, toko: 'TOKO ' + i, cab_pnl: 'PNL' + (i % 2), cabang: c, bam, bas: i % 5 === 0 ? '0' : 'BAS' + (i % 3), bastr: i % 7 === 0 ? null : 'BSTR' + (i % 2), am: 'AM' + (i % 4), as: 'AS' + (i % 2) });
    ks.push({ ki: i, kode, toko: 'TOKO ' + i, cabang: c, cabpnl: 'PNL' + (i % 2) });
    DATES.forEach((d, di) => {
      const nov = d.startsWith('2026-11');
      // kode bulan November ditulis dengan spasi di belakang untuk sebagian toko (seperti hasil Excel)
      const k = nov && i % 2 === 0 ? kode + ' ' : kode;
      const qty = rnd() < 0.2 ? 0 : Math.round(rnd() * 50);
      tgl.push({ kode: k, tanggal: d, stock_qty: 0, prod: qty, qty, rp: qty * 1000, mg: 0, baq: qty ? 1 : 0, barp: qty * 50 });
    });
  }
  ins(raw, 'toko', toko); ins(raw, 'mv_ks', ks); ins(raw, 'mv_tgl', tgl);
  ins(raw, 'mv_dates', DATES.map((tanggal, di) => ({ tanggal, di })));
  ins(raw, 'rank_override', [{ key: 'BAS|BAS1|2026-11|rp', val: 5, updated_at: 'x' }]);
  return { toko, ks, tgl };
}

// Perhitungan acuan yang sengaja dibuat sederhana & independen dari kode produksi
function expected(data, user, wantCab) {
  const bam = new Set(user.bam_scope || []);
  const allowed = new Set(data.toko.filter((t) => ['ADMIN_PUSAT', 'ADMINISTRATOR'].includes(user.jabatan) || bam.has(t.bam)).map((t) => norm(t.kode)));
  const lab = (x) => (nz(x) === '' ? '(kosong)' : nz(x));
  const tokoBy = new Map(data.toko.map((t) => [norm(t.kode), t]));
  const res = { cab: new Map(), pnl: new Map(), bas: new Map(), bastr: new Map(), am: new Map(), as: new Map() };
  const sel = new Map(data.ks.filter((k) => allowed.has(norm(k.kode)) && (!wantCab || wantCab.map(norm).includes(norm(k.cabang)))).map((k) => [norm(k.kode), k]));
  for (const v of data.tgl) {
    const k = sel.get(norm(v.kode)); if (!k) continue;
    const t = tokoBy.get(norm(v.kode));
    const g = { cab: k.cabang === '' ? '(kosong)' : k.cabang, pnl: k.cabpnl, bas: lab(t.bas), bastr: lab(t.bastr), am: lab(t.am), as: lab(t.as) };
    for (const [dim, name] of Object.entries(g)) {
      const key = name + '|' + v.tanggal;
      const x = res[dim].get(key) || { q: 0, rp: 0, b: 0, n: 0, nq: 0 };
      x.q += v.qty; x.rp += v.rp; x.b += v.barp; x.n += 1; if (v.qty > 0) x.nq += 1;
      res[dim].set(key, x);
    }
  }
  return res;
}
// ubah keluaran handler menjadi peta yang sama dengan acuan
function flatten(out) {
  const res = {};
  for (const dim of ['cab', 'pnl', 'bas', 'bastr', 'am', 'as']) {
    res[dim] = new Map();
    for (const [gi, di, q, rp, b, n, nq] of out[dim].rows) res[dim].set(out[dim].names[gi] + '|' + out.dates[di], { q, rp, b, n, nq });
  }
  return res;
}

const users = { pusat: { jabatan: 'ADMIN_PUSAT', bam_scope: [] }, bamA: { jabatan: 'BAM', bam_scope: ['BAM A'] }, admin: { jabatan: 'ADMINISTRATOR', bam_scope: [] } };

for (const [nama, user] of Object.entries(users)) {
  test(`Rank (${nama}): hasil agregasi di database = perhitungan acuan, termasuk kode ber-spasi`, async () => {
    let data; const db = sqliteDb((raw) => { data = rankData(raw); });
    const out = await handlers.getrankcab.run({ db, user }, [[]]);
    assert.ok(db.log.some((s) => s.includes('GROUP BY grp')), 'harus memakai agregasi SQL');
    assert.deepEqual(flatten(out), expected(data, user, null));
    // baris November (kode ber-spasi) harus ikut terhitung
    const nov = [...flatten(out).cab].filter(([k]) => k.includes('2026-11'));
    assert.ok(nov.length > 0 && nov.some(([, v]) => v.q > 0), 'data November tidak boleh kosong');
    assert.deepEqual(out.ovr, { 'BAS|BAS1|2026-11|rp': 5 });
  });

  test(`Rank (${nama}): cara lama (cadangan) menghasilkan angka yang sama`, async () => {
    let data; const db = sqliteDb((raw) => { data = rankData(raw); });
    const lama = { ...db, async query(sql, a) { if (sql.includes('GROUP BY grp')) throw new Error('simulasi: SQL agregasi gagal'); return db.query(sql, a); } };
    const out = await handlers.getrankcab.run({ db: lama, user }, [[]]);
    assert.deepEqual(flatten(out), expected(data, user, null));
    const baru = await handlers.getrankcab.run({ db, user }, [[]]);
    assert.deepEqual(out, baru);
  });
}

test('Rank: filter cabang terpilih', async () => {
  let data; const db = sqliteDb((raw) => { data = rankData(raw); });
  const out = await handlers.getrankcab.run({ db, user: users.pusat }, [['Malang', 'KEDIRI']]);
  assert.deepEqual(flatten(out), expected(data, users.pusat, ['MALANG', 'KEDIRI']));
  assert.deepEqual([...out.cab.names].sort(), ['KEDIRI', 'MALANG']);
});

test('Rank: tanpa data harian sama sekali -> tidak error', async () => {
  const db = sqliteDb(() => {});
  const out = await handlers.getrankcab.run({ db, user: users.pusat }, [[]]);
  assert.deepEqual(out.cab, { names: [], rows: [] });
});

// ---- getmeta: daftar toko dari tabel toko, tanpa menunggu stock ----------------------------------------
test('getmeta: filter terisi dari tabel toko walau data stock KOSONG; Diperbarui tidak null', async () => {
  const db = sqliteDb((raw) => {
    ins(raw, 'toko', [
      { kode: 'G020', toko: 'YOGYAKARTA', cabang: 'YOGYA', bam: 'BAM A', bas: 'ANI', bastr: 'BUDI', am: 'CICI', as: 'DEDE' },
      { kode: 'G107', toko: 'PARUNG', cabang: 'BOGOR', bam: 'BAM B', bas: 'ANI', bastr: '0', am: 'EKA', as: '' },
    ]);
    ins(raw, 'sales_toko', [{ tanggal: '2026-11-19', kode: 'G020' }]);
    ins(raw, 'data_updates', [{ nama: 'toko', updated_at: '2026-11-22 03:00:00' }, { nama: 'sales_toko', updated_at: '2026-11-22 04:10:00' }]);
  });
  const m = await handlers.getmeta.run({ db, user: users.pusat });
  assert.deepEqual(m.d.tk, [['G020', 'YOGYAKARTA', 'CICI', 'BUDI'], ['G107', 'PARUNG', 'EKA', '']]);
  assert.deepEqual([m.d.cab, m.d.bas, m.d.as], [['YOGYA', 'BOGOR'], ['ANI'], ['DEDE', '']]);
  assert.deepEqual(m.srows, [[0, 0, 0, 0], [1, 0, 1, 1]]);
  assert.equal(m.updated, '22/11/2026 11:10');                       // 04:10 UTC = 11:10 WIB
  assert.deepEqual([m.tgl, m.qpd.bulan, m.qpd.hari], [null, 11, 19]);
  assert.deepEqual(await handlers.getrows.run({ db, user: users.pusat }), []);
  const a = await handlers.getmeta.run({ db, user: users.bamA });     // dibatasi area
  assert.deepEqual(a.d.tk, [['G020', 'YOGYAKARTA', 'CICI', 'BUDI']]);
  assert.equal(a.srows.length, 1);
});

test('getmeta: kamus stock tetap di posisi semula, toko yang sama (beda tulisan kode) tidak dobel, toko lain ditambahkan', async () => {
  const stockRow = { kode: 'g-020', deskripsi: 'ROTI', cab: 'YOGYA', bas: 'ANI', as_: 'DEDE', tk: JSON.stringify(['g-020', 'YOGYAKARTA', 'CICI', 'BUDI']), tk_key: 'g-020|YOGYAKARTA|CICI|BUDI', jn: 'DOUGH', qty: 5, qpd: 1.5, md: 'RSBD', i_cab: 0, i_bas: 0, i_as: 0, i_tk: 0, i_ds: 0, i_jn: 0, i_md: 0 };
  const db = sqliteDb((raw) => {
    ins(raw, 'mv_stock_idx', [stockRow]);
    ins(raw, 'stock', [{ tanggal: '2026-11-19', created_at: '2026-11-21 02:00:00' }]);
    ins(raw, 'toko', [
      { kode: 'G020', toko: 'YOGYAKARTA', cabang: 'YOGYA', bam: 'BAM A', bas: 'ANI', bastr: 'BUDI', am: 'CICI', as: 'DEDE' },
      { kode: 'G107', toko: 'PARUNG', cabang: 'BOGOR', bam: 'BAM B', bas: 'ZAKI', bastr: '', am: 'EKA', as: '' },
    ]);
  });
  const m = await handlers.getmeta.run({ db, user: users.pusat });
  assert.deepEqual(m.d.tk.map((t) => t[0]), ['g-020', 'G107']);              // yang dari stock tetap indeks 0
  assert.deepEqual(m.d.bas, ['ANI', 'ZAKI']);
  assert.deepEqual(m.srows, [[0, 0, 0, 0], [1, 1, 1, 1]]);
  assert.equal(m.updated, '21/11/2026 09:00');                               // cadangan: waktu isi stock (tabel data_updates kosong)
  assert.equal(m.tgl, '19/11/2026');
  const rows = await handlers.getrows.run({ db, user: users.pusat });
  assert.deepEqual(rows, [[0, 0, 0, 0, 0, 0, 5, 1.5, 0]]);                  // baris stock tidak berubah
});

test('getmeta: tabel data_updates belum dimigrasi -> tidak error', async () => {
  const db = sqliteDb(() => {});
  db.raw.exec('DROP TABLE data_updates');
  const m = await handlers.getmeta.run({ db, user: users.pusat });
  assert.equal(m.updated, null);
});
