// Koneksi ke TiDB Cloud lewat driver HTTP (@tidbcloud/serverless), cocok untuk Cloudflare.
// Driver di-import saat dibutuhkan supaya file lain bisa diuji tanpa driver terpasang.
import { HttpError } from './http.js';

export async function getDb(env) {
  if (!env || !env.DATABASE_URL) throw new HttpError(500, 'DATABASE_URL belum diatur di Cloudflare.');
  const { connect } = await import('@tidbcloud/serverless');
  const conn = connect({ url: env.DATABASE_URL });
  return {
    // SELECT -> array baris (objek)
    async query(sql, args = []) {
      const r = await conn.execute(sql, args);
      const rows = Array.isArray(r) ? r : (r && r.rows) || [];
      // Driver memotong hasil di 10.000 baris tanpa galat. Gunakan queryAll() (ks.js) untuk query yang bisa lebih besar.
      if (rows.length === 10000) console.error('PERINGATAN: hasil tepat 10000 baris, kemungkinan terpotong:', String(sql).replace(/\s+/g, ' ').slice(0, 160));
      return rows;
    },
    // INSERT / UPDATE / DELETE
    async exec(sql, args = []) {
      await conn.execute(sql, args);
    },
    // Beberapa perintah dalam SATU transaksi: semuanya berhasil, atau semuanya dibatalkan (data lama tetap utuh).
    // fn menerima { exec, query } yang berjalan di dalam transaksi.
    async tx(fn) {
      const t = await conn.begin();
      try {
        const r = await fn({
          async query(sql, args = []) { const x = await t.execute(sql, args); return Array.isArray(x) ? x : (x && x.rows) || []; },
          async exec(sql, args = []) { await t.execute(sql, args); },
        });
        await t.commit();
        return r;
      } catch (e) {
        try { await t.rollback(); } catch { /* sambungan mungkin sudah putus */ }
        throw e;
      }
    },
  };
}
