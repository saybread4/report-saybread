// Area pengguna = pilihan KOORBAM / BAM / CABANG (boleh lebih dari satu, saling terhubung).
//
// Disimpan di kolom users.bam_scope (JSON) TANPA mengubah skema:
//   lama : ["BAM A","BAM B"]                                   -> hanya BAM
//   baru : {"bam":["SFI"],"cabang":["SURABAYA 1"],"sel":{"k":[],"b":["SFI"],"c":["SURABAYA 1"]}}
//          bam    = daftar BAM yang dihitung server (dipakai semua pembatasan data)
//          cabang = pembatas tambahan; kosong = seluruh cabang pada BAM itu
//          sel    = pilihan asli di layar (untuk ditampilkan lagi saat diedit)
// Server selalu menghitung ulang dari tabel toko; isi dari browser tidak dipercaya.
import { HttpError } from './http.js';

export const upper = (v) => String(v == null ? '' : v).trim().toUpperCase();
const uniq = (a) => [...new Set(a)];
const list = (x) => (Array.isArray(x) ? x : []).map((v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 500);

// Hierarki dari tabel toko: [{ k, b, c }] (nama asli, tanpa duplikat). k kosong = toko belum punya KOORBAM.
// Bila kolom k_bam belum ada, semua k kosong (KOORBAM tidak bisa dipilih, BAM & CABANG tetap jalan).
export async function loadHierarchy(db) {
  const base = (k) => `SELECT ${k} AS k, TRIM(bam) AS b, TRIM(cabang) AS c FROM toko WHERE bam IS NOT NULL AND TRIM(bam) <> '' AND cabang IS NOT NULL AND TRIM(cabang) <> '' GROUP BY ${k}, TRIM(bam), TRIM(cabang)`;
  let rows;
  try { rows = await db.query(base("CASE WHEN TRIM(COALESCE(k_bam, '')) IN ('', '0') THEN '' ELSE TRIM(k_bam) END")); }
  catch (e) { rows = await db.query(base("''")); }
  const seen = new Set(), out = [];
  for (const r of rows) {
    const x = { k: String(r.k || ''), b: String(r.b || ''), c: String(r.c || '') };
    const key = `${upper(x.k)}\u0001${upper(x.b)}\u0001${upper(x.c)}`;
    if (!seen.has(key)) { seen.add(key); out.push(x); }
  }
  return out.sort((p, q) => (p.k + '|' + p.b + '|' + p.c).localeCompare(q.k + '|' + q.b + '|' + q.c));
}

// Untuk layar admin: kegagalan membaca hierarki tidak boleh menggagalkan seluruh halaman (dropdown saja yang kosong).
export const loadHierarchySafe = async (db) => { try { return await loadHierarchy(db); } catch (e) { console.error('hierarki gagal dibaca', e && e.message); return []; } };

// Jabatan KOORBAM memilih KOORBAM saja, jabatan BAM memilih BAM saja; sisanya (BAM/CABANG di bawahnya) otomatis semua.
// Jabatan lain memakai ketiga pilihan. Dilakukan di server juga, bukan hanya dengan menyembunyikan dropdown di layar.
export function areaForJabatan(jabatan, a) {
  a = a && typeof a === 'object' ? a : {};
  if (jabatan === 'KOORBAM') return { koorbam: a.koorbam };
  if (jabatan === 'BAM') return { bam: a.bam };
  return a;
}

export const hasSelection = (a) => !!a && typeof a === 'object' && (list(a.koorbam).length || list(a.bam).length || list(a.cabang).length) > 0;

// Pilihan -> { bam, cabang, sel }. Melempar 400 bila kosong atau tidak cocok dengan data toko.
export async function resolveArea(db, input) {
  const K = new Set(list(input && input.koorbam).map(upper)), B = new Set(list(input && input.bam).map(upper)), C = new Set(list(input && input.cabang).map(upper));
  if (!K.size && !B.size && !C.size) throw new HttpError(400, 'Pilih minimal satu KOORBAM, BAM, atau CABANG untuk area jabatan ini.', 'NO_SCOPE');
  const H = await loadHierarchy(db);
  const hit = H.filter((r) => (!K.size || K.has(upper(r.k))) && (!B.size || B.has(upper(r.b))) && (!C.size || C.has(upper(r.c))));
  if (!hit.length) throw new HttpError(400, 'Pilihan KOORBAM / BAM / CABANG tidak cocok dengan data toko (mungkin tabel toko belum diimpor).', 'NO_MATCH');
  const bam = uniq(hit.map((r) => upper(r.b))).sort();
  // cabang hanya menjadi pembatas bila dipilih DAN tidak mencakup semua cabang pada BAM tersebut (cabang baru di kemudian hari tetap ikut)
  let cabang = [];
  if (C.size) {
    const chosen = new Set(hit.map((r) => upper(r.c)));
    const all = new Set(H.filter((r) => bam.includes(upper(r.b))).map((r) => upper(r.c)));
    if ([...all].some((c) => !chosen.has(c))) cabang = [...chosen].sort();
  }
  return { bam, cabang, sel: { k: list(input.koorbam), b: list(input.bam), c: list(input.cabang) } };
}

// Nilai yang disimpan di users.bam_scope.
export const packArea = (r) => ({ bam: r.bam, cabang: r.cabang, sel: r.sel });

// Baca users.bam_scope (array lama ATAU objek baru, string JSON atau sudah berupa nilai) -> { bam, cabang, sel }
export function readArea(v) {
  let a = v;
  if (typeof v === 'string') { try { a = JSON.parse(v); } catch { a = null; } }
  const up = (x) => uniq((Array.isArray(x) ? x : []).map(upper).filter(Boolean));
  if (Array.isArray(a)) return { bam: up(a), cabang: [], sel: { k: [], b: [], c: [] } };
  if (a && typeof a === 'object') {
    const s = a.sel || {};
    return { bam: up(a.bam), cabang: up(a.cabang), sel: { k: list(s.k), b: list(s.b), c: list(s.c) } };
  }
  return { bam: [], cabang: [], sel: { k: [], b: [], c: [] } };
}

// Ringkasan teks untuk tampilan: "KOORBAM: X · BAM: A, B · CABANG: C, D"
export function areaText(r) {
  const p = [];
  if (r.sel && r.sel.k.length) p.push('KOORBAM: ' + r.sel.k.join(', '));
  p.push('BAM: ' + (r.sel && r.sel.b.length ? r.sel.b.join(', ') : r.bam.join(', ')));
  if (r.cabang.length) p.push('CABANG: ' + ((r.sel && r.sel.c.length) ? r.sel.c.join(', ') : r.cabang.join(', ')));
  return p.join(' · ');
}
