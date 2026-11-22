// Database tiruan di memori — hanya mengenali SQL yang dipakai kode. SQL lain => error (supaya ketahuan).
import { hashPassword } from '../functions/_lib/security.js';

export async function makeUser(nik, pw, over = {}) {
  const h = await hashPassword(pw, undefined, 10000);
  return {
    nik, nama: 'User ' + nik, jabatan: 'BAM', bam_scope: JSON.stringify(['BAM A']), aktif: 1, must_change: 0,
    failed_count: 0, locked: false, last_login: null, ...h, ...over,
  };
}

export function fakeDb(users = [], extra = {}) {
  const st = { users: new Map(users.map((u) => [u.nik, u])), sessions: new Map(), audit: [], log: [], bams: ['BAM A', 'BAM B'], ...extra };
  const U = (nik) => st.users.get(nik);
  const db = {
    st,
    async query(sql, a = []) {
      st.log.push({ sql, a });
      const s = sql.replace(/\s+/g, ' ').trim();
      // --- pendaftaran & reset (tahap 1d) ---
      const R = st.regs || (st.regs = []), Q = st.resets || (st.resets = []);
      if (/FROM registrations WHERE nik = \? ORDER BY id DESC LIMIT 1/.test(s)) { const l = R.filter((r) => r.nik === a[0]); return l.length ? [l[l.length - 1]] : []; }
      if (/^SELECT 1 FROM registrations WHERE nik = \? AND status = 'PENDING'/.test(s)) return R.some((r) => r.nik === a[0] && r.status === 'PENDING') ? [{ 1: 1 }] : [];
      if (/^SELECT COUNT\(\*\) AS n FROM registrations WHERE status = 'PENDING'/.test(s)) return [{ n: R.filter((r) => r.status === 'PENDING').length }];
      if (/^SELECT 1 FROM users WHERE nik = \? AND aktif = 1/.test(s)) { const u = U(a[0]); return u && Number(u.aktif) === 1 ? [{ 1: 1 }] : []; }
      if (/^SELECT 1 FROM reset_requests WHERE nik = \? AND status = 'PENDING'/.test(s)) return Q.some((r) => r.nik === a[0] && r.status === 'PENDING') ? [{ 1: 1 }] : [];
      if (/^SELECT \(SELECT COUNT\(\*\) FROM registrations/.test(s)) {
        if (st.failCounts) throw new Error("Table 'registrations' doesn't exist");
        return [{ reg: R.filter((r) => r.status === 'PENDING').length, rst: Q.filter((r) => r.status === 'PENDING').length }];
      }
      if (/^SELECT id, nik, nama, jabatan_diminta/.test(s)) return R.filter((r) => r.status === 'PENDING');
      if (/FROM reset_requests r LEFT JOIN users u/.test(s)) return Q.filter((r) => r.status === 'PENDING').map((r) => ({ ...r, nama: (U(r.nik) || {}).nama, jabatan: (U(r.nik) || {}).jabatan }));
      if (/^SELECT id, nik, nama, pw_hash, pw_salt, pw_iter, status FROM registrations WHERE id/.test(s)) return R.filter((r) => r.id === a[0]);
      if (/^SELECT id, nik, status FROM reset_requests WHERE id/.test(s)) return Q.filter((r) => r.id === a[0]);
      if (/FROM users WHERE nik = \? LIMIT 1/.test(s) && s.includes('is_locked')) {
        const u = U(a[0]); return u ? [{ ...u, is_locked: u.locked ? 1 : 0 }] : [];
      }
      if (/^SELECT pw_hash, pw_salt, pw_iter FROM users/.test(s)) { const u = U(a[0]); return u ? [u] : []; }
      if (/FROM sessions s JOIN users u/.test(s)) {
        const se = st.sessions.get(a[0]); const u = se && U(se.nik);
        return u && u.aktif ? [{ nik: u.nik, nama: u.nama, jabatan: u.jabatan, bam_scope: u.bam_scope, must_change: u.must_change }] : [];
      }
      if (/^SELECT 1 FROM users WHERE nik/.test(s)) return U(a[0]) ? [{ 1: 1 }] : [];
      if (/^SELECT nik, jabatan, aktif FROM users/.test(s)) { const u = U(a[0]); return u ? [u] : []; }
      if (/^SELECT bam_scope FROM users/.test(s)) { const u = U(a[0]); return u ? [u] : []; }
      if (/^SELECT nik, nama, jabatan, bam_scope, aktif, must_change, last_login/.test(s)) return [...st.users.values()];
      if (/^SELECT DISTINCT UPPER\(TRIM\(bam\)\) AS bam FROM toko/.test(s)) return st.bams.map((bam) => ({ bam }));
      if (st.rows) { const r = st.rows(s, a); if (r) return r; }
      throw new Error('SQL query tidak dikenal di fakeDb: ' + s.slice(0, 90));
    },
    async exec(sql, a = []) {
      st.log.push({ sql, a });
      const s = sql.replace(/\s+/g, ' ').trim();
      let m;
      if (/^UPDATE users SET failed_count = \? WHERE/.test(s)) { U(a[1]).failed_count = a[0]; return; }
      if (/^UPDATE users SET failed_count = 0, locked_until = DATE_ADD/.test(s)) { const u = U(a[1]); u.failed_count = 0; u.locked = true; return; }
      if (/^UPDATE users SET failed_count = 0, locked_until = NULL, last_login/.test(s)) { const u = U(a[0]); u.failed_count = 0; u.locked = false; u.last_login = 'now'; return; }
      if (/^INSERT INTO sessions/.test(s)) { st.sessions.set(a[0], { nik: a[1] }); return; }
      if (/^DELETE FROM sessions WHERE expires_at/.test(s)) return;
      if (/^DELETE FROM sessions WHERE nik = \? AND token_hash <> \?/.test(s)) { for (const [k, v] of st.sessions) if (v.nik === a[0] && k !== a[1]) st.sessions.delete(k); return; }
      if (/^DELETE FROM sessions WHERE nik = \?/.test(s)) { for (const [k, v] of st.sessions) if (v.nik === a[0]) st.sessions.delete(k); return; }
      if (/^DELETE FROM sessions WHERE token_hash = \?/.test(s)) { st.sessions.delete(a[0]); return; }
      if (/^UPDATE users SET pw_hash = \?, pw_salt = \?, pw_iter = \?, must_change = 0/.test(s)) { Object.assign(U(a[3]), { pw_hash: a[0], pw_salt: a[1], pw_iter: a[2], must_change: 0 }); return; }
      if (/^UPDATE users SET pw_hash = \?, pw_salt = \?, pw_iter = \?, must_change = 1/.test(s)) { Object.assign(U(a[3]), { pw_hash: a[0], pw_salt: a[1], pw_iter: a[2], must_change: 1, failed_count: 0, locked: false }); return; }
      // --- pendaftaran & reset (tahap 1d) ---
      const R = st.regs || (st.regs = []), Q = st.resets || (st.resets = []);
      if (/^INSERT INTO registrations/.test(s)) { R.push({ id: R.length + 1, nik: a[0], nama: a[1], jabatan_diminta: a[2], area_diminta: a[3], kontak: a[4], pw_hash: a[5], pw_salt: a[6], pw_iter: a[7], status: 'PENDING', catatan: null, created_at: 'now' }); return; }
      if (/^INSERT INTO reset_requests/.test(s)) { Q.push({ id: Q.length + 1, nik: a[0], kontak: a[1], status: 'PENDING', created_at: 'now' }); return; }
      if (/^INSERT INTO users .*must_change, pw_changed_at/.test(s)) {
        st.users.set(a[0], { nik: a[0], nama: a[1], jabatan: a[2], bam_scope: a[3], aktif: 1, pw_hash: a[4], pw_salt: a[5], pw_iter: a[6], must_change: 0, failed_count: 0, locked: false }); return;
      }
      if (/^UPDATE registrations SET status = 'APPROVED'/.test(s)) { R.find((r) => r.id === a[1]).status = 'APPROVED'; return; }
      if (/^UPDATE registrations SET status = 'REJECTED', catatan = \?/.test(s)) { const r = R.find((r) => r.id === a[2]); r.status = 'REJECTED'; r.catatan = a[0]; return; }
      if ((m = s.match(/^UPDATE reset_requests SET status = '(DONE|REJECTED)'/))) { Q.find((r) => r.id === a[1]).status = m[1]; return; }
      if (/^INSERT INTO users/.test(s)) {
        st.users.set(a[0], { nik: a[0], nama: a[1], jabatan: a[2], bam_scope: a[3], aktif: 1, pw_hash: a[4], pw_salt: a[5], pw_iter: a[6], must_change: 1, failed_count: 0, locked: false }); return;
      }
      if ((m = s.match(/^UPDATE users SET (.+) WHERE nik = \?$/))) {
        const cols = m[1].split(',').map((x) => x.trim().split(' = ')[0]); const u = U(a[a.length - 1]);
        cols.forEach((c, i) => { u[c] = a[i]; }); return;
      }
      if (/^INSERT INTO audit_log/.test(s)) { st.audit.push({ nik: a[0], aksi: a[1], target: a[2], detail: a[3] }); return; }
      throw new Error('SQL exec tidak dikenal di fakeDb: ' + s.slice(0, 90));
    },
  };
  return db;
}

export const req = (path, { method = 'POST', body, cookie, origin } = {}) =>
  new Request('https://dash.test' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const cookieOf = (res) => {
  const m = /sid=([0-9a-f]{64})/.exec(res.headers.get('set-cookie') || '');
  return m ? 'sid=' + m[1] : null;
};
