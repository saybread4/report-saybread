# Dashboard — pindah ke TiDB Cloud + login NIK (Cloudflare Pages)

Status: **tahap 1a — fondasi login dan hak akses**. Belum diuji di TiDB / Cloudflare asli.
Tes otomatis (32 tes, database tiruan): `node --test "test/*.test.mjs"`.

## Hak akses

| Jabatan        | Data yang terlihat        | Boleh ubah data         | Kelola pengguna |
|----------------|---------------------------|-------------------------|-----------------|
| Admin Pusat    | semua                     | semua tabel             | ya              |
| Admin Koorbam  | BAM dalam areanya         | tabel data di areanya   | tidak           |
| Koorbam        | BAM dalam areanya         | tidak                   | tidak           |
| BAM / BAS / BASTR | BAM dalam areanya      | tidak                   | tidak           |

"Area" = daftar BAM di kolom `users.bam_scope`, diisi Admin Pusat. Pembatasan dilakukan di server
(`functions/_lib/scope.js`), bukan di browser. Area kosong = tidak ada data.

## Pemasangan

1. **TiDB Cloud**: buat cluster Starter (region Singapore). Jalankan `schema.sql` di SQL Editor.
   Lalu cek zona waktu: `SELECT @@time_zone, NOW(), UTC_TIMESTAMP();` — NOW() dan UTC_TIMESTAMP() harus sama.
2. **Admin Pusat pertama**: `node scripts/seed-admin.mjs --nik <NIK> --nama "<Nama>"`,
   tempel SQL hasilnya ke SQL Editor, catat password sementaranya.
3. **Folder proyek**: letakkan `index.html` dan `_headers` Anda di sebelah folder `functions/` dan `package.json`.
   Jalankan `npm install @tidbcloud/serverless`, lalu commit `package.json` dan `package-lock.json`.
4. **Cloudflare Pages** → Settings → Variables and Secrets (jenis Secret):
   - `DATABASE_URL` = `mysql://USER:PASSWORD@HOST/dashboard` (dari tombol Connect di TiDB Cloud)
   - `PBKDF2_ITER` (opsional, 10000–100000; bawaan 100000)
5. Deploy, lalu coba:
   ```
   curl -i -X POST https://<situs>/api/auth/login -H "Content-Type: application/json" \
        -d '{"nik":"<NIK>","password":"<password sementara>"}'
   ```

## Yang sudah ada
- `POST /api/auth/login`, `logout`, `change-password`, `GET /api/auth/me`
- `GET/POST /api/admin/users` — buat, ubah (jabatan/area/aktif), reset password (khusus Admin Pusat)
- `POST /api/rpc/<nama>` — pengganti RPC Supabase; baru `getorg`, `getbam`, `getpnlcabang`, `getplu`
- Password: PBKDF2-SHA256 + salt per pengguna; kunci 15 menit setelah 5x salah; sesi 12 jam (cookie HttpOnly);
  password sementara wajib diganti saat login pertama; semua aksi tercatat di `audit_log`.

## Belum ada
- ~45 fungsi data lain (rank, monitor, trend, budged, stock, impor admin, ...), refresh tabel `mv_*`
- Halaman login NIK, ganti password, dan kelola pengguna di `index.html`
- Telegram (Worker dengan Cron Trigger)

## Catatan
- PBKDF2 butuh waktu CPU. Jika Cloudflare menolak karena batas CPU paket gratis, turunkan `PBKDF2_ITER`
  atau pakai paket Workers berbayar.
- Disarankan menambah aturan *Rate Limiting* Cloudflare untuk `/api/auth/login`.
