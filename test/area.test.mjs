import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, makeUser, req, cookieOf } from './fakedb.mjs';
import { errorResponse } from '../functions/_lib/http.js';
import { resolveArea, readArea, packArea } from '../functions/_lib/area.js';
import { bamWhere, kodeWhere } from '../functions/_lib/scope.js';
import { parseScope } from '../functions/_lib/auth.js';
import * as login from '../functions/api/auth/login.js';
import * as me from '../functions/api/auth/me.js';
import * as reg from '../functions/api/auth/register.js';
import * as opt from '../functions/api/auth/area-options.js';
import * as us from '../functions/api/admin/users.js';
import * as rq from '../functions/api/admin/requests.js';

const env = { PBKDF2_ITER: '10000' };
const run = async (fn, ...a) => { try { return await fn(...a); } catch (e) { return errorResponse(e); } };
const J = (r) => r.json();

// toko: KOORBAM K1 -> BAM A (A1, A2), BAM B (B1); K2 -> BAM C (C1); tanpa KOORBAM -> BAM D (D1)
const H = [
  { k: 'K1', b: 'BAM A', c: 'A1' }, { k: 'K1', b: 'BAM A', c: 'A2' }, { k: 'K1', b: 'BAM B', c: 'B1' },
  { k: 'K2', b: 'BAM C', c: 'C1' }, { k: '', b: 'BAM D', c: 'D1' },
];
const rows = (s) => {
  if (/FROM toko WHERE bam IS NOT NULL/.test(s)) return H;
  if (/information_schema\.columns/.test(s)) return [{ n: 2000 }];
  return null;
};
const hdb = { async query(sql) { return rows(sql.replace(/\s+/g, ' ')) || []; } };

test('resolveArea: KOORBAM saja -> semua BAM di bawahnya, tanpa pembatas cabang', async () => {
  const r = await resolveArea(hdb, { koorbam: ['k1'] });
  assert.deepEqual([r.bam, r.cabang], [['BAM A', 'BAM B'], []]);
});

test('resolveArea: cabang sebagian -> pembatas; semua cabang BAM itu -> tanpa pembatas (cabang baru tetap ikut)', async () => {
  let r = await resolveArea(hdb, { bam: ['BAM A'], cabang: ['A1'] });
  assert.deepEqual([r.bam, r.cabang], [['BAM A'], ['A1']]);
  r = await resolveArea(hdb, { bam: ['BAM A'], cabang: ['A1', 'A2'] });
  assert.deepEqual([r.bam, r.cabang], [['BAM A'], []]);
});

test('resolveArea: pilihan saling terhubung (AND) dan banyak pilihan sekaligus', async () => {
  let r = await resolveArea(hdb, { koorbam: ['K1', 'K2'], bam: ['BAM B', 'BAM C'] });
  assert.deepEqual(r.bam, ['BAM B', 'BAM C']);
  r = await resolveArea(hdb, { cabang: ['C1', 'D1'] });                 // hanya cabang: BAM dihitung dari cabang
  assert.deepEqual([r.bam, r.cabang], [['BAM C', 'BAM D'], []]);        // C1 & D1 = semua cabang BAM C dan D
  await assert.rejects(resolveArea(hdb, { koorbam: ['K2'], bam: ['BAM A'] }), (e) => e.status === 400 && e.code === 'NO_MATCH');
});

test('resolveArea: kosong ditolak; nama tidak dikenal ditolak', async () => {
  await assert.rejects(resolveArea(hdb, {}), (e) => e.code === 'NO_SCOPE');
  await assert.rejects(resolveArea(hdb, { bam: ['BAM X'] }), (e) => e.code === 'NO_MATCH');
});

test('readArea / parseScope: format lama (array) dan baru (objek) sama-sama terbaca', () => {
  assert.deepEqual(parseScope('["bam a"," bam b"]'), ['BAM A', 'BAM B']);
  const v = JSON.stringify(packArea({ bam: ['BAM A'], cabang: ['A1'], sel: { k: [], b: ['BAM A'], c: ['A1'] } }));
  assert.deepEqual(parseScope(v), ['BAM A']);
  assert.deepEqual(readArea(v).cabang, ['A1']);
  assert.deepEqual(readArea(null), { bam: [], cabang: [], sel: { k: [], b: [], c: [] } });
});

test('scope: pembatas cabang masuk ke SQL sebagai parameter; tanpa cabang SQL tidak berubah', () => {
  const u0 = { jabatan: 'BAM', bam_scope: ['BAM A'], cabang_scope: [] };
  assert.deepEqual(bamWhere(u0, 'x.bam'), { sql: 'UPPER(TRIM(x.bam)) IN (?)', params: ['BAM A'] });
  const u1 = { jabatan: 'BAS', bam_scope: ['BAM A'], cabang_scope: ['A1', 'A2'] };
  assert.deepEqual(bamWhere(u1, 'x.bam'), { sql: '(UPPER(TRIM(x.bam)) IN (?) AND UPPER(TRIM(x.cabang)) IN (?,?))', params: ['BAM A', 'A1', 'A2'] });
  assert.deepEqual(bamWhere(u1, 'bam').sql, '(UPPER(TRIM(bam)) IN (?) AND UPPER(TRIM(cabang)) IN (?,?))');
  const k = kodeWhere(u1, 'kode');
  assert.match(k.sql, /FROM toko x WHERE UPPER\(TRIM\(x\.bam\)\) IN \(\?\) AND UPPER\(TRIM\(x\.cabang\)\) IN \(\?,\?\)\)$/);
  assert.deepEqual(k.params, ['BAM A', 'A1', 'A2']);
  assert.equal(bamWhere({ jabatan: 'ADMINISTRATOR' }, 'bam').sql, '1=1');
});

async function admin(extra = {}) {
  const db = fakeDb([await makeUser('P01', 'Benar1234', { jabatan: 'ADMIN_PUSAT', bam_scope: null })], { rows, ...extra });
  const cookie = cookieOf(await run(login.handle, { request: req('/api/auth/login', { body: { nik: 'P01', password: 'Benar1234' } }), env }, db));
  const post = (body) => run(us.handlePost, { request: req('/api/admin/users', { body, cookie }), env }, db);
  const get = () => run(us.handleGet, { request: req('/api/admin/users', { method: 'GET', cookie }), env }, db);
  return { db, cookie, post, get };
}

test('users: buat akun dengan KOORBAM/BAM/CABANG -> tersimpan terhitung; daftar & sesi membawa cabang_scope', async () => {
  const { db, post, get } = await admin();
  const r = await post({ action: 'create', nik: 'S01', nama: 'Sari', jabatan: 'BAS', area: { bam: ['BAM A'], cabang: ['A1'] }, password: 'Rahasia2026' });
  assert.equal(r.status, 200);
  const saved = JSON.parse(db.st.users.get('S01').bam_scope);
  assert.deepEqual([saved.bam, saved.cabang, saved.sel.b, saved.sel.c], [['BAM A'], ['A1'], ['BAM A'], ['A1']]);
  const g = await J(await get());
  const u = g.users.find((x) => x.nik === 'S01');
  assert.deepEqual([u.bam_scope, u.cabang_scope, u.area_text], [['BAM A'], ['A1'], 'BAM: BAM A · CABANG: A1']);
  assert.equal(g.hier.length, H.length);
  // login sebagai S01: data pengguna membawa pembatas cabang
  const lg = await J(await run(login.handle, { request: req('/api/auth/login', { body: { nik: 'S01', password: 'Rahasia2026' } }), env }, db));
  assert.deepEqual([lg.user.bam_scope, lg.user.cabang_scope], [['BAM A'], ['A1']]);
});

test('users: area kosong / tak cocok ditolak; cara lama (bam_scope array) tetap jalan', async () => {
  const { db, post } = await admin();
  assert.equal((await post({ action: 'create', nik: 'S02', nama: 'X', jabatan: 'BAS', area: {} })).status, 400);
  assert.equal((await post({ action: 'create', nik: 'S02', nama: 'X', jabatan: 'BAS', area: { bam: ['BAM X'] } })).status, 400);
  assert.equal((await post({ action: 'create', nik: 'S03', nama: 'Y', jabatan: 'BAM', bam_scope: ['bam a'], password: 'Rahasia2026' })).status, 200);
  assert.equal(db.st.users.get('S03').bam_scope, '["BAM A"]');
});

test('users: ubah area, dan ubah jabatan saja TIDAK menghapus pembatas cabang', async () => {
  const { db, post } = await admin();
  await post({ action: 'create', nik: 'S01', nama: 'Sari', jabatan: 'BAS', area: { koorbam: ['K1'], bam: ['BAM A'], cabang: ['A2'] }, password: 'Rahasia2026' });
  await post({ action: 'update', nik: 'S01', jabatan: 'BASTR' });
  let s = JSON.parse(db.st.users.get('S01').bam_scope);
  assert.deepEqual([db.st.users.get('S01').jabatan, s.bam, s.cabang, s.sel.k], ['BASTR', ['BAM A'], ['A2'], ['K1']]);
  await post({ action: 'update', nik: 'S01', area: { bam: ['BAM B', 'BAM C'] } });
  s = JSON.parse(db.st.users.get('S01').bam_scope);
  assert.deepEqual([s.bam, s.cabang], [['BAM B', 'BAM C'], []]);
});

test('area-options: daftar [KOORBAM, BAM, CABANG] untuk form Daftar tanpa login', async () => {
  const r = await run(opt.handle, {}, { async query(sql) { return rows(sql.replace(/\s+/g, ' ')) || []; } });
  const j = await J(r);
  assert.equal(j.h.length, H.length);
  assert.deepEqual(j.h[0], ['', 'BAM D', 'D1']);          // urut: tanpa KOORBAM dulu
});

test('daftar dengan pilihan dropdown -> tersimpan sebagai JSON, admin melihat ringkasan & dapat menyetujui', async () => {
  const db = fakeDb([await makeUser('P01', 'Benar1234', { jabatan: 'ADMIN_PUSAT', bam_scope: null })], { rows });
  const d = await run(reg.handle, { request: req('/api/auth/register', { body: { nik: '5001', nama: 'Sari Dewi', jabatan: 'BAS', area: { koorbam: ['K1'], bam: ['BAM A'], cabang: ['A1'] }, password: 'Rahasia2026' } }), env }, db);
  assert.equal(d.status, 200);
  assert.deepEqual(JSON.parse(db.st.regs[0].area_diminta), { k: ['K1'], b: ['BAM A'], c: ['A1'] });
  assert.equal((await run(reg.handle, { request: req('/api/auth/register', { body: { nik: '5002', nama: 'Budi Hari', jabatan: 'BAS', area: { bam: ['BAM Z'] }, password: 'Rahasia2026' } }), env }, db)).status, 400);   // tak ada di data toko
  const cookie = cookieOf(await run(login.handle, { request: req('/api/auth/login', { body: { nik: 'P01', password: 'Benar1234' } }), env }, db));
  const g = await J(await run(rq.handleGet, { request: req('/api/admin/requests', { method: 'GET', cookie }), env }, db));
  assert.equal(g.registrations[0].area_diminta, 'KOORBAM: K1 · BAM: BAM A · CABANG: A1');
  assert.deepEqual(g.registrations[0].area_sel, { k: ['K1'], b: ['BAM A'], c: ['A1'] });
  assert.equal(g.hier.length, H.length);
  const ok = await run(rq.handlePost, { request: req('/api/admin/requests', { body: { action: 'approve', id: g.registrations[0].id, jabatan: 'BAS', area: { bam: ['BAM A'], cabang: ['A1'] } }, cookie }), env }, db);
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(db.st.users.get('5001').bam_scope).cabang, ['A1']);
});
