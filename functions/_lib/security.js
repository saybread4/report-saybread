// Hash password (PBKDF2-SHA256 via WebCrypto), token sesi, password sementara, aturan password.
const enc = new TextEncoder();

export const DEFAULT_ITER = 100000;   // batas maksimum PBKDF2 di Cloudflare Workers
export function iterFrom(env) {
  const n = Number(env && env.PBKDF2_ITER);
  return Number.isInteger(n) && n >= 10000 && n <= 100000 ? n : DEFAULT_ITER;
}

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));

export function randomHex(nBytes) {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return toHex(b);
}

export async function sha256Hex(s) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function hashPassword(pw, saltHex = randomHex(16), iter = DEFAULT_ITER) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: iter }, key, 256);
  return { pw_hash: toHex(bits), pw_salt: saltHex, pw_iter: iter };
}

// rec = { pw_hash, pw_salt, pw_iter }
export async function verifyPassword(pw, rec) {
  const { pw_hash } = await hashPassword(pw, rec.pw_salt, Number(rec.pw_iter) || DEFAULT_ITER);
  return timingSafeEqual(pw_hash, rec.pw_hash);
}

// Dipakai saat NIK tidak ada, agar waktu respons tidak membocorkan NIK mana yang terdaftar.
export const DUMMY = { pw_salt: '00'.repeat(16), pw_iter: DEFAULT_ITER, pw_hash: '00'.repeat(32) };

// Mengembalikan teks pesan kesalahan, atau null kalau password lolos.
export function checkPasswordPolicy(pw, nik) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password minimal 8 karakter.';
  if (pw.length > 128) return 'Password maksimal 128 karakter.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password harus mengandung huruf dan angka.';
  if (nik && pw.toUpperCase().includes(String(nik).toUpperCase())) return 'Password tidak boleh memuat NIK.';
  return null;
}

// Tanpa karakter yang mudah tertukar (0/O, 1/l/I). Pengambilan acak tanpa bias.
export function tempPassword(len = 10) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';   // 55 karakter
  for (;;) {
    const out = [];
    const buf = new Uint8Array(len * 3);
    while (out.length < len) {
      crypto.getRandomValues(buf);
      for (const b of buf) if (b < 220 && out.length < len) out.push(A[b % A.length]);
    }
    const s = out.join('');
    if (/[A-Za-z]/.test(s) && /[0-9]/.test(s)) return s;
  }
}
