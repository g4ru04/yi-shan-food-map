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
- 批次匯入的外部 `image_url` 沒有縮圖，靠 onerror fallback 自動退回原圖，不需特別處理。
- **移除或替換照片、刪除紀錄時**，必須用 `removeStoredImage()` 把 bucket 裡的原圖與縮圖一併刪除，避免孤兒檔案佔空間。
- 若發現 bucket 有缺縮圖的舊圖，跑 `bash scripts/generate-thumbs.sh` 補產（冪等，可重複執行）。

背景：2026-08 曾因列表直接載入 200+ 張 full-size 圖（共 136MB）導致 render 極慢，故建立此機制。

## Git 規則

- 修改後 commit；**push 前先詢問使用者**

## 子目錄

- `korea-trip/` 有自己的 CLAUDE.md（行程檔案連動更新規則），改該目錄前先讀
