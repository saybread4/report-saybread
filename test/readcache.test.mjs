import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, makeUser, req, cookieOf } from './fakedb.mjs';
import * as login from '../functions/api/auth/login.js';
import * as rpc from '../functions/api/rpc/[fn].js';
import { errorResponse } from '../functions/_lib/http.js';
import { _clearForTest } from '../functions/_lib/readcache.js';

const env = { PBKDF2_ITER: '10000' };
const run = async (fn, ...a) => { try { return await fn(...a); } catch (e) { return errorResponse(e); } };

async function setup(version) {
  _clearForTest();
  const toko = [{ bam: 'BAM A', cabang: 'C1' }, { bam: 'BAM B', cabang: 'C3' }];
  const state = { heavy: 0, version };
  const rows = (s, a) => {
    if (s.startsWith('SELECT MAX(updated_at) AS u, COUNT(*) AS n FROM data_updates')) return state.version == null ? [{ u: null, n: 0 }] : [{ u: state.version, n: 1 }];
    if (!s.startsWith('SELECT bam, cabang FROM toko WHERE')) return null;
    state.heavy++;
    if (s.includes('1=1')) return toko;
    return toko.filter((t) => a.includes(t.bam.toUpperCase()));
  };
  const db = fakeDb([
    await makeUser('P01', 'Benar1234', { jabatan: 'ADMIN_PUSAT', bam_scope: null }),
    await makeUser('B01', 'Benar1234', { jabatan: 'BAM', bam_scope: '["BAM A"]' }),
  ], { rows });
  const cookie = {};
  for (const n of ['P01', 'B01']) cookie[n] = cookieOf(await run(login.handle, { request: req('/api/auth/login', { body: { nik: n, password: 'Benar1234' } }), env }, db));
  const call = async (nik, fn = 'getbam') => {
    const r = await run(rpc.handle, { request: req('/api/rpc/' + fn, { body: { a: [] }, cookie: cookie[nik] }), env, params: { fn } }, db);
    assert.equal(r.status, 200);
    return { x: r.headers.get('X-Cache'), j: await r.json() };
  };
  return { state, call };
}

test('cache baca: pemanggilan kedua dengan versi data sama tidak menyentuh query berat', async () => {
  const { state, call } = await setup('2026-11-24 10:00:00');
  const a = await call('P01'); assert.equal(a.x, 'MISS'); assert.equal(state.heavy, 1);
  const b = await call('P01'); assert.equal(b.x, 'HIT'); assert.equal(state.heavy, 1, 'tidak ada query berat baru');
  assert.deepEqual(b.j, a.j);
});

test('cache baca: area pengguna ikut kunci (BAM tidak pernah menerima hasil Pusat) dan versi baru membatalkan cache', async () => {
  const { state, call } = await setup('2026-11-24 10:00:00');
  const p = await call('P01'); const b = await call('B01');
  assert.deepEqual(p.j.bam, ['BAM A', 'BAM B']); assert.deepEqual(b.j.bam, ['BAM A']); assert.equal(b.x, 'MISS');
  assert.equal((await call('B01')).x, 'HIT'); assert.deepEqual((await call('B01')).j.bam, ['BAM A']);
  state.version = '2026-11-24 11:00:00';                     // ada unggahan/refresh baru
  assert.equal((await call('P01')).x, 'MISS'); assert.equal(state.heavy, 3);
});

test('cache baca: tanpa versi data (data_updates kosong/tidak ada) tidak di-cache', async () => {
  const { state, call } = await setup(null);
  assert.equal((await call('P01')).x, null); assert.equal((await call('P01')).x, null); assert.equal(state.heavy, 2);
});

// ---- Cache besar di TiDB (read_cache): hasil bisa dibaca utuh, potongan yang tidak lengkap ditolak ----
import { bigGet, bigPut } from '../functions/_lib/readcache.js';
function memTable() {
  const rows = [];
  return {
    rows,
    async exec(sql, a = []) {
      if (/^CREATE TABLE/.test(sql)) return;
      if (/^DELETE FROM read_cache/.test(sql)) { for (let i = rows.length - 1; i >= 0; i--) if (rows[i].k === a[0]) rows.splice(i, 1); return; }
      if (/^INSERT INTO read_cache/.test(sql)) { for (let i = 0; i < a.length; i += 4) rows.push({ k: a[i], part: a[i + 1], n: a[i + 2], body: a[i + 3] }); }
    },
    async query(sql, a = []) { return rows.filter((r) => r.k === a[0]).sort((x, y) => x.part - y.part); },
  };
}
test('read_cache: teks besar disimpan terpotong dan dibaca utuh; tulis terputus dianggap tidak ada', async () => {
  const db = memTable();
  const text = '[' + Array.from({ length: 200000 }, (_, i) => `[${i},1,2]`).join(',') + ']';   // ~2 MB
  await bigPut(db, 'abc', text);
  assert.ok(db.rows.length > 5);
  assert.equal(await bigGet(db, 'abc'), text);
  assert.equal(await bigGet(db, 'lain'), null);
  db.rows.pop();                                                     // simulasi tulis terputus
  assert.equal(await bigGet(db, 'abc'), null);
  await bigPut(db, 'abc', '[1]');                                    // menimpa isi lama sepenuhnya
  assert.equal(await bigGet(db, 'abc'), '[1]');
});
