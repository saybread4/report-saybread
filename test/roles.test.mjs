import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeDb, makeUser, req, cookieOf } from './fakedb.mjs';
import { verifyPassword } from '../functions/_lib/security.js';
import { errorResponse } from '../functions/_lib/http.js';
import * as login from '../functions/api/auth/login.js';
import * as users from '../functions/api/admin/users.js';
import * as rq from '../functions/api/admin/requests.js';
import * as rpc from '../functions/api/rpc/[fn].js';

const env = { PBKDF2_ITER: '10000' };
const run = async (fn, ...a) => { try { return await fn(...a); } catch (e) { return errorResponse(e); } };
const J = (r) => r.json();
const doLogin = (db, nik, password, remember) => run(login.handle, { request: req('/api/auth/login', { body: { nik, password, remember } }), env }, db);
const sessionRow = (db) => db.st.log.filter((x) => /^INSERT INTO sessions/.test(x.sql.replace(/\s+/g, ' '))).at(-1);

async function setup() {
  const db = fakeDb([
    await makeUser('UTM', 'Benar1234', { jabatan: 'ADMIN_PUSAT', bam_scope: null }),
    await makeUser('SAYBREAD', 'Benar1234', { jabatan: 'ADMINISTRATOR', bam_scope: null }),
    await makeUser('B01', 'Benar1234', { jabatan: 'BAM' }),
  ]);
  const utama = cookieOf(await doLogin(db, 'UTM', 'Benar1234'));
  const adm = cookieOf(await doLogin(db, 'saybread', 'Benar1234'));     // huruf kecil: NIK/username dinormalkan
  return { db, utama, adm };
}
const call = (db, fn, cookie, a = []) => run(rpc.handle, { request: req('/api/rpc/' + fn, { body: { a }, cookie }), env, params: { fn } }, db);
const post = (db, cookie, body) => run(users.handlePost, { request: req('/api/admin/users', { body, cookie }), env }, db);

test('Ingat saya: cookie menetap 30 hari & sesi 30 hari; tanpa itu cookie sesi & sesi 12 jam', async () => {
  const db = fakeDb([await makeUser('111', 'Benar1234')]);
  const a = await doLogin(db, '111', 'Benar1234', true);
  assert.match(a.headers.get('set-cookie'), /Max-Age=2592000/);
  assert.equal(sessionRow(db).a[2], 720);
  const b = await doLogin(db, '111', 'Benar1234', false);
  assert.doesNotMatch(b.headers.get('set-cookie'), /Max-Age/);
  assert.match(b.headers.get('set-cookie'), /HttpOnly/);
  assert.equal(sessionRow(db).a[2], 12);
  const c = await doLogin(db, '111', 'Benar1234');                      // tanpa field = tidak diingat
  assert.doesNotMatch(c.headers.get('set-cookie'), /Max-Age/);
  const d = await doLogin(db, '111', 'Benar1234', 'true');              // hanya boolean true yang dianggap "ingat"
  assert.doesNotMatch(d.headers.get('set-cookie'), /Max-Age/);
  assert.ok(db.st.audit.some((x) => x.aksi === 'login_ok' && x.detail === 'ingat saya'));
});

test('Administrator: masuk dengan username huruf kecil, hak penuh seperti Admin Utama', async () => {
  const { db, adm, utama } = await setup();
  const r = await doLogin(db, 'saybread', 'Benar1234');
  const j = await J(r);
  assert.deepEqual([j.user.label, j.user.bam_scope, j.user.can], ['Administrator', null, { edit: true, users: true, all: true, rank: false }]);
  const g = await run(users.handleGet, { request: req('/api/admin/users', { method: 'GET', cookie: adm }), env }, db);
  assert.equal(g.status, 200);
  assert.ok(utama);
});

test('Rank BAS: Admin Utama boleh; Administrator mendapat jawaban "tidak ada" (tidak membocorkan pembatasan)', async () => {
  const { db, adm, utama } = await setup();
  const a = await call(db, 'saverankovr', adm, ['t', 'BAS|x', 1]);
  const aj = await J(a);
  assert.equal(a.status, 404); assert.match(aj.message, /belum tersedia/); assert.equal(aj.code, 'NOT_FOUND');
  const asing = await call(db, 'fungsi_ngawur', adm, []);
  assert.equal((await J(asing)).message.replace('fungsi_ngawur', 'X'), aj.message.replace('saverankovr', 'X'));   // persis sama dengan fungsi yang memang tidak ada
  const u = await call(db, 'saverankovr', utama, ['t', 'XYZ', 1]);
  assert.equal(u.status, 400);                                                                                  // lolos izin; ditolak karena kunci tidak valid
  assert.notEqual((await call(db, 'saverankovr', cookieOf(await doLogin(db, 'B01', 'Benar1234')), ['t', 'BAS|x', 1])).status, 200);
});

test('Administrator tidak bisa membuat/mengubah/mereset akun Admin Utama (pembatasan tidak bisa dilewati)', async () => {
  const { db, adm, utama } = await setup();
  const forbid = async (body) => { const r = await post(db, adm, body); assert.equal(r.status, 403, JSON.stringify(body)); assert.equal((await J(r)).message, 'Tidak diizinkan.'); };
  await forbid({ action: 'create', nik: 'NEW1', nama: 'X', jabatan: 'ADMIN_PUSAT' });
  await forbid({ action: 'reset', nik: 'UTM' });
  await forbid({ action: 'update', nik: 'UTM', aktif: false });
  await forbid({ action: 'update', nik: 'B01', jabatan: 'ADMIN_PUSAT' });          // menaikkan orang lain jadi Admin Utama
  assert.equal(await verifyPassword('Benar1234', db.st.users.get('UTM')), true);   // tidak ada yang berubah
  assert.equal(db.st.users.get('B01').jabatan, 'BAM');
  // yang boleh: membuat Administrator lain & jabatan biasa; Admin Utama boleh semuanya
  assert.equal((await post(db, adm, { action: 'create', nik: 'ADM2', nama: 'Admin Dua', jabatan: 'ADMINISTRATOR' })).status, 200);
  assert.equal(db.st.users.get('ADM2').bam_scope, null);
  assert.equal((await post(db, adm, { action: 'create', nik: 'KOR1', nama: 'K', jabatan: 'KOORBAM', bam_scope: ['BAM A'] })).status, 200);
  assert.equal((await post(db, utama, { action: 'create', nik: 'UTM2', nama: 'Utama Dua', jabatan: 'ADMIN_PUSAT' })).status, 200);
  assert.equal((await post(db, utama, { action: 'update', nik: 'B01', jabatan: 'ADMINISTRATOR' })).status, 200);
});

test('Administrator tidak bisa menurunkan/menonaktifkan akun sendiri; opsi jabatan tidak memuat Admin Utama', async () => {
  const { db, adm, utama } = await setup();
  assert.equal((await post(db, adm, { action: 'update', nik: 'SAYBREAD', aktif: false })).status, 400);
  assert.equal((await post(db, adm, { action: 'update', nik: 'SAYBREAD', jabatan: 'BAM', bam_scope: ['A'] })).status, 400);
  const lst = async (c) => (await J(await run(users.handleGet, { request: req('/api/admin/users', { method: 'GET', cookie: c }), env }, db))).jabatan.map((x) => x.key);
  assert.ok(!(await lst(adm)).includes('ADMIN_PUSAT'));
  assert.ok((await lst(adm)).includes('ADMINISTRATOR'));
  assert.ok((await lst(utama)).includes('ADMIN_PUSAT'));
  const labels = (await J(await run(users.handleGet, { request: req('/api/admin/users', { method: 'GET', cookie: utama }), env }, db))).jabatan;
  assert.equal(labels.find((x) => x.key === 'ADMIN_PUSAT').label, 'Admin Utama');
});

test('Persetujuan pendaftaran & reset: Administrator tidak bisa menjadikan Admin Utama / mereset Admin Utama', async () => {
  const { db, adm, utama } = await setup();
  db.st.regs = [{ id: 1, nik: '5001', nama: 'Calon', pw_hash: 'h', pw_salt: 's', pw_iter: 1000, status: 'PENDING' }];
  const act = (c, body) => run(rq.handlePost, { request: req('/api/admin/requests', { body, cookie: c }), env }, db);
  assert.equal((await act(adm, { action: 'approve', id: 1, jabatan: 'ADMIN_PUSAT' })).status, 403);
  assert.equal(db.st.regs[0].status, 'PENDING');
  assert.equal((await act(adm, { action: 'approve', id: 1, jabatan: 'ADMINISTRATOR' })).status, 200);       // tanpa area untuk akses penuh
  assert.equal(db.st.users.get('5001').bam_scope, null);
  db.st.resets = [{ id: 1, nik: 'UTM', status: 'PENDING' }];
  assert.equal((await act(adm, { action: 'reset', id: 1 })).status, 403);
  assert.equal(db.st.resets[0].status, 'PENDING');
  assert.equal(await verifyPassword('Benar1234', db.st.users.get('UTM')), true);
  assert.equal((await act(utama, { action: 'reset', id: 1 })).status, 200);
});

test('migrasi-1e.sql: akun bawaan saybread / saybread4321 benar-benar bisa masuk dan menjadi Administrator', async () => {
  const sql = fs.readFileSync(new URL('../migrasi-1e.sql', import.meta.url), 'utf8');
  const m = /VALUES \('SAYBREAD', 'Administrator', 'ADMINISTRATOR', NULL, 1, '([0-9a-f]+)', '([0-9a-f]+)', (\d+), 0\)/.exec(sql);
  assert.ok(m, 'baris INSERT tidak ditemukan');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS data_updates/);
  assert.match(sql, /INSERT IGNORE INTO users/);
  const db = fakeDb([{ nik: 'SAYBREAD', nama: 'Administrator', jabatan: 'ADMINISTRATOR', bam_scope: null, aktif: 1, must_change: 0, failed_count: 0, locked: false, pw_hash: m[1], pw_salt: m[2], pw_iter: Number(m[3]) }]);
  const ok = await doLogin(db, 'saybread', 'saybread4321');
  assert.equal(ok.status, 200);
  const j = await J(ok);
  assert.deepEqual([j.user.jabatan, j.user.must_change, j.user.bam_scope], ['ADMINISTRATOR', false, null]);
  assert.equal((await doLogin(db, 'saybread', 'saybread4322')).status, 401);
});

test('Administrator tidak melihat akun Admin Utama (daftar pengguna & permintaan reset); Admin Utama melihat semuanya', async () => {
  const { db, adm, utama } = await setup();
  const names = async (c) => (await J(await run(users.handleGet, { request: req('/api/admin/users', { method: 'GET', cookie: c }), env }, db))).users.map((u) => u.nik).sort();
  assert.deepEqual(await names(adm), ['B01', 'SAYBREAD']);                      // tanpa UTM (Admin Utama)
  assert.deepEqual(await names(utama), ['B01', 'SAYBREAD', 'UTM']);
  db.st.resets = [{ id: 1, nik: 'UTM', status: 'PENDING' }, { id: 2, nik: 'B01', status: 'PENDING' }];
  const list = async (c) => (await J(await run(rq.handleGet, { request: req('/api/admin/requests', { method: 'GET', cookie: c }), env }, db))).resets.map((r) => r.nik);
  assert.deepEqual(await list(adm), ['B01']);
  assert.deepEqual(await list(utama), ['UTM', 'B01']);
});
