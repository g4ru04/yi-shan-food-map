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

## Instagram 貼文解析方式

使用者常丟 IG 貼文連結要求整理旅遊資訊。IG 擋一般抓取，解析方法：

1. 直接 WebFetch `https://www.instagram.com/p/<shortcode>/` → 幾乎必被擋
2. 改抓 **embed 變體**：`https://www.instagram.com/p/<shortcode>/embed/captioned/` → 通常能拿到完整 caption（不需登入），14/14 篇實測成功
3. `instagram.com/direct/t/...` 是**私訊對話串，任何工具都讀不到**，直接請使用者貼文字內容
4. 多篇貼文時委派 general-purpose agent 批次處理；caption 讀不到就如實回報，**不可捏造內容**
5. 貼文資訊寫入行程前，位置/店名矛盾的（如帳號說明洞但店名寫신당）先跳過或查證，勿直接採用

## 已知注意事項

- CHAAKAN 明洞旗艦店的 Google 店家頁座標被標錯在誠信女大，連結一律使用地址搜尋（명동8나길 25），勿改回 CID 連結
- AREX 直達車到仁川 **T2** 約 51 分鐘（43 分是到 T1）；本次航班使用 T2（華航 CI162/CI161）
- Google Maps 連結優先用 `https://maps.google.com/?cid=...` 格式；小店家無穩定 CID 時用 `https://www.google.com/maps/search/?api=1&query=...`
