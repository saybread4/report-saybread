// Pengganti fungsi SQL norm() dan nz() dari Postgres (TiDB tidak punya fungsi buatan sendiri).
export const norm = (s) => String(s == null ? '' : s).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
export const nz = (s) => {
  const t = String(s == null ? '' : s).trim();
  return t === '0' ? '' : t;
};
export const num = (v) => (v == null || v === '' ? 0 : Number(v));

// Pengganti trigger trg_fix_kode / fungsi fix_kode() Postgres (TiDB tidak punya trigger):
// Excel sering mengubah kode seperti "FEB7" menjadi tanggal ("7-Feb", "2/7/2026", "2026-02-07").
// Fungsi ini mengembalikannya ke bentuk kode. Kode normal tidak diubah.
const BLN = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const BLN_OK = new Set(['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'MEI', 'JUN', 'JUL', 'AUG', 'AGU', 'AGT', 'SEP', 'OCT', 'OKT', 'NOV', 'DEC', 'DES']);
export function fixKode(k) {
  if (k == null) return k;
  const s = String(k);
  if (!/[-/ :]/.test(s)) return s;
  const t = s.trim();
  let m = t.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})(?:[-/ ]\d{2,4})?$/);               // 7-Feb, 07-Feb-26, 7 Feb
  if (m && BLN_OK.has(m[2].toUpperCase())) return m[2].toUpperCase() + parseInt(m[1], 10);
  m = t.match(/^([A-Za-z]{3})[-/ ](\d{1,2})(?:[-/ ]\d{2,4})?$/);                   // Feb-07
  if (m && BLN_OK.has(m[1].toUpperCase())) return m[1].toUpperCase() + parseInt(m[2], 10);
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?: \d{1,2}:\d{2}(?::\d{2})?)?$/);   // 2/7/2026 (bulan/tanggal/tahun)
  if (m) {
    const mo = +m[1], dy = +m[2];
    if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) return BLN[mo - 1] + dy;
  }
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/);   // 2026-02-07
  if (m) {
    const mo = +m[2], dy = +m[3];
    if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) return BLN[mo - 1] + dy;
  }
  return s;
}

// Hasil handler yang SUDAH berupa teks JSON (mis. getrows: ratusan ribu baris). Server mengirimnya apa adanya tanpa JSON.stringify
// ulang, sehingga tidak perlu menyimpan ratusan ribu array kecil di memori Worker.
export class RawJson {
  constructor(json) { this.json = json; }
  toString() { return this.json; }
  toJSON() { return JSON.parse(this.json); }
}
