# Dashboard — pindah ke TiDB Cloud + login NIK (Cloudflare Pages)

Status: **tahap 1b — login NIK di tampilan, kelola pengguna, refresh, dan 23 fungsi baca**. Login dan koneksi TiDB sudah diuji di Cloudflare asli; fungsi data BELUM diuji dengan data asli (TiDB masih kosong).
Tes otomatis (41 tes, database tiruan): `node --test "test/*.test.mjs"`.

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
- Tampilan (`index.html`): login NIK, ganti password wajib, tombol **Admin** = Kelola Pengguna (Admin Pusat), tombol Keluar.
- `POST /api/auth/login`, `logout`, `change-password`, `GET /api/auth/me`
- `GET/POST /api/admin/users` — buat, ubah (jabatan/area/aktif), reset password (khusus Admin Pusat)
- `POST /api/rpc/<nama>` — pengganti RPC Supabase. Sudah ada: `getorg getbam getpnlcabang getplu getcabmeta getmeta getrows
  getstockfd getexcelfd gettanggal gettanggalcab gettglmentah getbasdata getbasdataitem getrankcab getmonitor getmonitorcab
  gettrend gethistori gethistory getbudged getbudovr getgempar` dan `adminrefresh` (isi ulang tabel `mv_*`, 7 langkah).
- Password: PBKDF2-SHA256 + salt per pengguna; kunci 15 menit setelah 5x salah; sesi 12 jam (cookie HttpOnly);
  password sementara wajib diganti saat login pertama; semua aksi tercatat di `audit_log`.

## Belum ada
- Impor data lama dari Supabase ke TiDB (tabel masih kosong), lalu jalankan Refresh (tombol Refresh di tampilan).
- Fungsi admin data: `adminlist admincount admininfo adminupdate admindelete admindeleterow adminimport`,
  `savegempar deletegempar getgemparlist gemparsave gemparlist gempardelete`, `savebudovr saverankovr`
- Telegram (Worker dengan Cron Trigger)

## Catatan
- PBKDF2 butuh waktu CPU. Jika Cloudflare menolak karena batas CPU paket gratis, turunkan `PBKDF2_ITER`
  atau pakai paket Workers berbayar.
- Disarankan menambah aturan *Rate Limiting* Cloudflare untuk `/api/auth/login`.
