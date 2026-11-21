-- ============================================================================
--  schema.sql  —  TiDB Cloud (MySQL-compatible)
--  Hasil terjemahan dari skema Supabase (Postgres). BELUM diuji di TiDB asli.
--  Jalankan di TiDB Cloud > SQL Editor (atau mysql client), per blok.
--
--  Catatan penting:
--   * TiDB tidak punya fungsi buatan sendiri, trigger, maupun materialized view.
--       - norm(), nz(), jarr(), fix_kode()  -> dipindah ke kode API (JavaScript)
--       - trg_fix_kode (trigger)            -> dijalankan di API saat impor
--       - mv_* (materialized view)          -> jadi tabel biasa, diisi ulang oleh API "refresh"
--   * Panjang VARCHAR dibuat longgar. Kalau data lama ada yang lebih panjang, impor akan error
--     dan angkanya tinggal dinaikkan.
--   * Waktu disimpan sebagai UTC (DATETIME). Konversi ke Asia/Jakarta dilakukan di API.
-- ============================================================================

CREATE DATABASE IF NOT EXISTS dashboard CHARACTER SET utf8mb4;
USE dashboard;

-- ----------------------------------------------------------------------------
--  1. TABEL DATA UTAMA
-- ----------------------------------------------------------------------------

CREATE TABLE toko (
  kode      VARCHAR(50)  NOT NULL,
  toko      VARCHAR(255),
  cab_pnl   VARCHAR(100),
  cabang    VARCHAR(100),
  bam       VARCHAR(100),
  bas       VARCHAR(100),
  bastr     VARCHAR(100),
  am        VARCHAR(100),
  `as`      VARCHAR(100),
  wilayah   VARCHAR(100),
  kriteria  VARCHAR(100),
  domain    VARCHAR(100),
  PRIMARY KEY (kode),
  KEY idx_toko_cabang (cabang)
);

CREATE TABLE item (
  plu        VARCHAR(64) NOT NULL,
  plu_jual   VARCHAR(64),
  deskripsi  VARCHAR(255),
  kirim      VARCHAR(100),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (plu),
  KEY idx_item_plu_jual (plu_jual),
  KEY idx_item_kirim (kirim)
);

CREATE TABLE stock (
  id         BIGINT NOT NULL AUTO_INCREMENT,
  tanggal    DATE NOT NULL,
  kode       VARCHAR(50) NOT NULL,
  toko       VARCHAR(255),
  plu        VARCHAR(64) NOT NULL,
  deskripsi  VARCHAR(255),
  jenis      VARCHAR(50),
  stock_qty  INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_stock_tanggal_kode_plu (tanggal, kode, plu),
  KEY idx_stock_tanggal (tanggal),
  KEY idx_stock_kode (kode),
  KEY idx_stock_plu (plu),
  KEY idx_stock_kode_tanggal (kode, tanggal)
);

CREATE TABLE stock_toko (
  id          BIGINT NOT NULL AUTO_INCREMENT,
  tanggal     DATE NOT NULL,
  kode        VARCHAR(50) NOT NULL,
  jenis       VARCHAR(50),
  stock_total INT,
  PRIMARY KEY (id),
  KEY idx_stock_toko_tanggal_kode (tanggal, kode),
  KEY idx_stock_toko_kode_tgl (kode, tanggal)
);

CREATE TABLE sales_toko (
  tanggal    DATE NOT NULL,
  kode       VARCHAR(50) NOT NULL,
  produksi   DECIMAL(24,6),
  sales_qty  INT,
  sales_rp   BIGINT,
  margin     BIGINT,
  ba_qty     INT,
  ba_rp      BIGINT,
  PRIMARY KEY (tanggal, kode),
  KEY sales_toko_kode_idx (kode)
);

CREATE TABLE sales_item (
  ket        VARCHAR(50)  NOT NULL,          -- 'closing' / 'tgl_yang_sama'
  tahun      SMALLINT     NOT NULL,
  bulan      SMALLINT     NOT NULL,
  kode       VARCHAR(50)  NOT NULL,
  deskripsi  VARCHAR(255) NOT NULL,
  produksi   DECIMAL(24,6),
  sales_qty  INT,
  margin     BIGINT,
  sales_rp   BIGINT,
  ba_qty     INT,
  ba_rp      BIGINT,
  PRIMARY KEY (ket, tahun, bulan, kode, deskripsi),
  KEY sales_item_kode_idx (kode)
);

CREATE TABLE sales_kode_ref (
  kode     VARCHAR(50) NOT NULL,
  cabang   VARCHAR(100),
  cab_pnl  VARCHAR(100),
  PRIMARY KEY (kode)
);

CREATE TABLE trend (
  id         BIGINT NOT NULL AUTO_INCREMENT,
  bulan      SMALLINT NOT NULL,
  tahun      SMALLINT NOT NULL,
  cab_pnl    VARCHAR(100),
  cabang     VARCHAR(100),
  kode       VARCHAR(50) NOT NULL,
  toko       VARCHAR(255),
  jml_hari   SMALLINT,
  sales_rp   DECIMAL(24,6),
  margin     DECIMAL(24,6),
  ba_rp      DECIMAL(24,6),
  produksi   DECIMAL(24,6),
  sales_qty  DECIMAL(24,6),
  qpd        DECIMAL(24,6),
  ba_qty     DECIMAL(24,6),
  spd        DECIMAL(24,6),
  pnl        DECIMAL(24,6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_trend_tahun_bulan_kode (tahun, bulan, kode),
  KEY idx_trend_periode (tahun, bulan),
  KEY idx_trend_kode (kode),
  KEY idx_trend_cabang (cabang)
);

CREATE TABLE modis (
  id         BIGINT NOT NULL AUTO_INCREMENT,
  kode       VARCHAR(50) NOT NULL,
  toko       VARCHAR(255),
  modis      VARCHAR(100) NOT NULL,
  kirim      VARCHAR(100),
  plu        VARCHAR(64) NOT NULL,
  plu_jual   VARCHAR(64),
  deskripsi  VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_modis_kode_modis_plu (kode, modis, plu),
  KEY idx_modis_kode (kode),
  KEY idx_modis_plu (plu),
  KEY idx_modis_plu_jual (plu_jual)
);

CREATE TABLE gempar (
  id         BIGINT NOT NULL AUTO_INCREMENT,
  tanggal    DATE NOT NULL,
  ket        VARCHAR(50) NOT NULL DEFAULT 'GEMPAR',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gempar_tanggal_ket (tanggal, ket),
  KEY idx_gempar_tanggal (tanggal)
);

CREATE TABLE budged (
  id         BIGINT NOT NULL AUTO_INCREMENT,
  cab_pnl    VARCHAR(100),
  cabang     VARCHAR(100),
  bam        VARCHAR(100),
  bulan      SMALLINT,
  tahun      SMALLINT,
  budged     DECIMAL(24,6),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_budged_periode (tahun, bulan),
  KEY idx_budged_cab_pnl (cab_pnl),
  KEY idx_budged_cabang (cabang)
);

CREATE TABLE pnl_cabang (
  id       BIGINT NOT NULL AUTO_INCREMENT,
  bln      SMALLINT NOT NULL,
  tahun    SMALLINT NOT NULL,
  cab_pnl  VARCHAR(100) NOT NULL,
  pnl      DOUBLE,
  PRIMARY KEY (id),
  UNIQUE KEY pnl_cabang_tahun_bln_cab_pnl_key (tahun, bln, cab_pnl)
);

CREATE TABLE rank_override (
  `key`      VARCHAR(190) NOT NULL,
  val        DECIMAL(24,6),
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`key`)
);

CREATE TABLE budged_override (
  `key`      VARCHAR(190) NOT NULL,
  val        DECIMAL(24,6),
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`key`)
);

-- ----------------------------------------------------------------------------
--  2. TABEL RINGKASAN (pengganti materialized view mv_*)
--     Diisi ulang oleh API "refresh": DELETE lalu INSERT ... SELECT.
--     Kolom knorm = norm(kode) (huruf besar, hanya A-Z0-9), dihitung saat refresh,
--     karena TiDB tidak punya fungsi norm() maupun index ekspresi yang bisa diandalkan.
-- ----------------------------------------------------------------------------

CREATE TABLE mv_dates (
  tanggal DATE NOT NULL,
  di      INT  NOT NULL,
  PRIMARY KEY (tanggal)
);

CREATE TABLE mv_ks (
  ki      INT NOT NULL,
  kode    VARCHAR(50) NOT NULL,
  toko    VARCHAR(255),
  cabang  VARCHAR(100),
  cabpnl  VARCHAR(100),
  PRIMARY KEY (ki),
  KEY mv_ks_kode_idx (kode)
);

CREATE TABLE mv_mon_list (
  mk    DATE NOT NULL,
  y     INT,
  b     INT,
  hari  INT,
  mi    INT NOT NULL,
  PRIMARY KEY (mi)
);

CREATE TABLE mv_mon_rows (
  kode   VARCHAR(50) NOT NULL,
  knorm  VARCHAR(50) NOT NULL,
  ds     VARCHAR(255) NOT NULL,
  mi     INT NOT NULL,
  prod   DECIMAL(24,6),
  qty    BIGINT,
  rp     DECIMAL(24,6),
  baq    BIGINT,
  barp   DECIMAL(24,6),
  KEY mv_mon_rows_norm_idx (knorm),
  KEY mv_mon_rows_kode_idx (kode)
);

CREATE TABLE mv_mon_same (
  kode   VARCHAR(50) NOT NULL,
  knorm  VARCHAR(50) NOT NULL,
  ds     VARCHAR(255) NOT NULL,
  mi     INT NOT NULL,
  prod   DECIMAL(24,6),
  qty    BIGINT,
  rp     DECIMAL(24,6),
  baq    BIGINT,
  barp   DECIMAL(24,6),
  KEY mv_mon_same_norm_idx (knorm),
  KEY mv_mon_same_kode_idx (kode)
);

CREATE TABLE mv_tgl (
  kode       VARCHAR(50) NOT NULL,
  tanggal    DATE NOT NULL,
  stock_qty  BIGINT,
  prod       DECIMAL(24,6),
  qty        BIGINT,
  rp         DECIMAL(24,6),
  mg         DECIMAL(24,6),
  baq        BIGINT,
  barp       DECIMAL(24,6),
  KEY mv_tgl_kode_tanggal_idx (kode, tanggal),
  KEY mv_tgl_tanggal_idx (tanggal)
);

CREATE TABLE mv_stock_idx (
  kode       VARCHAR(50) NOT NULL,
  deskripsi  VARCHAR(255),
  cab        VARCHAR(100),
  bas        VARCHAR(100),
  as_        VARCHAR(100),
  tk         JSON,                 -- [kode, toko, am, bastr]
  tk_key     VARCHAR(500),         -- teks dari tk, dipakai untuk mengurutkan i_tk
  jn         VARCHAR(50),
  qty        INT,
  qpd        DECIMAL(24,6),
  md         VARCHAR(100),
  i_cab INT, i_bas INT, i_as INT, i_tk INT, i_ds INT, i_jn INT, i_md INT,
  KEY mv_stock_idx_kode_idx (kode)
);

-- ----------------------------------------------------------------------------
--  3. TELEGRAM
--     (rahasia bot token / chat id pindah ke Secret Cloudflare, bukan ke tabel)
-- ----------------------------------------------------------------------------

CREATE TABLE rank_kirim_laporan (
  urut   INT NOT NULL,
  grup   VARCHAR(100),
  bam    JSON,                     -- sebelumnya text[]
  aktif  TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (urut)
);

CREATE TABLE telegram_kirim_log (
  id           BIGINT NOT NULL AUTO_INCREMENT,
  tanggal_data DATE,
  urut         INT,
  status       VARCHAR(30),
  detail       TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY telegram_kirim_log_tgl_idx (tanggal_data, urut)
);

CREATE TABLE telegram_state (
  k  VARCHAR(100) NOT NULL,
  v  JSON,
  PRIMARY KEY (k)
);

-- ----------------------------------------------------------------------------
--  4. LOGIN PER PENGGUNA (BARU) — pengganti admin_bam, admin_lihat, admin_session, admin_config
--     Password TIDAK disimpan polos. Hash dibuat di API (PBKDF2-SHA256 + salt per pengguna).
--     jabatan : ADMIN_PUSAT | ADMIN_KOORBAM | KOORBAM | BAM | BAS | BASTR
--     bam_scope: daftar BAM yang menjadi area pengguna, mis. ["BAM A","BAM B"].
--                ADMIN_PUSAT diisi NULL (semua area). Jabatan lain wajib berisi minimal satu BAM;
--                kosong berarti tidak ada data yang terlihat. Hak akses dijaga di API, bukan di sini.
-- ----------------------------------------------------------------------------

CREATE TABLE users (
  nik           VARCHAR(30)  NOT NULL,
  nama          VARCHAR(150) NOT NULL,
  jabatan       VARCHAR(50)  NOT NULL,
  bam_scope     JSON,                          -- area pengguna (NULL hanya untuk ADMIN_PUSAT)
  aktif         TINYINT(1)   NOT NULL DEFAULT 1,
  pw_hash       VARCHAR(128) NOT NULL,
  pw_salt       VARCHAR(64)  NOT NULL,
  pw_iter       INT          NOT NULL DEFAULT 100000,
  must_change   TINYINT(1)   NOT NULL DEFAULT 1,   -- 1 = wajib ganti password saat login berikutnya
  failed_count  INT          NOT NULL DEFAULT 0,
  locked_until  DATETIME NULL,
  last_login    DATETIME NULL,
  pw_changed_at DATETIME NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (nik)
);

CREATE TABLE sessions (
  token_hash  CHAR(64)    NOT NULL,           -- SHA-256 dari token; token asli hanya ada di browser
  nik         VARCHAR(30) NOT NULL,
  expires_at  DATETIME    NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (token_hash),
  KEY idx_sessions_nik (nik),
  KEY idx_sessions_exp (expires_at)
);

CREATE TABLE audit_log (                      -- jejak login / ganti / reset password
  id         BIGINT NOT NULL AUTO_INCREMENT,
  waktu      DATETIME DEFAULT CURRENT_TIMESTAMP,
  nik        VARCHAR(30),                     -- siapa yang melakukan
  aksi       VARCHAR(50),                     -- login_ok, login_gagal, ganti_pw, reset_pw, ...
  target_nik VARCHAR(30),                     -- siapa yang terkena aksi
  detail     VARCHAR(255),
  PRIMARY KEY (id),
  KEY idx_audit_waktu (waktu)
);
