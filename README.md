# Dashboard — pindah ke TiDB Cloud + login NIK (Cloudflare Pages)

Status: **tahap 1f — Perbarui Dashboard bertahap, Administrator tidak melihat Admin Utama, chip Muat ulang & cakupan dihapus**.
Tes otomatis (101 tes; sebagian dijalankan terhadap SQLite sungguhan, bukan hanya tiruan): `node --test "test/*.test.mjs"`.

## Tahap 1f — Perbarui Dashboard
**Tidak ada migrasi SQL baru.** Cukup deploy.

**Apa itu "Perbarui Dashboard" (dulu "Perbarui ringkasan" / "Refresh")?** Halaman Rank, Perform, dan Monitor tidak menghitung dari data mentah setiap kali dibuka
(terlalu berat). Hasil hitungnya disimpan di TiDB sebagai **tabel ringkasan** (`mv_dates`, `mv_ks`, `mv_mon_list`, `mv_tgl`, `mv_mon_rows`, `mv_mon_same`,
`mv_stock_idx`). Tombol ini menghitung ulang tabel-tabel itu dari data mentah (`sales_toko`, `sales_item`, `stock`, ...). Setelah upload data baru, dashboard
baru memakai data tersebut setelah ringkasan dihitung ulang (otomatis bila kotak "Perbarui dashboard otomatis" dicentang).

- **7 langkah**: 1 tanggal · 2 daftar toko · 3 daftar bulan · 4 penjualan harian · 5 penjualan item bulanan · 6 penjualan item tanggal sama · 7 stock.
  Langkah 4–6 dipecah menjadi potongan kecil (per bulan, dan 5–6 juga per 4 bagian kode toko) supaya tidak melewati batas transaksi/memori/waktu TiDB.
  Satu permintaan = satu potongan; progres tampil sebagai "Memperbarui dashboard 5 / 7 (3/16)".
- **Otomatis setelah upload hanya mengerjakan yang terdampak**: stock → langkah 7; stock_toko → 4; toko → 2 dan 7; sales_item → 5, 6, 7; modis → 7;
  sales_toko → semua; budged/trend/item/gempar → tidak perlu. Tombol manual selalu menjalankan semua langkah.
- **Bila gagal**, pesan lengkap dari database ditampilkan (langkah, potongan, dan pesan aslinya) supaya penyebabnya mudah dicari.
- Chip "Muat ulang" dihapus (data baru dimuat otomatis setelah Perbarui Dashboard; di layar HP tombol itu ada di header). Chip cakupan "SEMUA BAM · Semua Cabang" dihapus.
- Administrator tidak melihat akun Admin Utama di daftar pengguna maupun permintaan reset.

## Tahap 1e — yang berubah
**Jalankan `migrasi-1e.sql` di TiDB SEBELUM deploy** (tabel `data_updates` + akun Administrator). Tanpa itu, aplikasi tetap jalan,
hanya chip "Diperbarui" kosong ("-") dan akun `saybread` belum ada.

- **Login:** kolom "NIK / Username" dan kotak **Ingat saya** (sesi 30 hari, cookie menetap; tanpa centang: 12 jam, hilang saat browser ditutup).
- **Daftar toko dari tabel `toko`:** filter KODE/TOKO (Perform Toko) serta BAS/BASTR/AM/AS (Monitor Area) tidak lagi menunggu data Stock.
- **"Diperbarui":** dicatat di `data_updates` setiap impor/ubah/hapus data dan setiap Refresh. Data yang diunggah *sebelum* tahap ini belum
  tercatat: tekan **Refresh** sekali (atau unggah data baru) agar waktunya muncul.
- **Rank:** penjumlahan per cabang/PNL/BAS/BASTR/AM/AS kini dikerjakan di database (hanya ribuan baris ringkasan yang dikirim, bukan ratusan ribu baris
  harian), dan toko dicocokkan lewat `norm(kode)` sehingga spasi/huruf berbeda pada kode tidak membuat baris bulan baru terlewat.
  Kode toko juga dipangkas dari spasi saat diimpor. Bila SQL agregasi gagal, otomatis memakai cara lama.
- Tombol "Admin" diganti **User**; judul menjadi **Performance Say Bread**; "Admin Pusat" menjadi **Admin Utama**.

Bila bulan berjalan di Rank masih kosong, jalankan di SQL Editor TiDB untuk melihat apakah datanya ada di tabel ringkasan:
```sql
SELECT DATE_FORMAT(tanggal,'%Y-%m') AS bln, COUNT(*) AS baris, COUNT(DISTINCT tanggal) AS hari, SUM(qty) AS qty FROM mv_tgl GROUP BY 1 ORDER BY 1;
SELECT DATE_FORMAT(tanggal,'%Y-%m') AS bln, COUNT(*) AS baris, COUNT(DISTINCT tanggal) AS hari, SUM(sales_qty) AS qty FROM sales_toko GROUP BY 1 ORDER BY 1;
```

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

| Jabatan | Data yang terlihat | Boleh ubah data | Kelola pengguna | Ubah Rank BAS |
|---|---|---|---|---|
| Admin Utama (`ADMIN_PUSAT`) | semua | semua tabel | ya | ya |
| Administrator | semua | semua tabel | ya, kecuali akun Admin Utama | **tidak** (dibuat tidak terlihat) |
| Admin Koorbam | BAM dalam areanya | tabel data di areanya | tidak | tidak |
| Koorbam | BAM dalam areanya | tidak | tidak | tidak |
| BAM / BAS / BASTR | BAM dalam areanya | tidak | tidak | tidak |

Administrator: akun bawaan `saybread` / `saybread4321` dibuat oleh `migrasi-1e.sql` (**segera ganti password**).
Pembatasan Rank BAS sengaja tidak dijelaskan di layar: kontrol edit tidak muncul, dan jika fungsinya dipanggil langsung, server menjawab
seolah fungsi itu tidak ada. Administrator juga tidak bisa membuat, mengubah, atau mereset akun Admin Utama, atau menaikkan akun
jadi Admin Utama (kalau bisa, pembatasan tadi mudah dilewati).

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
