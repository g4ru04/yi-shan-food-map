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

## 安裝步驟

### 1. 建立資料表
到 [Supabase](https://supabase.com) 專案 → **SQL Editor** → 貼上 [`schema.sql`](./schema.sql) 全部內容 → **Run**。

### 2. 設定金鑰
編輯 [`assets/js/config.js`](./assets/js/config.js)，填入你自己的 Project URL 與 publishable（anon）key。
> 這把 key 本來就是公開用的，可以安全 commit。**service_role key 絕對不要放這裡。**

### 3. 本機預覽
因為用到 fetch，需要透過 http server 開啟（不能直接雙擊 html）：
```bash
python3 -m http.server 8000
# 開 http://localhost:8000
```

### 4. 部署到 GitHub Pages
1. 推上 GitHub。
2. Repo → **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。
3. 之後每次 push 到 `main`，[`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) 會自動部署。
4. 網址會是 `https://<帳號>.github.io/<repo 名>/`。

---

## ⚠️ 關於安全性

`schema.sql` 預設開放匿名金鑰可「讀 + 寫 + 改 + 刪」，方便你和朋友共用。
缺點是**任何拿到網址的人都能修改資料**。

若想「**所有人可看、只有你能改**」，把 `schema.sql` 中的 insert / update / delete policy 刪掉，改成只保留 `public read`，並改用 Supabase Auth 登入後才開放寫入。詳見 [Supabase RLS 文件](https://supabase.com/docs/guides/database/postgres/row-level-security)。

---

## 技術

- [Leaflet](https://leafletjs.com/) + OpenStreetMap（地圖，免費、免 API key）
- [Supabase](https://supabase.com/)（PostgreSQL + 自動 REST API）
- 原生 HTML / CSS / JS，無打包工具
