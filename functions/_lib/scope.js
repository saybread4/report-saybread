// Pembatasan data per area, dilakukan di SERVER (bukan di browser).
//   Admin Pusat                      -> semua data
//   Jabatan lain                     -> hanya toko yang kolom `bam`-nya ada di bam_scope pengguna
//   bam_scope kosong                 -> tidak ada data (gagal tertutup)
import { isPusat } from './auth.js';

const IDENT = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const ph = (n) => Array(n).fill('?').join(',');

function ident(col) {
  if (!IDENT.test(col)) throw new Error('Nama kolom tidak valid: ' + col);   // kolom disisipkan ke SQL, jadi harus aman
  return col;
}

// Tabel yang punya kolom `bam` sendiri (toko, budged).
export function bamWhere(user, col = 'bam') {
  if (isPusat(user)) return { sql: '1=1', params: [] };
  const s = user.bam_scope || [];
  if (!s.length) return { sql: '1=0', params: [] };
  return { sql: `UPPER(TRIM(${ident(col)})) IN (${ph(s.length)})`, params: [...s] };
}

// Tabel data lain (stock, sales_toko, trend, ...): lewat kode toko.
export function kodeWhere(user, col = 'kode') {
  if (isPusat(user)) return { sql: '1=1', params: [] };
  const s = user.bam_scope || [];
  if (!s.length) return { sql: '1=0', params: [] };
  return {
    sql: `UPPER(TRIM(${ident(col)})) IN (SELECT UPPER(TRIM(x.kode)) FROM toko x WHERE UPPER(TRIM(x.bam)) IN (${ph(s.length)}))`,
    params: [...s],
  };
}
