// Membuat pernyataan SQL untuk akun Admin Pusat pertama.
//   node scripts/seed-admin.mjs --nik 12345678 --nama "Nama Anda"
// Password sementara dicetak SATU KALI di layar; akun wajib menggantinya saat login pertama.
// Tempel SQL hasilnya ke TiDB Cloud > SQL Editor.
import { hashPassword, tempPassword } from '../functions/_lib/security.js';
import { normNik } from '../functions/_lib/auth.js';

const arg = (name) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : '';
};
const nik = normNik(arg('nik'));
const nama = String(arg('nama') || '').trim();
if (!nik || !nama) {
  console.error('Pemakaian: node scripts/seed-admin.mjs --nik <NIK> --nama "<Nama>"');
  process.exit(1);
}
const pw = tempPassword();
const h = await hashPassword(pw);
const q = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";

console.log('-- Jalankan di TiDB Cloud > SQL Editor (database: dashboard)');
console.log(
  `INSERT INTO users (nik, nama, jabatan, bam_scope, aktif, pw_hash, pw_salt, pw_iter, must_change)\n` +
  `VALUES (${q(nik)}, ${q(nama)}, 'ADMIN_PUSAT', NULL, 1, ${q(h.pw_hash)}, ${q(h.pw_salt)}, ${h.pw_iter}, 1);`);
console.log('');
console.log(`NIK              : ${nik}`);
console.log(`Password sementara: ${pw}    <- catat sekarang, tidak ditampilkan lagi`);
