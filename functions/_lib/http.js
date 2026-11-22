// Utilitas HTTP: respons JSON, error, cookie sesi, proteksi asal permintaan.

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

// Format { message } sama dengan yang dibaca shim lama: (await r.json()).message
export function errorResponse(e) {
  if (e instanceof HttpError) return json({ message: e.message, code: e.code }, e.status);
  console.error(e);
  return json({ message: 'Terjadi kesalahan di server.' }, 500);
}

export async function readJson(request, maxChars = 8_000_000) {
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('application/json')) throw new HttpError(415, 'Content-Type harus application/json.');
  const text = await request.text();
  if (text.length > maxChars) throw new HttpError(413, 'Data terlalu besar.');
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new HttpError(400, 'JSON tidak valid.');
  }
}

// Lapis tambahan di atas SameSite=Strict: tolak permintaan lintas-situs.
export function checkOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return;
  let host;
  try { host = new URL(origin).host; } catch { throw new HttpError(403, 'Asal permintaan ditolak.'); }
  if (host !== new URL(request.url).host) throw new HttpError(403, 'Asal permintaan ditolak.');
}

export const SESSION_COOKIE = 'sid';

export function getCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// maxAgeSec null = cookie sesi (hilang saat browser ditutup); angka = cookie menetap ("Ingat saya").
export const setSessionCookie = (token, maxAgeSec) =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict${maxAgeSec ? `; Max-Age=${maxAgeSec}` : ''}`;

export const clearSessionCookie = () =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
