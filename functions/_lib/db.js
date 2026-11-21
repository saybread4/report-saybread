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
      return Array.isArray(r) ? r : (r && r.rows) || [];
    },
    // INSERT / UPDATE / DELETE
    async exec(sql, args = []) {
      await conn.execute(sql, args);
    },
  };
}
