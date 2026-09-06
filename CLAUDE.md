# 阿珊的美食地圖 維護規則

純前端（HTML/JS）+ Leaflet + Supabase，部署於 GitHub Pages：g4ru04.github.io/yi-shan-food-map

## 🖼️ 圖片雙軌制（最重要）

圖片存在 Supabase Storage bucket `place-photos`，**每張圖必須有兩個版本**：

| 版本 | 路徑 | 規格 | 用途 |
|------|------|------|------|
| 原圖 | `<檔名>.jpg` | 最長邊 1600px、JPEG q0.82 | 詳細視窗（點擊才載入） |
| 縮圖 | `thumbs/<同檔名>.jpg` | 最長邊 480px、JPEG q0.75 | 列表、地圖 popup |

規則：

- **任何上傳圖片的功能都必須走 `uploadImage()`**（`assets/js/app.js`），它會自動同時上傳原圖與縮圖。不可繞過它只傳單一版本。
- DB 的 `image_url` 只存**原圖**網址；縮圖網址由 `thumbUrl()` 依路徑慣例推導（插入 `thumbs/`），**不要**為縮圖加 DB 欄位。
- 列表與地圖 popup 的 `<img>` 一律：縮圖 src + `loading="lazy"` + `onerror` fallback 回原圖（`data-full` 屬性）。原圖只在詳細視窗載入。
- 外部（非本站上傳的）`image_url` 沒有縮圖，靠 onerror fallback 自動退回原圖，不需特別處理。
- **移除或替換照片、刪除紀錄時**，必須用 `removeStoredImage()` 把 bucket 裡的原圖與縮圖一併刪除，避免孤兒檔案佔空間。
- 若發現 bucket 有缺縮圖的舊圖，跑 `bash scripts/generate-thumbs.sh` 補產（冪等，可重複執行）。

背景：2026-08 曾因列表直接載入 200+ 張 full-size 圖（共 136MB）導致 render 極慢，故建立此機制。

## 新增地點的兩種方式

「新增地點」頁（整頁有密碼鎖 `unlockAdd()`）由上到下是兩個 `<details>` 分區，**從側邊欄進來時兩個都收合**（`#sec-quick` / `#sec-full`）：

- **⚡ 快速登錄**：只填「時間（預設現在）＋ Google 短網址＋備註」，寫進 `pending_places` 暫存表。刻意**不**解析短網址（不呼叫 `resolveShortUrl()`），原樣存。待處理資料呈現在唯讀 textarea `#pending-board`（一行一筆 `時間 | 短網址 | 備註`，點一下全選），交給 LLM 補齊欄位寫進 `places`；處理完用「🗑️ 清空全部」（兩段確認）清掉，沒有單筆刪除。
- **➕ 一般新增**：完整欄位表單（`#place-form`），編輯地點也是走這個表單——`editPlace()` 會自動展開 `#sec-full`、收合 `#sec-quick`。

注意事項：

- `pending_places` 只是暫存，**沒有**任何欄位與 `places` 連動，也不會出現在地圖或列表。
- 小地圖 `#pick-map` 在收合區裡，展開時要 `invalidateSize()`（`initPickMap()` 已對 `#sec-full` 與 `#more-fields` 掛好 toggle）。
- 2026-09 已移除 CSV / JSON 批次匯入（含範例下載、`parseCSV`、`normalize`）；要批次寫入請直接讓 LLM 打 Supabase。

## 地圖與列表

- 地圖預設視野在 `DEFAULT_VIEW`（`app.js` 開頭，Google 網址格式 `@24.1515728,120.6461127,11.8z`）。小數 zoom 需要 `zoomSnap: 0.1`，拿掉就會被四捨五入。
- **首次載入不 fitBounds**（`firstMapRender` 旗標），才留得住預設視野；之後切篩選 / 新增刪除重畫才會自動框住所有點。
- 造訪列表依「年份 + 四季」分成 `.season-group` 收合區（春 2-4、夏 5-7、秋 8-10、冬 11-12+隔年1月，冬季算「11、12 月那一年」）。預設只展開最新那組，展開狀態記在 `openSeasons`，切篩選重畫不會被重設。

## 載入速度與儲存

- **提前發請求**：`index.html` 的 `<head>` 直接用 `fetch()` 打 `places` REST API（`window.__placesPromise`），不等 Leaflet / supabase-js 從 CDN 載完；`loadPlaces()` 會先接手這個 promise，失敗才退回 supabase-js。這段 `<script>` 必須放在 **stylesheet 之前**——等待中的 CSS 會擋住後面 script 的執行。
- **快取先畫**：上一次的資料存在 localStorage `ashan_places_cache_v1`，開頁先用快取畫地圖與列表，網路回來再覆蓋。沒有快取時顯示「讀取中…」（`#map-loading` 提示 + 列表/計數文字）。
- **名字存 localStorage**（`ashan_username`），不要改回 cookie：用 `file://` 直接開 HTML 時瀏覽器不保存 cookie，只有 localStorage 會留著。舊的 cookie 值會在 `getUserName()` 自動搬過去。

## 彈窗與 prompt

名字輸入（首次進入、點問候語改名）走頁面內的 `#name-modal`（`askName()`）；**只有密碼**還是用瀏覽器原生 `prompt()`。要再加輸入框時沿用 `askName()`，不要退回 `prompt()`。

## Git 規則

- 修改後 commit；**push 前先詢問使用者**

## 子目錄

- `korea-trip/` 有自己的 CLAUDE.md（行程檔案連動更新規則），改該目錄前先讀
