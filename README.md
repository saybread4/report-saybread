# Dashboard — pindah ke TiDB Cloud + login NIK (Cloudflare Pages)

Status: **tahap 1c — semua fungsi data sudah ada (baca, refresh, admin data, Gempar, override)**. Login dan koneksi TiDB sudah diuji di Cloudflare asli; fungsi data BELUM diuji dengan data asli (TiDB masih kosong).
Tes otomatis (62 tes, database tiruan; SQL-nya belum pernah dijalankan di TiDB): `node --test "test/*.test.mjs"`.

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
