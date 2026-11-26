// Sesi, jabatan, hak akses.
import { HttpError, getCookie, SESSION_COOKIE } from './http.js';
import { randomHex, sha256Hex } from './security.js';
import { readArea } from './area.js';

export const SESSION_HOURS = 12;          // sesi biasa (cookie berakhir saat browser ditutup)
export const REMEMBER_HOURS = 24 * 30;    // "Ingat saya": 30 hari
export const MAX_FAILED = 5;       // salah password berturut-turut sebelum akun dikunci
export const LOCK_MINUTES = 15;

// ---- Jabatan --------------------------------------------------------------
export const JABATAN = ['ADMIN_PUSAT', 'ADMINISTRATOR', 'ADMIN_KOORBAM', 'KOORBAM', 'BAM', 'BAS', 'BASTR'];
export const LABEL = {
  ADMIN_PUSAT: 'Admin Utama',
  ADMINISTRATOR: 'Administrator',
  ADMIN_KOORBAM: 'Admin KOORBAM',
  KOORBAM: 'KOORBAM',
  BAM: 'BAM',
  BAS: 'BAS',
  BASTR: 'BASTR',
};
const EDIT_ROLES = new Set(['ADMIN_PUSAT', 'ADMINISTRATOR', 'ADMIN_KOORBAM']);
const FULL_ROLES = new Set(['ADMIN_PUSAT', 'ADMINISTRATOR']);

// Akses penuh: melihat semua area, mengubah semua data, dan mengelola pengguna.
// Berlaku untuk Admin Utama DAN Administrator.
export const isPusat = (u) => FULL_ROLES.has(u.jabatan);
export const isFullRole = (jabatan) => FULL_ROLES.has(jabatan);
// Rank BAM (ditampilkan dengan label KOORBAM): hanya Koorbam, Admin Koorbam, Administrator, dan Admin Utama.
const RANK_BAM_ROLES = new Set(['KOORBAM', 'ADMIN_KOORBAM', 'ADMINISTRATOR', 'ADMIN_PUSAT']);
export const canRankBam = (u) => RANK_BAM_ROLES.has(u.jabatan);
// Hanya Admin Utama (mis. mengubah Rank BAS, membuat/mengubah akun Admin Utama).
export const isUtama = (u) => u.jabatan === 'ADMIN_PUSAT';

// need: 'view' (semua jabatan) | 'edit' (admin) | 'pusat' (akses penuh) | 'utama' (Admin Utama saja)
export function can(u, need) {
  if (!JABATAN.includes(u.jabatan)) return false;
  if (need === 'view') return true;
  if (need === 'edit') return EDIT_ROLES.has(u.jabatan);
  if (need === 'pusat') return isPusat(u);
  if (need === 'utama') return isUtama(u);
  return false;
}

// ---- Normalisasi ----------------------------------------------------------
export const normNik = (s) => {
  const v = String(s == null ? '' : s).trim().toUpperCase();
  return /^[A-Z0-9._-]{3,30}$/.test(v) ? v : '';
};

export const normScope = (a) =>
  [...new Set((Array.isArray(a) ? a : []).map((x) => String(x).trim().toUpperCase()).filter(Boolean))];

// Kolom JSON dari driver bisa berupa string atau sudah berupa array/objek. Hasil: daftar BAM (format lama dan baru sama-sama dibaca).
export function parseScope(v) {
  return readArea(v).bam;
}

export function publicUser(u) {
  const pusat = isPusat(u);
  return {
    nik: u.nik,
    nama: u.nama,
    jabatan: u.jabatan,
    label: LABEL[u.jabatan] || u.jabatan,
    bam_scope: pusat ? null : parseScope(u.bam_scope),   // null = semua BAM
    cabang_scope: pusat ? null : readArea(u.bam_scope).cabang,   // [] = seluruh cabang pada BAM tsb
    area_sel: pusat ? null : readArea(u.bam_scope).sel,
    must_change: Number(u.must_change) === 1,
    can: { edit: can(u, 'edit'), users: can(u, 'pusat'), all: pusat, rank: isUtama(u), rankbam: canRankBam(u) },
  };
}

// ---- Sesi -----------------------------------------------------------------
export async function startSession(db, nik, hours = SESSION_HOURS) {
  const token = randomHex(32);
  await db.exec(
    'INSERT INTO sessions (token_hash, nik, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR))',
    [await sha256Hex(token), nik, hours]);
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
    cabang_scope: readArea(r.bam_scope).cabang,
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
