# 🍜 阿珊的美食地圖

記錄去過的美食地點，並在地圖上一覽無遺。純前端（HTML + JS）+ Leaflet 地圖 + Supabase 資料庫，可直接部署到 GitHub Pages，**不需要後端伺服器**。

## 功能

- **🗺️ 地圖**：所有地點以標記呈現，點標記看摘要 → 「看詳細」可看完整評價並一鍵跳到 Google Maps。
- **📋 列表**：依建立時間（新 → 舊）列出所有地點，可看詳細、開 Google、刪除。
- **➕ 新增 / 匯入**：表單新增（可點小地圖選座標）、批次匯入 CSV / JSON，並提供範例檔下載。

### 資料欄位

| 欄位 | 說明 |
|------|------|
| `id` | 自增 id |
| `created_at` | 建立時間 |
| `lat` / `lon` | 緯度 / 經度 |
| `name` | 店家名稱 |
| `review` | 文字評價（500 字內）|
| `rating` | 我的星等 0~5 |
| `google_rating` | Google 星等 1~5 |
| `google_url` | Google 連結或 place_id（留空則用座標定位）|

---

## 使用說明

### 使用者名字
第一次開啟會詢問名字並存進 cookie（一年），之後右上角顯示「Hi, 名字」，點一下可改名。

---

## 技術

- [Leaflet](https://leafletjs.com/) + OpenStreetMap（地圖，免費、免 API key）
- [Supabase](https://supabase.com/)（PostgreSQL + 自動 REST API）
- 原生 HTML / CSS / JS，無打包工具
