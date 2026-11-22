# Dashboard — pindah ke TiDB Cloud + login NIK (Cloudflare Pages)

Status: **tahap 1d — login langsung ke halaman utama, menu pengguna, daftar akun, dan reset password**. Semua fungsi data dari tahap 1c tetap ada.
Tes otomatis (75 tes, database tiruan; SQL-nya belum pernah dijalankan di TiDB asli): `node --test "test/*.test.mjs"`.

## Daftar akun & reset password (tahap 1d)

**Jalankan `migrasi-1d.sql` di TiDB SEBELUM deploy** (membuat tabel `registrations` dan `reset_requests`).
Bila lupa, login tetap berjalan, tetapi Daftar/Lupa password akan gagal dan lencana Admin tidak muncul.

Alur:
1. Calon pengguna menekan **Daftar akun** di halaman masuk, mengisi NIK, nama, jabatan, area BAM, (opsional) WhatsApp, dan password pilihannya.
   Jabatan Admin tidak bisa dipilih sendiri. Isian jabatan dan area hanya *permintaan*.
2. Admin Pusat membuka **Admin → Pendaftaran** (lencana merah menunjukkan jumlahnya), memeriksa, memperbaiki jabatan dan area bila perlu
   (area ditebak otomatis dari teks yang ditulis pendaftar), lalu **Setujui** atau **Tolak** (dengan alasan).
3. Sebelum disetujui, pendaftar yang mencoba masuk melihat "menunggu verifikasi" (hanya bila passwordnya cocok). Setelah disetujui, ia masuk dengan password pilihannya sendiri.
4. **Lupa password**: pengguna mengirim NIK (+ WhatsApp). Tidak ada password yang berubah. Admin Pusat membuka **Admin → Reset password**,
   menekan **Buat password sementara**, lalu menyampaikannya langsung. Pengguna wajib menggantinya saat masuk.

Keamanan: jawaban "lupa password" selalu sama untuk NIK terdaftar maupun tidak; antrean pendaftaran dibatasi 300; password pendaftar disimpan sebagai hash.
Disarankan menambah aturan *Rate Limiting* Cloudflare untuk `/api/auth/register` dan `/api/auth/reset-request`.

Tampilan: setelah masuk, pengguna langsung ke halaman utama (data sudah dibatasi di server sesuai area). Nama, **Ganti password**, dan **Keluar**
ada di menu pengguna (pojok kanan atas header). Chip cakupan di header tetap bisa dipakai untuk mempersempit ke BAM/cabang tertentu.

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

## Yang sudah ada (tahap 1b)
- Tampilan (`index.html`): login NIK, ganti password wajib, tombol **Admin** = Kelola Pengguna (Admin Pusat), tombol Keluar.
- `POST /api/auth/login`, `logout`, `change-password`, `GET /api/auth/me`
- `GET/POST /api/admin/users` — buat, ubah (jabatan/area/aktif), reset password (khusus Admin Pusat)
- `POST /api/rpc/<nama>` — pengganti RPC Supabase. Sudah ada: `getorg getbam getpnlcabang getplu getcabmeta getmeta getrows
  getstockfd getexcelfd gettanggal gettanggalcab gettglmentah getbasdata getbasdataitem getrankcab getmonitor getmonitorcab
  gettrend gethistori gethistory getbudged getbudovr getgempar` dan `adminrefresh` (isi ulang tabel `mv_*`, 7 langkah).
- Password: PBKDF2-SHA256 + salt per pengguna; kunci 15 menit setelah 5x salah; sesi 12 jam (cookie HttpOnly);
  password sementara wajib diganti saat login pertama; semua aksi tercatat di `audit_log`.

## Admin data (tahap 1c)
`adminlist admincount admininfo adminupdate admindelete admindeleterow adminimport`, `savebudovr saverankovr`,
`getgemparlist savegempar deletegempar gemparlist gemparsave gempardelete` — posisi argumen sama dengan versi Supabase.

| Fungsi | Siapa |
|---|---|
| admin data + `savebudovr` | Admin Pusat (semua tabel) dan Admin Koorbam (hanya BAM di areanya; tabel `item` khusus Pusat) |
| Gempar, `saverankovr` | Admin Pusat |

Perbedaan dari versi Postgres yang perlu diketahui:
- **Tanpa transaksi.** Bila impor berhenti di tengah, jalankan ulang dengan mode "Tambah / perbarui" (upsert aman diulang).
  Pada tabel tanpa kunci unik (`stock_toko`, `budged`, `trend`) mode "Ganti" yang terputus lalu diulang bisa menimbulkan baris ganda —
  untuk tabel itu, ulangi dengan "Tambah / perbarui", yang menghapus kunci lama lebih dulu.
- `fixKode()` (pengganti trigger `trg_fix_kode`) dipakai pada semua tabel yang punya kolom `kode`: "7-Feb" -> "FEB7".
- Jumlah baru/diubah dihitung lewat query hitung sebelum insert (bukan "rows affected").
- Baris kembar dalam satu kiriman: yang terakhir menang.
- Edit budged (`savebudovr`) kini butuh login admin; sebelumnya siapa pun bisa.

## Urutan upload data baru
1. `toko` -> 2. `item` -> 3. `modis` -> 4. `budged` -> 5. `sales_toko` -> 6. `stock_toko` -> 7. `stock` -> 8. `sales_item` -> 9. `trend`
(`pnl_cabang`, `sales_kode_ref` belum punya jalur upload di tampilan; isi lewat SQL/Import TiDB Cloud bila perlu.)
Setelah selesai, tekan **Refresh** (7 langkah) supaya tabel `mv_*` terisi. Admin Koorbam hanya bisa mengunggah data
tabel lain setelah `toko` untuk BAM-nya ada.

## Belum ada
- Telegram (Worker dengan Cron Trigger + token bot sebagai Secret)
- Pemindahan `pnl_cabang`, `sales_kode_ref`, `rank_override`, `budged_override` bila ingin membawa data lama

## Catatan
- PBKDF2 butuh waktu CPU. Jika Cloudflare menolak karena batas CPU paket gratis, turunkan `PBKDF2_ITER`
  atau pakai paket Workers berbayar.
- Disarankan menambah aturan *Rate Limiting* Cloudflare untuk `/api/auth/login`.
