// Pembatasan data per area, dilakukan di SERVER (bukan di browser).
//   Admin Pusat                      -> semua data
//   Jabatan lain                     -> hanya toko yang kolom `bam`-nya ada di bam_scope pengguna
//   cabang_scope (opsional)          -> ditambah syarat: cabang toko harus ada di daftar itu
//   bam_scope kosong                 -> tidak ada data (gagal tertutup)
import { isPusat } from './auth.js';

const IDENT = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const ph = (n) => Array(n).fill('?').join(',');

function ident(col) {
  if (!IDENT.test(col)) throw new Error('Nama kolom tidak valid: ' + col);   // kolom disisipkan ke SQL, jadi harus aman
  return col;
}

// Pembatas CABANG (opsional): bila pengguna dibatasi ke cabang tertentu pada BAM-nya, tambahkan syaratnya.
// Kolom cabang = kolom bam dengan akhiran diganti `cabang` (x.bam -> x.cabang); toko dan budged sama-sama punya kolom itu.
function cabSql(user, bamCol) {
  const c = (user.cabang_scope || []);
  if (!c.length) return { sql: '', params: [] };
  return { sql: ` AND UPPER(TRIM(${ident(bamCol.replace(/bam$/, 'cabang'))})) IN (${ph(c.length)})`, params: [...c] };
}

// Tabel yang punya kolom `bam` sendiri (toko, budged).
export function bamWhere(user, col = 'bam') {
  if (isPusat(user)) return { sql: '1=1', params: [] };
  const s = user.bam_scope || [];
  if (!s.length) return { sql: '1=0', params: [] };
  const cb = cabSql(user, ident(col));
  const base = `UPPER(TRIM(${ident(col)})) IN (${ph(s.length)})`;
  return { sql: cb.sql ? `(${base}${cb.sql})` : base, params: [...s, ...cb.params] };   // tanpa pembatas cabang: SQL sama seperti sebelumnya
}

// Tabel data lain (stock, sales_toko, trend, ...): lewat kode toko.
export function kodeWhere(user, col = 'kode') {
  if (isPusat(user)) return { sql: '1=1', params: [] };
  const s = user.bam_scope || [];
  if (!s.length) return { sql: '1=0', params: [] };
  const cb = cabSql(user, 'x.bam');
  return {
    sql: `UPPER(TRIM(${ident(col)})) IN (SELECT UPPER(TRIM(x.kode)) FROM toko x WHERE UPPER(TRIM(x.bam)) IN (${ph(s.length)})${cb.sql})`,
    params: [...s, ...cb.params],
  };
}
