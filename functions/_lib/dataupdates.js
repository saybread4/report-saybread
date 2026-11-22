// Waktu terakhir data diperbarui (untuk chip "Diperbarui ..." di header).
// Dicatat setiap kali ada impor/ubah/hapus data atau Refresh. Gagal mencatat TIDAK boleh menggagalkan operasi utamanya
// (mis. tabel data_updates belum dimigrasi).
export async function touchUpdated(db, nama) {
  try {
    await db.exec(
      'INSERT INTO data_updates (nama, updated_at) VALUES (?, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE updated_at = UTC_TIMESTAMP()', [nama]);
  } catch (e) {
    console.error('data_updates gagal dicatat', e);
  }
}

// Waktu (UTC) paling baru dari semua pencatatan, atau null.
export async function lastUpdated(db) {
  try {
    const r = await db.query('SELECT MAX(updated_at) AS u FROM data_updates');
    return (r[0] && r[0].u) || null;
  } catch (e) {
    return null;
  }
}
