import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, makeUser, req, cookieOf } from './fakedb.mjs';
import { verifyPassword } from '../functions/_lib/security.js';
import { errorResponse } from '../functions/_lib/http.js';
import * as login from '../functions/api/auth/login.js';
import * as me from '../functions/api/auth/me.js';
import * as reg from '../functions/api/auth/register.js';
import * as rst from '../functions/api/auth/reset-request.js';
import * as rq from '../functions/api/admin/requests.js';

const env = { PBKDF2_ITER: '10000' };
const run = async (fn, ...a) => { try { return await fn(...a); } catch (e) { return errorResponse(e); } };
const J = (r) => r.json();
const doLogin = (db, nik, password) => run(login.handle, { request: req('/api/auth/login', { body: { nik, password } }), env }, db);
const daftar = (db, over = {}, origin) => run(reg.handle, { request: req('/api/auth/register', { body: { nik: '5001', nama: 'Sari Dewi', jabatan: 'BAS', area: 'BAM Surabaya', kontak: '0812', password: 'Rahasia2026', ...over }, origin }), env }, db);
const reset = (db, body, origin) => run(rst.handle, { request: req('/api/auth/reset-request', { body, origin }), env }, db);

async function withAdmin(extra = {}) {
  const db = fakeDb([
    await makeUser('P01', 'Benar1234', { jabatan: 'ADMIN_PUSAT', bam_scope: null }),
    await makeUser('AK1', 'Benar1234', { jabatan: 'ADMIN_KOORBAM', bam_scope: '["BAM A"]' }),
    await makeUser('B01', 'Benar1234', { jabatan: 'BAM' }),
  ], extra);
  const r = await doLogin(db, 'P01', 'Benar1234');
  const cookie = cookieOf(r);
  const get = (c = cookie) => run(rq.handleGet, { request: req('/api/admin/requests', { method: 'GET', cookie: c }), env }, db);
  const post = (body, c = cookie) => run(rq.handlePost, { request: req('/api/admin/requests', { body, cookie: c }), env }, db);
  return { db, cookie, get, post };
}

test('daftar: validasi isian', async () => {
  const db = fakeDb();
  const cek = async (over, status, re) => { const r = await daftar(db, over); assert.equal(r.status, status, JSON.stringify(over)); if (re) assert.match((await J(r)).message, re); };
  await cek({ nik: '!!' }, 400, /NIK tidak valid/);
  await cek({ nama: 'A' }, 400, /nama lengkap/);
  await cek({ jabatan: 'ADMIN_PUSAT' }, 400, /Pilih jabatan/);       // jabatan admin tidak bisa dipilih sendiri
  await cek({ jabatan: 'ADMIN_KOORBAM' }, 400, /Pilih jabatan/);
  await cek({ jabatan: undefined }, 400, /Pilih jabatan/);
  await cek({ area: '  ' }, 400, /area BAM/);
  await cek({ password: 'pendek1' }, 400, /minimal 8/);
  await cek({ password: 'hanyahuruf' }, 400, /huruf dan angka/);
  await cek({ password: 'Sandi5001abc' }, 400, /memuat NIK/);
  assert.equal((db.st.regs || []).length, 0);
});

test('daftar: sukses -> antrean PENDING, password tersimpan sebagai hash, kontak opsional', async () => {
  const db = fakeDb();
  const r = await daftar(db, { nama: '  Sari   Dewi ', area: 'BAM\nSurabaya' });
  assert.equal(r.status, 200);
  const g = db.st.regs[0];
  assert.deepEqual([g.nik, g.nama, g.jabatan_diminta, g.area_diminta, g.status], ['5001', 'Sari Dewi', 'BAS', 'BAM Surabaya', 'PENDING']);
  assert.notEqual(g.pw_hash, 'Rahasia2026');
  assert.equal(await verifyPassword('Rahasia2026', g), true);
  assert.equal(db.st.users.size, 0);                                   // BELUM menjadi pengguna
  assert.ok(db.st.audit.some((x) => x.aksi === 'daftar' && x.nik === '5001'));
  const tanpa = await daftar(db, { nik: '5002', kontak: undefined });
  assert.equal(tanpa.status, 200); assert.equal(db.st.regs[1].kontak, null);
});

test('daftar: NIK sudah terdaftar / sedang menunggu / antrean penuh / lintas-situs', async () => {
  const db = fakeDb([await makeUser('111', 'Benar1234')]);
  const a = await daftar(db, { nik: '111' }); assert.equal(a.status, 409); assert.equal((await J(a)).code, 'EXISTS');
  assert.equal((await daftar(db)).status, 200);
  const b = await daftar(db); assert.equal(b.status, 409); assert.equal((await J(b)).code, 'PENDING');
  const penuh = fakeDb(); penuh.st.regs = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, nik: 'X' + i, status: 'PENDING' }));
  assert.equal((await daftar(penuh)).status, 429);
  assert.equal((await daftar(fakeDb(), {}, 'https://jahat.test')).status, 403);
});

test('login pendaftar: menunggu / ditolak hanya terlihat bila password cocok; selain itu pesan umum', async () => {
  const db = fakeDb();
  await daftar(db);
  const menunggu = await doLogin(db, '5001', 'Rahasia2026');
  assert.equal(menunggu.status, 403); assert.equal((await J(menunggu)).code, 'PENDING');
  const salah = await doLogin(db, '5001', 'Salah12345');                 // orang lain yang menebak NIK: tidak boleh tahu statusnya
  const salahJ = await J(salah);
  assert.equal(salah.status, 401); assert.equal(salahJ.code, 'BAD_LOGIN');
  const asing = await doLogin(db, '9999', 'Rahasia2026');
  assert.equal(asing.status, 401); assert.equal((await J(asing)).message, salahJ.message);
  db.st.regs[0].status = 'REJECTED'; db.st.regs[0].catatan = 'NIK tidak ditemukan di data HR';
  const ditolak = await doLogin(db, '5001', 'Rahasia2026');
  const dj = await J(ditolak);
  assert.equal(ditolak.status, 403); assert.equal(dj.code, 'REJECTED');
  assert.match(dj.message, /ditolak: NIK tidak ditemukan di data HR/);
});

test('login: tabel pendaftaran belum dimigrasi tidak merusak login (NIK tak dikenal tetap 401)', async () => {
  const db = fakeDb();
  const asli = db.query.bind(db);
  db.query = async (sql, a) => { if (/FROM registrations/.test(sql)) throw new Error("Table 'registrations' doesn't exist"); return asli(sql, a); };
  const r = await doLogin(db, '9999', 'Apapun12345');
  assert.equal(r.status, 401);
});

test('lupa password: jawaban selalu sama; hanya NIK aktif yang masuk antrean, tanpa duplikat', async () => {
  const db = fakeDb([await makeUser('111', 'Benar1234'), await makeUser('222', 'Benar1234', { aktif: 0 })]);
  const a = await reset(db, { nik: '111', kontak: ' 0812 3456 ' });
  const b = await reset(db, { nik: '9999' });
  const c = await reset(db, { nik: '222' });
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
  const [ma, mb, mc] = [(await J(a)).message, (await J(b)).message, (await J(c)).message];
  assert.equal(ma, mb); assert.equal(ma, mc);
  assert.equal(db.st.resets.length, 1);
  assert.deepEqual([db.st.resets[0].nik, db.st.resets[0].kontak], ['111', '0812 3456']);
  await reset(db, { nik: '111' });
  assert.equal(db.st.resets.length, 1);                                    // tidak menumpuk
  assert.equal((await reset(db, { nik: '!!' })).status, 400);
  assert.equal((await reset(db, { nik: '111' }, 'https://jahat.test')).status, 403);
  assert.equal(await verifyPassword('Benar1234', db.st.users.get('111')), true);   // password TIDAK berubah oleh permintaan
});

test('admin requests: hanya Admin Pusat', async () => {
  const { db, get, post } = await withAdmin();
  const cAK = cookieOf(await doLogin(db, 'AK1', 'Benar1234'));
  assert.equal((await get(cAK)).status, 403);
  assert.equal((await post({ action: 'reject', id: 1 }, cAK)).status, 403);
  assert.equal((await get('')).status, 401);
});

test('setujui pendaftaran: jabatan & area ditentukan admin, password pilihan pendaftar, langsung bisa masuk', async () => {
  const { db, get, post } = await withAdmin();
  await daftar(db, { jabatan: 'BAM', area: 'Surabaya' });                   // mengaku BAM
  const g = await J(await get());
  assert.equal(g.registrations.length, 1);
  assert.deepEqual([g.registrations[0].nik, g.registrations[0].label_diminta, g.registrations[0].area_diminta], ['5001', 'BAM', 'BAM Surabaya'.replace('BAM ', '')]);
  assert.equal(g.registrations[0].pw_hash, undefined);

  await rejectsStatus(post({ action: 'approve', id: 1, jabatan: 'RAJA', bam_scope: ['BAM A'] }), 400, /jabatan/i);
  await rejectsStatus(post({ action: 'approve', id: 1, jabatan: 'BAS', bam_scope: [] }), 400, /minimal satu BAM/);
  await rejectsStatus(post({ action: 'approve', id: 99, jabatan: 'BAS', bam_scope: ['A'] }), 404, /tidak ditemukan/);
  await rejectsStatus(post({ action: 'approve', id: 'x', jabatan: 'BAS', bam_scope: ['A'] }), 400, /ID/);

  const ok = await post({ action: 'approve', id: 1, jabatan: 'BAS', bam_scope: ['bam a', 'BAM X'] });   // admin menurunkan BAM -> BAS
  assert.equal(ok.status, 200);
  assert.deepEqual((await J(ok)).unknownBam, ['BAM X']);
  const u = db.st.users.get('5001');
  assert.deepEqual([u.jabatan, u.must_change, u.aktif], ['BAS', 0, 1]);
  assert.deepEqual(JSON.parse(u.bam_scope), ['BAM A', 'BAM X']);
  assert.equal(db.st.regs[0].status, 'APPROVED');
  const lg = await doLogin(db, '5001', 'Rahasia2026');                     // password yang dipilih sendiri
  assert.equal(lg.status, 200);
  const body = await J(lg);
  assert.equal(body.user.must_change, false); assert.equal(body.user.jabatan, 'BAS');
  await rejectsStatus(post({ action: 'approve', id: 1, jabatan: 'BAS', bam_scope: ['A'] }), 409, /sudah diproses/);
  assert.ok(db.st.audit.some((x) => x.aksi === 'setuju_daftar' && x.target === '5001'));
});

test('setujui sebagai Admin Pusat tidak butuh area; NIK yang sudah jadi pengguna ditolak', async () => {
  const { db, post } = await withAdmin();
  await daftar(db);
  assert.equal((await post({ action: 'approve', id: 1, jabatan: 'ADMIN_PUSAT' })).status, 200);
  assert.equal(db.st.users.get('5001').bam_scope, null);
  const { db: d2, post: p2 } = await withAdmin();
  await daftar(d2, { nik: '6001' });
  d2.st.users.set('6001', await makeUser('6001', 'DibuatAdmin1'));         // admin sempat membuat akun NIK yang sama secara manual
  await rejectsStatus(p2({ action: 'approve', id: 1, jabatan: 'BAM', bam_scope: ['BAM A'] }), 409, /sudah ada/);
  assert.equal(d2.st.regs[0].status, 'PENDING');
});

test('tolak pendaftaran: catatan tersimpan dan tampil saat pendaftar mencoba masuk', async () => {
  const { db, post } = await withAdmin();
  await daftar(db);
  assert.equal((await post({ action: 'reject', id: 1, catatan: '  NIK  tidak dikenal ' })).status, 200);
  assert.equal(db.st.regs[0].status, 'REJECTED'); assert.equal(db.st.regs[0].catatan, 'NIK tidak dikenal');
  assert.equal(db.st.users.has('5001'), false);
  const r = await doLogin(db, '5001', 'Rahasia2026');
  assert.match((await J(r)).message, /ditolak: NIK tidak dikenal/);
  await rejectsStatus(post({ action: 'reject', id: 1 }), 409, /sudah diproses/);
  await daftar(db);                                                         // boleh mendaftar ulang setelah ditolak
  assert.equal(db.st.regs.length, 2);
});

test('proses reset: password sementara tampil sekali, wajib ganti, sesi lama mati, kunci dibuka', async () => {
  const { db, get, post } = await withAdmin();
  const lama = await makeUser('777', 'Lama12345', { locked: true, failed_count: 3 });
  db.st.users.set('777', lama);
  const cLama = cookieOf(await doLogin(db, 'B01', 'Benar1234'));
  await reset(db, { nik: '777', kontak: '0811' });
  const g = await J(await get());
  assert.deepEqual([g.resets.length, g.resets[0].nik, g.resets[0].nama, g.resets[0].kontak], [1, '777', 'User 777', '0811']);
  const r = await post({ action: 'reset', id: 1 });
  assert.equal(r.status, 200);
  const { tempPassword } = await J(r);
  const u = db.st.users.get('777');
  assert.equal(await verifyPassword(tempPassword, u), true);
  assert.deepEqual([u.must_change, u.locked, u.failed_count], [1, false, 0]);
  assert.equal(db.st.resets[0].status, 'DONE');
  assert.equal((await doLogin(db, '777', 'Lama12345')).status, 401);
  assert.equal((await J(await doLogin(db, '777', tempPassword))).user.must_change, true);
  await rejectsStatus(post({ action: 'reset', id: 1 }), 409, /sudah diproses/);
  assert.ok(cLama);
});

test('abaikan permintaan reset; pengguna yang sudah nonaktif menutup permintaan', async () => {
  const { db, post } = await withAdmin();
  await reset(db, { nik: 'B01' });
  assert.equal((await post({ action: 'dismiss', id: 1 })).status, 200);
  assert.equal(db.st.resets[0].status, 'REJECTED');
  db.st.resets.push({ id: 2, nik: 'B01', status: 'PENDING' });
  db.st.users.get('B01').aktif = 0;
  await rejectsStatus(post({ action: 'reset', id: 2 }), 404, /nonaktif/);
  assert.equal(db.st.resets[1].status, 'REJECTED');
  await rejectsStatus(post({ action: 'dance', id: 2 }), 400, /Aksi tidak dikenal/);
});

test('me: Admin Pusat mendapat jumlah permintaan; jabatan lain tidak; gagal hitung tidak mengganggu', async () => {
  const { db, cookie } = await withAdmin();
  await daftar(db); await daftar(db, { nik: '5002' }); await reset(db, { nik: 'B01' });
  const m = (c) => run(me.handle, { request: req('/api/auth/me', { method: 'GET', cookie: c }), env }, db);
  const p = await J(await m(cookie));
  assert.deepEqual(p.pending, { reg: 2, rst: 1 });
  const b = await J(await m(cookieOf(await doLogin(db, 'B01', 'Benar1234'))));
  assert.equal('pending' in b, false);
  db.st.failCounts = true;
  const gagal = await m(cookie);
  assert.equal(gagal.status, 200);
  assert.deepEqual((await J(gagal)).pending, { reg: 0, rst: 0, error: true });
});

async function rejectsStatus(promise, status, re) {
  const r = await promise;
  assert.equal(r.status, status);
  if (re) assert.match((await r.json()).message, re);
}
