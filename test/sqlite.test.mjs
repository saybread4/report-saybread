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
    // meniru db.tx() produksi: BEGIN ... COMMIT, atau ROLLBACK bila ada yang gagal
    async tx(fn) {
      raw.exec('BEGIN');
      try { const r = await fn(db); raw.exec('COMMIT'); return r; } catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
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
    assert.ok(db.log.some((s) => /GROUP BY s\.\w+, t\.tanggal/.test(s)), 'harus memakai agregasi SQL');
    assert.deepEqual(flatten(out), expected(data, user, null));
    // baris November (kode ber-spasi) harus ikut terhitung
    const nov = [...flatten(out).cab].filter(([k]) => k.includes('2026-11'));
    assert.ok(nov.length > 0 && nov.some(([, v]) => v.q > 0), 'data November tidak boleh kosong');
    assert.deepEqual(out.ovr, { 'BAS|BAS1|2026-11|rp': 5 });
  });

  test(`Rank (${nama}): cara lama (cadangan) menghasilkan angka yang sama`, async () => {
    let data; const db = sqliteDb((raw) => { data = rankData(raw); });
    const lama = { ...db, async query(sql, a) { if (/GROUP BY s\.\w+, t\.tanggal/.test(sql)) throw new Error('simulasi: SQL agregasi gagal'); return db.query(sql, a); } };
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

// ---- Refresh: potongan per bulan / bagian kode harus menghasilkan isi yang SAMA dengan satu perintah penuh ----
import { refreshStep } from '../functions/_lib/handlers/refresh.js';

function refreshDb() {
  const db = sqliteDb((raw) => {
    raw.function('CRC32', (s) => { let c = ~0; for (const ch of Buffer.from(String(s))) { c ^= ch; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; } return (~c) >>> 0; });
    raw.function('DATE_FORMAT', (d, f) => (f === '%Y-%m' ? String(d).slice(0, 7) : d));
    raw.exec('DROP TABLE sales_toko');
    raw.exec(`
      CREATE TABLE sales_toko (tanggal TEXT, kode TEXT COLLATE RTRIM, produksi REAL, sales_qty INT, sales_rp INT, margin INT, ba_qty INT, ba_rp INT);
      CREATE TABLE stock_toko (id INTEGER PRIMARY KEY, tanggal TEXT, kode TEXT, jenis TEXT, stock_total INT);
      CREATE TABLE sales_item (ket TEXT, tahun INT, bulan INT, kode TEXT, deskripsi TEXT, produksi REAL, sales_qty INT, margin INT, sales_rp INT, ba_qty INT, ba_rp INT);
      CREATE TABLE mv_mon_list (mk TEXT, y INT, b INT, hari INT, mi INT);
      CREATE TABLE mv_mon_rows (kode TEXT, knorm TEXT, ds TEXT, mi INT, prod REAL, qty INT, rp REAL, baq INT, barp REAL);
      CREATE TABLE mv_mon_same (kode TEXT, knorm TEXT, ds TEXT, mi INT, prod REAL, qty INT, rp REAL, baq INT, barp REAL);
    `);
    raw.exec('DROP TABLE mv_tgl'); raw.exec('CREATE TABLE mv_tgl (kode TEXT, tanggal TEXT, stock_qty INT, prod REAL, qty INT, rp INT, mg INT, baq INT, barp INT)');
    const sale = [], stk = [], item = [];
    const months = [['2026-10', 31], ['2026-11', 19], ['2026-12', 5], ['2027-01', 3]];
    for (let i = 0; i < 40; i++) {
      const kode = 'G' + String(100 + i) + (i % 9 === 0 ? ' ' : '');
      for (const [ym, days] of months) {
        for (let d = 1; d <= days; d += 6) {
          const tg = `${ym}-${String(d).padStart(2, '0')}`;
          sale.push({ tanggal: tg, kode, produksi: i + d, sales_qty: i, sales_rp: i * 100, margin: i, ba_qty: d % 2, ba_rp: d });
          stk.push({ tanggal: tg, kode, jenis: i % 2 ? 'DOUGH' : 'Dough Beku', stock_total: 3 });
          if (i % 5 === 0) stk.push({ tanggal: tg, kode, jenis: 'LAIN', stock_total: 99 });   // bukan DOUGH: harus diabaikan
        }
        for (const ket of ['closing', 'tgl_yang_sama']) for (const ds of ['Roti A', 'Roti B ', 'Roti C'])
          item.push({ ket, tahun: Number(ym.slice(0, 4)), bulan: Number(ym.slice(5)), kode, deskripsi: ds, produksi: i, sales_qty: ds === 'Roti C' && i % 2 ? 0 : i + 1, margin: 1, sales_rp: ds === 'Roti C' && i % 2 ? 0 : i * 10, ba_qty: 0, ba_rp: 0 });
      }
    }
    ins(raw, 'sales_toko', sale); ins(raw, 'stock_toko', stk); ins(raw, 'sales_item', item);
    ins(raw, 'mv_mon_list', months.map(([ym], mi) => ({ mk: ym + '-01', y: Number(ym.slice(0, 4)), b: Number(ym.slice(5)), hari: 1, mi })));
  });
  db.run = async (step) => { let sub = 0, n = 0; do { const r = await refreshStep(db, step, sub); sub = r.next; n++; } while (sub != null); return n; };
  const orig = db.exec; db.exec = async (sql, a = []) => orig(sql.replace(/^\s*TRUNCATE TABLE (\w+)/, 'DELETE FROM $1'), a);
  return db;
}
const rowsOf = (db, sql) => db.raw.prepare(sql).all().map((r) => JSON.stringify(Object.values(r))).sort();

test('refresh mv_tgl per bulan = gabungan penuh (stock DOUGH dijumlahkan, jenis lain diabaikan, lintas tahun)', async () => {
  const db = refreshDb();
  assert.equal(await db.run(3), 12);                                                           // 4 bulan x 3 jendela = 12 potongan
  const ref = rowsOf(db, `SELECT s.kode, s.tanggal, COALESCE(st.q, 0), s.produksi, s.sales_qty, s.sales_rp, s.margin, s.ba_qty, s.ba_rp
      FROM sales_toko s LEFT JOIN (SELECT kode, tanggal, SUM(stock_total) AS q FROM stock_toko WHERE UPPER(jenis) LIKE 'DOUGH%' GROUP BY kode, tanggal) st
        ON st.kode = s.kode AND st.tanggal = s.tanggal`);
  const got = rowsOf(db, 'SELECT * FROM mv_tgl');
  assert.equal(got.length, db.raw.prepare('SELECT COUNT(*) n FROM sales_toko').get().n);
  assert.deepEqual(got, ref);
  assert.equal(await db.run(3), 12);                                                           // diulang: tidak menggandakan baris
  assert.deepEqual(rowsOf(db, 'SELECT * FROM mv_tgl'), ref);
});

for (const [step, tbl, ket] of [[4, 'mv_mon_rows', 'closing'], [5, 'mv_mon_same', 'tgl_yang_sama']]) {
  test(`refresh ${tbl}: potongan per bulan x 4 bagian kode = satu perintah penuh; tiap kode ada di tepat satu bagian`, async () => {
    const db = refreshDb();
    assert.equal(await db.run(step), 16);                                                       // 4 bulan x 4 bagian
    const having = step === 4 ? `HAVING COALESCE(SUM(i.produksi),0) <> 0 OR COALESCE(SUM(i.sales_qty),0) <> 0 OR COALESCE(SUM(i.sales_rp),0) <> 0 OR COALESCE(SUM(i.ba_qty),0) <> 0 OR COALESCE(SUM(i.ba_rp),0) <> 0` : '';
    const ref = rowsOf(db, `SELECT i.kode, UPPER(REGEXP_REPLACE(COALESCE(i.kode,''),'[^A-Za-z0-9]','')), TRIM(i.deskripsi), mm.mi,
        SUM(i.produksi), SUM(i.sales_qty), SUM(i.sales_rp), SUM(i.ba_qty), SUM(i.ba_rp)
      FROM sales_item i JOIN mv_mon_list mm ON mm.y = i.tahun AND mm.b = i.bulan WHERE i.ket = '${ket}' GROUP BY i.kode, TRIM(i.deskripsi), mm.mi ${having}`);
    const got = rowsOf(db, `SELECT * FROM ${tbl}`);
    assert.ok(got.length > 100, 'harus ada isi');
    assert.deepEqual(got, ref);
    const dupe = db.raw.prepare(`SELECT COUNT(*) n FROM (SELECT kode, ds, mi FROM ${tbl} GROUP BY kode, ds, mi HAVING COUNT(*) > 1)`).get().n;
    assert.equal(dupe, 0);                                                                      // tidak ada baris ganda antar-potongan
    assert.equal(await db.run(step), 4);                                                        // diulang: 4 bulan tidak berubah -> 4 panggilan (tiap bulan dilewati sekaligus)
    assert.deepEqual(rowsOf(db, `SELECT * FROM ${tbl}`), ref);
    if (step === 4) assert.ok(!got.some((r) => { const x = JSON.parse(r); return x[2] === 'Roti C' && x[4] === 0 && x[5] === 0 && x[6] === 0; }), 'baris semuanya nol harus dibuang (HAVING)');
  });
}


// ---- Refresh inkremental pada database sungguhan: yang tidak berubah tidak ditulis ulang, yang berubah diganti dengan benar ----
const writes = (db, re) => db.log.filter((q) => re.test(q.replace(/\s+/g, ' ').trim())).length;
for (const [step, tbl, ket] of [[4, 'mv_mon_rows', 'closing'], [5, 'mv_mon_same', 'tgl_yang_sama']]) {
  test(`refresh inkremental ${tbl}: tanpa perubahan tidak menulis; satu bulan berubah -> hanya bulan itu diganti dan hasil = hitung penuh`, async () => {
    const db = refreshDb();
    await db.run(step);
    const full = rowsOf(db, `SELECT * FROM ${tbl}`);
    db.log.length = 0;
    await db.run(step);
    assert.equal(writes(db, new RegExp(`^INSERT INTO ${tbl}`)), 0, 'data sama: tidak ada INSERT');
    assert.equal(writes(db, new RegExp(`^DELETE FROM ${tbl} WHERE mi = `)), 0);
    assert.deepEqual(rowsOf(db, `SELECT * FROM ${tbl}`), full);
    db.raw.exec(`UPDATE sales_item SET sales_qty = sales_qty + 7, sales_rp = sales_rp + 70 WHERE ket = '${ket}' AND tahun = 2026 AND bulan = 11`);
    db.log.length = 0;
    await db.run(step);
    assert.equal(writes(db, new RegExp(`^INSERT INTO ${tbl}`)), 4, 'hanya satu bulan x 4 bagian yang diisi ulang');
    const ref = refreshDb(); ref.raw.exec(`UPDATE sales_item SET sales_qty = sales_qty + 7, sales_rp = sales_rp + 70 WHERE ket = '${ket}' AND tahun = 2026 AND bulan = 11`);
    await ref.run(step);
    assert.deepEqual(rowsOf(db, `SELECT * FROM ${tbl}`), rowsOf(ref, `SELECT * FROM ${tbl}`), 'sama dengan hitung dari nol');
  });
}

test('refresh inkremental mv_tgl: jendela tak berubah dilewati; perubahan satu hari hanya mengganti jendelanya', async () => {
  const db = refreshDb();
  await db.run(3);
  db.log.length = 0;
  await db.run(3);
  assert.equal(writes(db, /^INSERT INTO mv_tgl/), 0, 'data sama: tidak ada INSERT');
  const before = rowsOf(db, 'SELECT * FROM mv_tgl');
  db.raw.exec("UPDATE sales_toko SET sales_rp = sales_rp + 500 WHERE tanggal = '2026-11-07'");
  db.raw.exec("UPDATE stock_toko SET stock_total = stock_total + 1 WHERE tanggal = '2026-12-01' AND UPPER(jenis) LIKE 'DOUGH%'");
  db.log.length = 0;
  await db.run(3);
  assert.equal(writes(db, /^INSERT INTO mv_tgl/), 2, 'hanya dua jendela (7 Nov dan 1 Des) yang diganti');
  const ref = refreshDb();
  ref.raw.exec("UPDATE sales_toko SET sales_rp = sales_rp + 500 WHERE tanggal = '2026-11-07'");
  ref.raw.exec("UPDATE stock_toko SET stock_total = stock_total + 1 WHERE tanggal = '2026-12-01' AND UPPER(jenis) LIKE 'DOUGH%'");
  await ref.run(3);
  assert.deepEqual(rowsOf(db, 'SELECT * FROM mv_tgl'), rowsOf(ref, 'SELECT * FROM mv_tgl'));
  assert.notDeepEqual(rowsOf(db, 'SELECT * FROM mv_tgl'), before);
});


// ---- Refresh harus AMAN: gagal di tengah tidak boleh menghilangkan data yang sudah ada ----------------------
test('refresh mv_tgl: gagal di tengah (mis. 503) -> data lama tetap utuh, potongan yang gagal dibatalkan, ulang berhasil', async () => {
  const db = refreshDb();
  await db.run(3);
  const before = rowsOf(db, 'SELECT * FROM mv_tgl');
  assert.ok(before.length > 100);

  // data penjualan baru masuk (mis. 23 Nov), lalu refresh gagal pada jendela tertentu
  db.raw.prepare("INSERT INTO sales_toko (tanggal, kode, produksi, sales_qty, sales_rp, margin, ba_qty, ba_rp) VALUES ('2026-11-23', 'G100', 1, 9, 900, 1, 0, 0)").run();
  const realExec = db.exec; let boom = true;
  db.exec = async (sql, a = []) => { if (boom && /^\s*INSERT INTO mv_tgl/.test(sql) && a[0] === '2026-11-21') throw new Error('HTTP 503'); return realExec(sql, a); };
  await assert.rejects(db.run(3), /503/);
  const mid = rowsOf(db, 'SELECT * FROM mv_tgl');
  // jendela 21-30 Nov dibatalkan utuh (baris lama tetap ada), jendela lain sudah terganti -> tidak ada yang kosong
  assert.ok(mid.length >= before.length, 'jumlah baris tidak boleh berkurang karena kegagalan');
  for (const r of before) assert.ok(mid.includes(r), 'baris lama hilang: ' + r);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM mv_tgl WHERE tanggal = '2026-11-23'").get().n, 0, 'jendela yang gagal tidak setengah terisi');

  boom = false;                                              // diulang setelah gangguan reda
  await db.run(3);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM mv_tgl WHERE tanggal = '2026-11-23'").get().n, 1, 'data 23 Nov harus masuk');
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM mv_tgl').get().n, db.raw.prepare('SELECT COUNT(*) n FROM sales_toko').get().n);
});

test('refresh langkah ringan (tanggal/toko/bulan): gagal di tengah -> isi lama tetap, tidak kosong', async () => {
  const db = refreshDb();
  await db.run(0);
  const before = rowsOf(db, 'SELECT * FROM mv_dates');
  assert.ok(before.length > 0);
  db.raw.prepare("INSERT INTO sales_toko (tanggal, kode, produksi, sales_qty, sales_rp, margin, ba_qty, ba_rp) VALUES ('2026-11-23', 'G100', 1, 9, 900, 1, 0, 0)").run();
  const realExec = db.exec;
  db.exec = async (sql, a = []) => { if (/^\s*INSERT INTO mv_dates/.test(sql)) throw new Error('HTTP 503'); return realExec(sql, a); };
  await assert.rejects(db.run(0), /503/);
  assert.deepEqual(rowsOf(db, 'SELECT * FROM mv_dates'), before);
});


// ---- Driver TiDB memotong hasil di 10.000 baris: pembacaan besar harus dipaginasi ------------------------------
test('gettanggalcab: 40 toko x 62 hari (2.480 baris) aman; 300 toko x 62 hari (18.600 baris) tetap lengkap walau driver memotong di 10.000', async () => {
  const db = sqliteDb((raw) => {
    const toko = [], ks = [], tgl = [], dates = [];
    for (let d = 0; d < 62; d++) dates.push(d < 31 ? `2026-10-${String(d + 1).padStart(2, '0')}` : `2026-11-${String(d - 30).padStart(2, '0')}`);
    for (let i = 0; i < 300; i++) {
      const kode = 'G' + String(1000 + i);
      toko.push({ kode, toko: 'T' + i, cab_pnl: 'P1', cabang: 'SBY', bam: 'BAM A' });
      ks.push({ ki: i, kode, toko: 'T' + i, cabang: 'SBY', cabpnl: 'P1' });
      for (const d of dates) tgl.push({ kode, tanggal: d, stock_qty: 0, prod: 1, qty: 2, rp: 100, mg: 0, baq: 0, barp: 0 });
    }
    ins(raw, 'toko', toko); ins(raw, 'mv_ks', ks); ins(raw, 'mv_tgl', tgl);
    ins(raw, 'mv_dates', dates.map((tanggal, di) => ({ tanggal, di })));
  });
  const real = db.query;
  db.query = async (sql, a = []) => (await real(sql, a)).slice(0, 10000);        // meniru pemotongan driver
  const r = await handlers.gettanggalcab.run({ db, user: users.pusat }, [[], []]);
  assert.equal(r.ns, 300);
  assert.equal(r.rows.length, 62, 'semua 62 tanggal harus ada, termasuk 23 November dan seterusnya');
  for (const row of r.rows) assert.equal(row[8], 300, 'tiap hari harus memuat semua 300 toko');
  assert.equal(r.rows.reduce((s, x) => s + x[3], 0), 300 * 62 * 2);
});


test('Rank: 60 hari -> dipecah jadi rentang tanggal, berurutan, paling banyak 24 query; hasil lengkap semua tanggal', async () => {
  const dates = [];
  for (let d = 0; d < 60; d++) dates.push(d < 31 ? `2026-10-${String(d + 1).padStart(2, '0')}` : `2026-11-${String(d - 30).padStart(2, '0')}`);
  const db = sqliteDb((raw) => {
    ins(raw, 'toko', [{ kode: 'G1', toko: 'T', cab_pnl: 'P', cabang: 'SBY', bam: 'BAM A', bas: 'B', bastr: 'S', am: 'A', as: 'X' }]);
    ins(raw, 'mv_ks', [{ ki: 0, kode: 'G1', toko: 'T', cabang: 'SBY', cabpnl: 'P' }]);
    ins(raw, 'mv_dates', dates.map((tanggal, di) => ({ tanggal, di })));
    ins(raw, 'mv_tgl', dates.map((tanggal) => ({ kode: 'G1', tanggal, stock_qty: 0, prod: 1, qty: 3, rp: 300, mg: 0, baq: 0, barp: 0 })));
  });
  let aktif = 0, maks = 0; const real = db.query;
  db.query = async (sql, a) => { if (/FROM mv_tgl t/.test(sql)) { aktif++; maks = Math.max(maks, aktif); await new Promise((r) => setTimeout(r, 1)); aktif--; } return real(sql, a); };
  const out = await handlers.getrankcab.run({ db, user: users.pusat }, [[]]);
  assert.equal(out.cab.rows.length, 60);
  assert.equal(out.cab.rows.reduce((s, r) => s + r[3], 0), 60 * 300);
  assert.equal(maks, 1, 'query agregasi tidak boleh berjalan serentak');
  assert.ok(db.log.filter((s) => /FROM mv_tgl t/.test(s)).length <= 24);
});
