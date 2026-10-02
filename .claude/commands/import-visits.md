---
description: 解析貼上的造訪紀錄（時間、Google Maps 名稱、可選連結），查證後寫入 Supabase `places`（寫入前需使用者確認）
argument-hint: 貼上多行「YYYY/M/D HH:MM 名稱 [Google Maps 連結]」
allowed-tools: Bash(curl:*), WebSearch, WebFetch
---

# import-visits — 匯入造訪紀錄到 yi-shan-food-map

使用者輸入（$ARGUMENTS）是一段文字，每行一筆造訪紀錄。你的任務是查證並把它們寫進 Supabase 的 `places` 資料表。**在拿到使用者明確確認前，絕對不可以呼叫任何會寫入資料的 curl（POST/PATCH）。**

## 0. 常數（先核對再用）

```
SUPABASE_URL=https://gylxgpqdbhbuoxaxbazb.supabase.co
SUPABASE_KEY=sb_publishable_3bpRJx_gbvhNNMWM5TlpAg_qss7NmHl
TABLE=places
```

執行前先 Read `assets/js/config.js`（相對於本專案根目錄），確認 `url`/`key`/`table` 與上面一致。若不一致，停下來告知使用者 config 已經變更，不要用舊值硬寫。

## 1. 解析輸入

每一行的格式（可能有多筆，換行分隔）：

```
YYYY/M/D HH:MM <Google Maps 名稱> [https://...（可選）]
```

用這個邏輯解析每行：
- 開頭抓日期時間：`YYYY/M/D HH:MM`
- 若行尾是一個 `http(s)://` 開頭的 URL，取出當作 Google Maps 連結，其餘（去頭去尾空白）就是名稱
- 若行尾不是 URL，整段（去頭去尾空白）就是名稱，沒有連結

日期時間 → `visited_at`，格式為本地時間 `YYYY-MM-DDTHH:MM:00`（**不要加時區後綴**，跟現有手動輸入的資料保持一致）。

任何一行解析失敗（抓不到日期時間或名稱），不要默默跳過——保留在結果裡標記「⚠ 解析失敗」，稍後在 preview 表格中列出來讓使用者處理。

## 2. 詢問 author（整批共用一次）

在開始查證前，先問使用者：「這批資料的 `author`（建立者）要填什麼名字？（可留空）」，套用到這批所有記錄。不要用猜的名字，也不要引用 cookie/使用者名稱之類的假設值。

## 3. 逐行查證（WebSearch / WebFetch，沒有任何 Google API key，不要假設有）

對每一行分兩種情況處理：

### (a) 有給 Google Maps 連結
連結本身就已經指定了唯一地點，**不需要再做名稱唯一性判斷**。用 `WebFetch` 開這個連結，盡量取得：
- 精確座標（lat/lon）
- Google 星等（`google_rating`）
- 地點類型 / 分類

設定：
- `google_url` = 使用者給的原始連結（若 WebFetch 過程中拿到更精確的 `place_id:` 或含座標的完整網址，可以用那個取代，但保留原連結作為備援）
- `google_rating` = 查到的星等

若 WebFetch 因短網址/反爬蟲拿不到內容，改用 `WebSearch` 這個名稱補查座標與星等，並在備註標記「⚠ 連結內容無法直接讀取，改用搜尋結果」。

### (b) 沒有給連結
用 `WebSearch` 查這個名稱（可搭配關鍵字如城市、看得出來的地區名一起查，若日期附近的其他地點透露城市/地區，可以拿來輔助判斷但不要覆蓋掉名稱本身）。判斷：

- **這個名稱在 Google Maps 上是否唯一**（不是同名的連鎖分店、不是撞名的不同地方）？
  - 若確認唯一 → 填入 `google_url`（優先用查到的地圖連結；查不到明確連結就用 `https://www.google.com/maps/search/?api=1&query=<urlencode 名稱>`）與 `google_rating`（查到的星等）。
  - 若不確定唯一（例如搜尋結果顯示多個不同地點都叫這個名字，且沒有其他資訊可以判斷是哪一間）→ `google_url` 與 `google_rating` **留空**，並在備註標記「⚠ 名稱非唯一，google 欄位留空」。

### 兩種情況都要判斷

- **`category`**：簡短中文分類（參考 `assets/js/app.js` 裡 `SAMPLE` 常數的風格，例如「麵食」「景點」「咖啡廳」「燒肉」「機場」「賣場」等），依查到的 Google Maps 類型判斷。
- **`is_restaurant`**：明顯不是餐飲場所（商場、公園、機場航廈、超市、飯店…）設 `false`；其餘（餐廳、小吃、咖啡廳、酒吧等）設 `true`。
- **`is_closed`**：只有查到明確標示「永久停業 / Permanently closed」才設 `true`，否則 `false`。
- **座標（lat/lon）**：用查證中能取得的最佳證據（實際地圖 pin、座標字串）。如果只能查到大概區域（沒有精確 pin），仍填入最佳估計座標，但在備註標記「⚠ 座標為概略估計」。
- **一律留空、不可用猜的欄位**：`image_url`、`rating`（自己星等）、`review`。

## 4. Preview 表格（寫入前的硬性關卡）

用 Markdown 表格列出每一筆（包含解析失敗的），欄位：

```
# | 名稱 | visited_at | 座標 (lat,lon) | 分類 | is_restaurant | is_closed | google_rating | google_url | ⚠ 備註
```

表格後面明確寫：

> 以上 N 筆準備寫入正式的 `places` 資料表，目前**還沒有寫入任何東西**。請回覆「confirm」以全部寫入，或告訉我要修改/排除哪幾筆。

**在使用者於下一輪對話明確回覆確認之前，不要呼叫任何 POST/PATCH 到 Supabase。** 這不是形式上的提醒，是硬性規則。

## 5. 寫入（只有在使用者確認後才執行）

把確認後的資料整理成 JSON 陣列，寫到暫存檔（避免中文/引號在 shell 裡逃逸出問題），例如：

```bash
cat > /tmp/import_visits_payload.json <<'JSON'
[
  {"name": "...", "lat": 25.0, "lon": 121.5, "review": null, "rating": null,
   "google_rating": 4.2, "google_url": "https://...", "author": "...",
   "image_url": null, "visited_at": "2026-06-19T19:10:00",
   "category": "麵食", "is_restaurant": true, "is_closed": false}
]
JSON
```

然後：

```bash
curl -sS -X POST "$SUPABASE_URL/rest/v1/$TABLE" \
  -H "apikey: $SUPABASE_KEY" \
  -H "Authorization: Bearer $SUPABASE_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  --data-binary @/tmp/import_visits_payload.json
```

## 6. 回報

列出成功寫入的每一筆的 `id`（來自 `return=representation` 的回應）。如果回應不是 2xx，把錯誤內容原文顯示給使用者，不要吞掉或美化錯誤訊息。
