import test from 'node:test';
import assert from 'node:assert/strict';
import { bamWhere, kodeWhere } from '../functions/_lib/scope.js';
import { can, parseScope, normScope, normNik, publicUser, JABATAN } from '../functions/_lib/auth.js';

const pusat = { jabatan: 'ADMIN_PUSAT', bam_scope: [] };
const koor = { jabatan: 'KOORBAM', bam_scope: ['BAM A', 'BAM B'] };
const kosong = { jabatan: 'BAM', bam_scope: [] };

test('Admin Pusat: tanpa pembatasan', () => {
  assert.deepEqual(bamWhere(pusat), { sql: '1=1', params: [] });
  assert.deepEqual(kodeWhere(pusat), { sql: '1=1', params: [] });
});

test('Jabatan berarea: dibatasi ke BAM miliknya, nilai lewat parameter (bukan disisipkan ke SQL)', () => {
  const w = bamWhere(koor, 'bam');
  assert.equal(w.sql, 'UPPER(TRIM(bam)) IN (?,?)');
  assert.deepEqual(w.params, ['BAM A', 'BAM B']);
  const k = kodeWhere(koor, 't.kode');
  assert.match(k.sql, /IN \(SELECT UPPER\(TRIM\(x\.kode\)\) FROM toko x WHERE UPPER\(TRIM\(x\.bam\)\) IN \(\?,\?\)\)/);
  assert.deepEqual(k.params, ['BAM A', 'BAM B']);
});

test('Area kosong: tidak ada data (gagal tertutup)', () => {
  assert.equal(bamWhere(kosong).sql, '1=0');
  assert.equal(kodeWhere(kosong).sql, '1=0');
});

test('Nama kolom berbahaya ditolak', () => {
  assert.throws(() => bamWhere(koor, 'bam); DROP TABLE toko;--'));
  assert.throws(() => kodeWhere(koor, 'kode OR 1=1'));
});

test('Nama BAM berisi kutip tetap aman karena parameter', () => {
  const w = bamWhere({ jabatan: 'BAM', bam_scope: ["X' OR '1'='1"] });
  assert.equal(w.sql, 'UPPER(TRIM(bam)) IN (?)');
  assert.deepEqual(w.params, ["X' OR '1'='1"]);
});

test('matriks hak akses per jabatan', () => {
  const m = (j) => ({ view: can({ jabatan: j }, 'view'), edit: can({ jabatan: j }, 'edit'), pusat: can({ jabatan: j }, 'pusat') });
  assert.deepEqual(m('ADMIN_PUSAT'), { view: true, edit: true, pusat: true });
  assert.deepEqual(m('ADMIN_KOORBAM'), { view: true, edit: true, pusat: false });
  for (const j of ['KOORBAM', 'BAM', 'BAS', 'BASTR']) assert.deepEqual(m(j), { view: true, edit: false, pusat: false });
  assert.deepEqual(m('TAMU'), { view: false, edit: false, pusat: false });   // jabatan tak dikenal ditolak
  assert.equal(JABATAN.length, 6);
});

test('parseScope / normScope / normNik / publicUser', () => {
  assert.deepEqual(parseScope('["bam a"," Bam A ","b"]'), ['BAM A', 'B']);
  assert.deepEqual(parseScope(['x', 'X']), ['X']);
  assert.deepEqual(parseScope(null), []);
  assert.deepEqual(parseScope('rusak{'), []);
  assert.deepEqual(normScope(['a', '', ' a ', 'b']), ['A', 'B']);
  assert.equal(normNik(' ab-12 '), 'AB-12');
  assert.equal(normNik('a b'), '');
  assert.equal(normNik('ab'), '');
  const p = publicUser({ nik: '1', nama: 'n', jabatan: 'ADMIN_PUSAT', bam_scope: '["X"]', must_change: 0 });
  assert.equal(p.bam_scope, null); assert.equal(p.can.all, true);
  const k = publicUser({ nik: '2', nama: 'n', jabatan: 'ADMIN_KOORBAM', bam_scope: '["X"]', must_change: 1 });
  assert.deepEqual(k.bam_scope, ['X']); assert.equal(k.can.edit, true); assert.equal(k.can.users, false); assert.equal(k.must_change, true);
});
