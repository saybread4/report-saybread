// Sesi, jabatan, hak akses.
import { HttpError, getCookie, SESSION_COOKIE } from './http.js';
import { randomHex, sha256Hex } from './security.js';

export const SESSION_HOURS = 12;
export const MAX_FAILED = 5;       // salah password berturut-turut sebelum akun dikunci
export const LOCK_MINUTES = 15;

// ---- Jabatan --------------------------------------------------------------
export const JABATAN = ['ADMIN_PUSAT', 'ADMIN_KOORBAM', 'KOORBAM', 'BAM', 'BAS', 'BASTR'];
export const LABEL = {
  ADMIN_PUSAT: 'Admin Pusat',
  ADMIN_KOORBAM: 'Admin Koorbam',
  KOORBAM: 'Koorbam',
  BAM: 'BAM',
  BAS: 'BAS',
  BASTR: 'BASTR',
};
const EDIT_ROLES = new Set(['ADMIN_PUSAT', 'ADMIN_KOORBAM']);

export const isPusat = (u) => u.jabatan === 'ADMIN_PUSAT';

// need: 'view' (semua jabatan) | 'edit' (admin) | 'pusat' (Admin Pusat saja)
export function can(u, need) {
  if (!JABATAN.includes(u.jabatan)) return false;
  if (need === 'view') return true;
  if (need === 'edit') return EDIT_ROLES.has(u.jabatan);
  if (need === 'pusat') return isPusat(u);
  return false;
}

// ---- Normalisasi ----------------------------------------------------------
export const normNik = (s) => {
  const v = String(s == null ? '' : s).trim().toUpperCase();
  return /^[A-Z0-9._-]{3,30}$/.test(v) ? v : '';
};

export const normScope = (a) =>
  [...new Set((Array.isArray(a) ? a : []).map((x) => String(x).trim().toUpperCase()).filter(Boolean))];

// Kolom JSON dari driver bisa berupa string atau sudah berupa array.
export function parseScope(v) {
  if (v == null) return [];
  let a = v;
  if (typeof v === 'string') {
    try { a = JSON.parse(v); } catch { return []; }
  }
  return normScope(a);
}

export function publicUser(u) {
  const pusat = isPusat(u);
  return {
    nik: u.nik,
    nama: u.nama,
    jabatan: u.jabatan,
    label: LABEL[u.jabatan] || u.jabatan,
    bam_scope: pusat ? null : parseScope(u.bam_scope),   // null = semua BAM
    must_change: Number(u.must_change) === 1,
    can: { edit: can(u, 'edit'), users: can(u, 'pusat'), all: pusat },
  };
}

// ---- Sesi -----------------------------------------------------------------
export async function startSession(db, nik) {
  const token = randomHex(32);
  await db.exec(
    'INSERT INTO sessions (token_hash, nik, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR))',
    [await sha256Hex(token), nik, SESSION_HOURS]);
  return token;
}

export async function getSessionUser(db, request) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const th = await sha256Hex(token);
  const rows = await db.query(
    `SELECT u.nik, u.nama, u.jabatan, u.bam_scope, u.must_change
       FROM sessions s JOIN users u ON u.nik = s.nik
      WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP() AND u.aktif = 1
      LIMIT 1`, [th]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    nik: r.nik, nama: r.nama, jabatan: r.jabatan,
    bam_scope: parseScope(r.bam_scope),
    must_change: Number(r.must_change) === 1,
    tokenHash: th,
  };
}

// opts.need: 'view' | 'edit' | 'pusat'   opts.allowMustChange: boleh walau wajib ganti password
export async function requireUser(db, request, opts = {}) {
  const u = await getSessionUser(db, request);
  if (!u) throw new HttpError(401, 'Silakan masuk dulu.', 'LOGIN');
  if (u.must_change && !opts.allowMustChange)
    throw new HttpError(403, 'Anda harus mengganti password dulu.', 'MUST_CHANGE');
  if (!can(u, opts.need || 'view')) throw new HttpError(403, 'Anda tidak punya akses untuk ini.', 'FORBIDDEN');
  return u;
}

export async function audit(db, { nik = null, aksi, target = null, detail = null }) {
  try {
    await db.exec('INSERT INTO audit_log (nik, aksi, target_nik, detail) VALUES (?, ?, ?, ?)',
      [nik, aksi, target, detail && String(detail).slice(0, 250)]);
  } catch (e) {
    console.error('audit gagal', e);   // pencatatan tidak boleh menggagalkan permintaan
  }
}
