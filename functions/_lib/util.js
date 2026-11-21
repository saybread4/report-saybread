// Pengganti fungsi SQL norm() dan nz() dari Postgres (TiDB tidak punya fungsi buatan sendiri).
export const norm = (s) => String(s == null ? '' : s).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
export const nz = (s) => {
  const t = String(s == null ? '' : s).trim();
  return t === '0' ? '' : t;
};
export const num = (v) => (v == null || v === '' ? 0 : Number(v));
