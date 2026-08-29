# korea-trip 維護規則

本目錄為韓國首爾行程（2026/10/6–10/10，5 天 4 夜）的**唯一資料來源（source of truth）**。

## ⚠️ 連動更新（最重要）

以下檔案內容互相連動，**任何行程內容更新，四個檔案都必須同步修改**，不可只改其中一個：

| 檔案 | 用途 |
|------|------|
| `index.html` | Leaflet 互動地圖（marker、day 卡片、路線） |
| `itinerary.html` | 行程網頁版（完整） |
| `itinerary.md` | 行程 Markdown 版（完整） |
| `itinerary-export.txt` | 純文字精簡版（供複製到 LINE/備忘錄，**不進 git**） |

另有 `itinerary-export.md`（精簡快照版，有進 git），行程時間表變動時也一併更新。

## Git 規則

- 修改後 commit；**push 前先詢問使用者**
- `itinerary-export.txt` 不 commit（使用者指定）
- 發佈於 GitHub Pages：g4ru04.github.io/yi-shan-food-map

## 已知注意事項

- CHAAKAN 明洞旗艦店的 Google 店家頁座標被標錯在誠信女大，連結一律使用地址搜尋（명동8나길 25），勿改回 CID 連結
- AREX 直達車到仁川 **T2** 約 51 分鐘（43 分是到 T1）；本次航班使用 T2（華航 CI162/CI161）
- Google Maps 連結優先用 `https://maps.google.com/?cid=...` 格式；小店家無穩定 CID 時用 `https://www.google.com/maps/search/?api=1&query=...`
