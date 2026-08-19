// ============================================================
//  Supabase 連線設定
//  這裡放的是「publishable / anon」金鑰，本來就是設計成公開的，
//  可以安全地 commit 到 GitHub。真正機密的 service_role 金鑰永遠不要放這。
// ============================================================
window.SUPABASE_CONFIG = {
  url: 'https://gylxgpqdbhbuoxaxbazb.supabase.co',
  key: 'sb_publishable_3bpRJx_gbvhNNMWM5TlpAg_qss7NmHl',
  table: 'places',
  pendingTable: 'pending_places',   // 快速登錄暫存表（時間 + 短網址 + 備註）
  bucket: 'place-photos',   // Supabase Storage bucket（放照片）
  queueTable: 'pending_url_queue',   // 短網址解析失敗待處理佇列
};
