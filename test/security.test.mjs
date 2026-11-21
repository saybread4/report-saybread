import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, checkPasswordPolicy, tempPassword, timingSafeEqual, iterFrom, sha256Hex } from '../functions/_lib/security.js';

test('hash lalu verifikasi: benar lolos, salah gagal, salt berbeda tiap kali', async () => {
  const h = await hashPassword('Rahasia123', undefined, 10000);
  assert.equal(await verifyPassword('Rahasia123', h), true);
  assert.equal(await verifyPassword('rahasia123', h), false);
  const h2 = await hashPassword('Rahasia123', undefined, 10000);
  assert.notEqual(h.pw_salt, h2.pw_salt);
  assert.notEqual(h.pw_hash, h2.pw_hash);
});

test('hash stabil untuk salt & iterasi yang sama (iterasi tersimpan per pengguna)', async () => {
  const a = await hashPassword('abc12345', 'aa'.repeat(16), 12345);
  const b = await hashPassword('abc12345', 'aa'.repeat(16), 12345);
  assert.equal(a.pw_hash, b.pw_hash);
  assert.equal(a.pw_iter, 12345);
});

test('aturan password', () => {
  assert.match(checkPasswordPolicy('abc123', 'X1'), /minimal 8/);
  assert.match(checkPasswordPolicy('abcdefgh', 'X1'), /huruf dan angka/);
  assert.match(checkPasswordPolicy('12345678', 'X1'), /huruf dan angka/);
  assert.match(checkPasswordPolicy('Budi12345678x', '12345678'), /NIK/);
  assert.equal(checkPasswordPolicy('Aman2026ok', '12345678'), null);
  assert.match(checkPasswordPolicy('a1'.repeat(70), 'X1'), /maksimal/);
});

test('password sementara selalu lolos aturan, panjang 10, tanpa karakter mirip', () => {
  for (let i = 0; i < 300; i++) {
    const p = tempPassword();
    assert.equal(p.length, 10);
    assert.equal(checkPasswordPolicy(p, '12345678'), null);
    assert.doesNotMatch(p, /[0OIl1]/);
  }
  assert.notEqual(tempPassword(), tempPassword());
});

test('timingSafeEqual & iterFrom & sha256', async () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(iterFrom({}), 100000);
  assert.equal(iterFrom({ PBKDF2_ITER: '50000' }), 50000);
  assert.equal(iterFrom({ PBKDF2_ITER: '999999' }), 100000);   // melebihi batas Workers -> default
  assert.equal(iterFrom({ PBKDF2_ITER: '5' }), 100000);
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
