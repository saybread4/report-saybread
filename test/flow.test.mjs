import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, makeUser, req, cookieOf } from './fakedb.mjs';
import { verifyPassword } from '../functions/_lib/security.js';
import * as login from '../functions/api/auth/login.js';
import * as logout from '../functions/api/auth/logout.js';
import * as me from '../functions/api/auth/me.js';
import * as chpw from '../functions/api/auth/change-password.js';
import * as users from '../functions/api/admin/users.js';
import * as rpc from '../functions/api/rpc/[fn].js';
import { errorResponse } from '../functions/_lib/http.js';

const env = { PBKDF2_ITER: '10000' };
// Jalankan handler seperti Cloudflare: error diubah menjadi respons
const run = async (fn, ...a) => { try { return await fn(...a); } catch (e) { return errorResponse(e); } };
const doLogin = (db, nik, password) => run(login.handle, { request: req('/api/auth/login', { body: { nik, password } }), env }, db);
const J = (r) => r.json();
const tokoKosong = (s) => (s.startsWith('SELECT bam, cabang FROM toko') ? [] : null);

async function masuk(db, nik, password) {
  const r = await doLogin(db, nik, password);
  assert.equal(r.status, 200);
  return cookieOf(r);
}

test('login: NIK tidak terdaftar dan password salah memberi pesan yang sama', async () => {
  const db = fakeDb([await makeUser('111', 'Benar1234')]);
  const a = await doLogin(db, '999', 'Benar1234');
  const b = await doLogin(db, '111', 'Salah1234');
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal((await J(a)).message, (await J(b)).message);
});

test('login: terkunci setelah 5x salah, benar pun ditolak (429), lalu kunci terbuka bila dibuka admin', async () => {
  const db = fakeDb([await makeUser('111', 'Benar1234')]);
  for (let i = 0; i < 5; i++) assert.equal((await doLogin(db, '111', 'Salah1234')).status, 401);
  assert.equal(db.st.users.get('111').locked, true);
  const r = await doLogin(db, '111', 'Benar1234');
  assert.equal(r.status, 429);
  assert.equal((await J(r)).code, 'LOCKED');
  assert.ok(db.st.audit.some((x) => x.aksi === 'akun_terkunci'));
});

test('login: sukses memberi cookie HttpOnly+Secure+SameSite=Strict dan menyetel ulang hitungan salah', async () => {
  const db = fakeDb([await makeUser('111', 'Benar1234', { failed_count: 3 })]);
  const r = await doLogin(db, '111', 'Benar1234');
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/); assert.match(sc, /SameSite=Strict/);
  assert.equal(db.st.users.get('111').failed_count, 0);
  const body = await J(r);
  assert.equal(body.user.jabatan, 'BAM');
  assert.equal(body.user.pw_hash, undefined);      // hash tidak pernah dikirim ke browser
  assert.equal(db.st.sessions.size, 1);
  const [stored] = [...db.st.sessions.keys()];
  assert.notEqual(stored, cookieOf(r).slice(4));   // yang tersimpan hash token, bukan token asli
});

test('login: akun nonaktif ditolak dengan pesan yang sama', async () => {
  const db = fakeDb([await makeUser('111', 'Benar1234', { aktif: 0 })]);
  const r = await doLogin(db, '111', 'Benar1234');
  assert.equal(r.status, 401); assert.equal((await J(r)).code, 'BAD_LOGIN');
  assert.equal(db.st.sessions.size, 0);
});

test('login: NIK dinormalkan (huruf kecil dan spasi tidak masalah)', async () => {
  const db = fakeDb([await makeUser('AB-12', 'Benar1234')]);
  assert.equal((await doLogin(db, ' ab-12 ', 'Benar1234')).status, 200);
});

test('login: asal lintas-situs ditolak', async () => {
  const db = fakeDb([await makeUser('111', 'Benar1234')]);
  const r = await run(login.handle, { request: req('/api/auth/login', { body: { nik: '111', password: 'Benar1234' }, origin: 'https://jahat.test' }), env }, db);
  assert.equal(r.status, 403);
});

test('wajib ganti password: data ditolak sampai password diganti, lalu sesi lain keluar', async () => {
  const db = fakeDb([await makeUser('111', 'Sementara12', { must_change: 1 })], { rows: tokoKosong });
  const c1 = await masuk(db, '111', 'Sementara12');
  const c2 = await masuk(db, '111', 'Sementara12');          // sesi kedua (perangkat lain)
  assert.equal(db.st.sessions.size, 2);

  const call = (cookie) => run(rpc.handle, { request: req('/api/rpc/getbam', { body: { a: [] }, cookie }), env, params: { fn: 'getbam' } }, db);
  const ditolak = await call(c1);
  assert.equal(ditolak.status, 403); assert.equal((await J(ditolak)).code, 'MUST_CHANGE');

  const m = await run(me.handle, { request: req('/api/auth/me', { method: 'GET', cookie: c1 }), env }, db);   // me tetap boleh
  assert.equal(m.status, 200); assert.equal((await J(m)).user.must_change, true);

  const cp = (cookie, body) => run(chpw.handle, { request: req('/api/auth/change-password', { body, cookie }), env }, db);
  assert.equal((await cp(c1, { old: 'Salah1234', new: 'BaruAman99' })).status, 400);                 // lama salah
  assert.equal((await cp(c1, { old: 'Sementara12', new: 'pendek1' })).status, 400);                    // lemah
  assert.equal((await cp(c1, { old: 'Sementara12', new: 'Sementara12' })).status, 400);                // sama
  assert.equal((await cp(c1, { old: 'Sementara12', new: 'BaruAman99' })).status, 200);

  assert.equal(db.st.users.get('111').must_change, 0);
  assert.equal(db.st.sessions.size, 1);                                     // sesi perangkat lain dicabut
  assert.equal((await call(c2)).status, 401);
  assert.equal((await call(c1)).status, 200);                               // sesi ini lanjut, kini boleh
  assert.equal((await doLogin(db, '111', 'Sementara12')).status, 401);      // password lama mati
  assert.equal((await doLogin(db, '111', 'BaruAman99')).status, 200);
});

test('logout menghapus sesi dan cookie', async () => {
  const db = fakeDb([await makeUser('111', 'Benar1234')]);
  const c = await masuk(db, '111', 'Benar1234');
  const r = await run(logout.handle, { request: req('/api/auth/logout', { cookie: c }), env }, db);
  assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(db.st.sessions.size, 0);
  const m = await run(me.handle, { request: req('/api/auth/me', { method: 'GET', cookie: c }), env }, db);
  assert.equal(m.status, 401);
});

test('rpc: tanpa login 401, cookie palsu 401, fungsi tak dikenal 404', async () => {
  const db = fakeDb([await makeUser('111', 'Benar1234')], { rows: tokoKosong });
  const call = (fn, cookie) => run(rpc.handle, { request: req('/api/rpc/' + fn, { body: { a: [] }, cookie }), env, params: { fn } }, db);
  assert.equal((await call('getbam')).status, 401);
  assert.equal((await call('getbam', 'sid=' + 'a'.repeat(64))).status, 401);
  const c = await masuk(db, '111', 'Benar1234');
  assert.equal((await call('belumada', c)).status, 404);
  assert.equal((await call('constructor', c)).status, 404);                  // bukan fungsi bawaan Object
  assert.equal((await call('api_getbam', c)).status, 200);                    // awalan api_ ikut diterima
});

test('rpc: data dibatasi area di server — Pusat melihat semua, BAM/Koorbam hanya areanya', async () => {
  const toko = [
    { bam: 'BAM A', cabang: 'C1' }, { bam: 'BAM A', cabang: 'C1' }, { bam: 'BAM A', cabang: 'C2' },
    { bam: 'BAM B', cabang: 'C3' }, { bam: 'BAM C', cabang: 'C4' },
  ];
  // Meniru perilaku SQL asli: 1=1 -> semua baris, 1=0 -> tidak ada, IN (?) -> sesuai parameter
  const rows = (s, a) => {
    if (!s.startsWith('SELECT bam, cabang FROM toko WHERE')) return null;
    if (s.includes('1=0')) return [];
    if (s.includes('1=1')) return toko;
    return toko.filter((t) => a.includes(t.bam.toUpperCase()));
  };
  const db = fakeDb([
    await makeUser('P01', 'Benar1234', { jabatan: 'ADMIN_PUSAT', bam_scope: null }),
    await makeUser('B01', 'Benar1234', { jabatan: 'BAM', bam_scope: '["BAM A"]' }),
    await makeUser('K01', 'Benar1234', { jabatan: 'KOORBAM', bam_scope: '["BAM A","BAM B"]' }),
    await makeUser('S01', 'Benar1234', { jabatan: 'BAS', bam_scope: '[]' }),
  ], { rows });
  const getbam = async (nik) => {
    const c = await masuk(db, nik, 'Benar1234');
    const r = await run(rpc.handle, { request: req('/api/rpc/getbam', { body: { a: [] }, cookie: c }), env, params: { fn: 'getbam' } }, db);
    assert.equal(r.status, 200);
    return J(r);
  };
  assert.deepEqual((await getbam('P01')).bam, ['BAM A', 'BAM B', 'BAM C']);
  assert.deepEqual((await getbam('B01')).bam, ['BAM A']);
  assert.deepEqual((await getbam('K01')).bam, ['BAM A', 'BAM B']);
  assert.deepEqual((await getbam('S01')).bam, []);                            // area kosong => tidak ada data
});

async function setupAdmin() {
  const db = fakeDb([
    await makeUser('P01', 'Benar1234', { jabatan: 'ADMIN_PUSAT', bam_scope: null }),
    await makeUser('AK1', 'Benar1234', { jabatan: 'ADMIN_KOORBAM', bam_scope: '["BAM A"]' }),
  ]);
  const cP = await masuk(db, 'P01', 'Benar1234');
  const post = (body, cookie = cP) => run(users.handlePost, { request: req('/api/admin/users', { body, cookie }), env }, db);
  return { db, cP, post };
}

test('kelola pengguna: hanya Admin Pusat (Admin Koorbam dan tanpa login ditolak)', async () => {
  const { db, post } = await setupAdmin();
  const cAK = await masuk(db, 'AK1', 'Benar1234');
  assert.equal((await post({ action: 'reset', nik: 'P01' }, cAK)).status, 403);
  const g = await run(users.handleGet, { request: req('/api/admin/users', { method: 'GET', cookie: cAK }), env }, db);
  assert.equal(g.status, 403);
  const g2 = await run(users.handleGet, { request: req('/api/admin/users', { method: 'GET' }), env }, db);
  assert.equal(g2.status, 401);
});

test('kelola pengguna: buat pengguna -> password sementara tampil sekali, wajib ganti, dan bisa dipakai login', async () => {
  const { db, post } = await setupAdmin();
  const r = await post({ action: 'create', nik: '2001', nama: 'Budi', jabatan: 'KOORBAM', bam_scope: ['bam a', 'bam b'] });
  assert.equal(r.status, 200);
  const b = await J(r);
  assert.equal(typeof b.tempPassword, 'string');
  assert.deepEqual(b.unknownBam, []);
  const u = db.st.users.get('2001');
  assert.equal(u.must_change, 1);
  assert.deepEqual(JSON.parse(u.bam_scope), ['BAM A', 'BAM B']);
  assert.notEqual(u.pw_hash, b.tempPassword);
  assert.equal(await verifyPassword(b.tempPassword, u), true);
  const lg = await doLogin(db, '2001', b.tempPassword);
  assert.equal(lg.status, 200); assert.equal((await J(lg)).user.must_change, true);
});

test('kelola pengguna: validasi (duplikat, jabatan, area wajib, password lemah, BAM salah ketik)', async () => {
  const { post } = await setupAdmin();
  assert.equal((await post({ action: 'create', nik: 'P01', nama: 'X', jabatan: 'BAM', bam_scope: ['BAM A'] })).status, 409);
  assert.equal((await post({ action: 'create', nik: '3001', nama: 'X', jabatan: 'RAJA', bam_scope: ['BAM A'] })).status, 400);
  const noScope = await post({ action: 'create', nik: '3001', nama: 'X', jabatan: 'BAM', bam_scope: [] });
  assert.equal(noScope.status, 400); assert.equal((await J(noScope)).code, 'NO_SCOPE');
  assert.equal((await post({ action: 'create', nik: '3001', nama: 'X', jabatan: 'BAM', bam_scope: ['BAM A'], password: 'lemah' })).status, 400);
  const typo = await post({ action: 'create', nik: '3002', nama: 'X', jabatan: 'BAS', bam_scope: ['BAM Z'] });
  assert.equal(typo.status, 200); assert.deepEqual((await J(typo)).unknownBam, ['BAM Z']);   // peringatan, bukan error
  assert.equal((await post({ action: 'create', nik: '!!', nama: 'X', jabatan: 'BAM', bam_scope: ['BAM A'] })).status, 400);
});

test('kelola pengguna: reset password -> sementara, wajib ganti, sesi lama mati, kunci dibuka', async () => {
  const { db, post } = await setupAdmin();
  db.st.users.set('777', await makeUser('777', 'Lama12345', { locked: true, failed_count: 4 }));
  const cOld = await masuk(db, 'AK1', 'Benar1234');                // sesi AK
  const r = await post({ action: 'reset', nik: 'AK1' });
  const { tempPassword } = await J(r);
  const ak = db.st.users.get('AK1');
  assert.equal(ak.must_change, 1);
  assert.equal(await verifyPassword(tempPassword, ak), true);
  assert.equal([...db.st.sessions.values()].filter((s) => s.nik === 'AK1').length, 0);
  assert.equal((await doLogin(db, 'AK1', 'Benar1234')).status, 401);
  assert.equal((await doLogin(db, 'AK1', tempPassword)).status, 200);
  const r2 = await post({ action: 'reset', nik: '777' });
  assert.equal(r2.status, 200);
  assert.equal(db.st.users.get('777').locked, false);
  assert.equal(db.st.users.get('777').failed_count, 0);
  assert.equal((await post({ action: 'reset', nik: '404404' })).status, 404);
  assert.ok(db.st.audit.some((x) => x.aksi === 'reset_pw' && x.target === 'AK1'));
  assert.ok(cOld);
});

test('kelola pengguna: ubah area/jabatan memutus sesi; tidak bisa menonaktifkan/menurunkan diri sendiri', async () => {
  const { db, post } = await setupAdmin();
  const cAK = await masuk(db, 'AK1', 'Benar1234');
  assert.equal((await post({ action: 'update', nik: 'AK1', bam_scope: ['BAM A', 'BAM B'] })).status, 200);
  assert.deepEqual(JSON.parse(db.st.users.get('AK1').bam_scope), ['BAM A', 'BAM B']);
  assert.equal(db.st.sessions.has(cAK.slice(4)), false);
  assert.equal([...db.st.sessions.values()].some((s) => s.nik === 'AK1'), false);
  assert.equal((await post({ action: 'update', nik: 'P01', aktif: false })).status, 400);
  assert.equal((await post({ action: 'update', nik: 'P01', jabatan: 'BAM', bam_scope: ['BAM A'] })).status, 400);
  assert.equal((await post({ action: 'update', nik: 'AK1', aktif: false })).status, 200);
  assert.equal((await doLogin(db, 'AK1', 'Benar1234')).status, 401);        // nonaktif tidak bisa masuk
  assert.equal((await post({ action: 'update', nik: 'AK1', jabatan: 'BAM', bam_scope: [] })).status, 400);   // area wajib
  assert.equal((await post({ action: 'hapus', nik: 'AK1' })).status, 400);
});
