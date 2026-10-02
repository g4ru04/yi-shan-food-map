---
description: 從指定的本機照片資料夾，比對 Supabase `places` 中還沒有 image_url 的地點（依造訪時間 ±2hr + GPS 距離），選出代表照片並上傳（寫入前需使用者確認）
argument-hint: [照片資料夾路徑]（省略則詢問）
allowed-tools: Bash(curl:*), Bash(mdfind:*), Bash(mdls:*), Bash(xargs:*), Bash(sips:*), Bash(python3:*), Bash(ls:*), Bash(tr:*), Read
---

# backfill-photos — 從本機照片補上代表圖片

任務：從使用者指定的照片資料夾裡，找出跟 Supabase `places` 資料表中「還沒有代表圖片」的地點時間/地點相符的照片，選出最合適的一張，上傳並更新該筆記錄。**在拿到使用者明確確認前，絕對不可以上傳照片或 PATCH 資料庫。**

## 0. 常數

```
SUPABASE_URL=https://gylxgpqdbhbuoxaxbazb.supabase.co
SUPABASE_KEY=sb_publishable_3bpRJx_gbvhNNMWM5TlpAg_qss7NmHl
TABLE=places
BUCKET=place-photos
```

執行前先 Read `assets/js/config.js` 核對這些值一致，不一致就停下來提醒使用者。

## 1. 解析資料夾路徑

`$ARGUMENTS` 是照片資料夾路徑。若沒給，詢問使用者路徑。用 `ls -d "$FOLDER"` 確認資料夾存在，不存在就停止並告知。

## 2. 查詢待補地點

```bash
curl -sS "$SUPABASE_URL/rest/v1/$TABLE?select=id,name,lat,lon,visited_at,category&image_url=is.null&visited_at=not.is.null" \
  -H "apikey: $SUPABASE_KEY" \
  -H "Authorization: Bearer $SUPABASE_KEY" \
  > /tmp/places_needing_photos.json
```

若結果是空陣列，回報「目前沒有缺代表圖片的地點」並結束，不要繼續往下跑。

## 3. 一次性批次取得照片 metadata（絕對不要逐檔迴圈呼叫 mdls，那樣幾百張就會 timeout）

1. 用 python3 讀 `/tmp/places_needing_photos.json`，算出所有 `visited_at` 的最小值 -2 小時、最大值 +2 小時，當作日期範圍 `MIN_TIME` / `MAX_TIME`（ISO 格式，UTC）。

2. 一次 `mdfind` 取得候選照片清單（這一步在全資料夾 23000+ 張規模下實測約 1 秒內完成，不用擔心效能）：

   ```bash
   mdfind -onlyin "$FOLDER" \
     "kMDItemContentCreationDate >= \$time.iso($MIN_TIME) && kMDItemContentCreationDate <= \$time.iso($MAX_TIME)" \
     > /tmp/candidate_photos.txt
   ```

   若候選清單是空的，回報所有地點都「無候選照片」並結束。

3. 一次批次 `mdls` 取得每張候選照片的建立時間/檔名/GPS：

   ```bash
   tr '\n' '\0' < /tmp/candidate_photos.txt | \
     xargs -0 mdls -name kMDItemContentCreationDate -name kMDItemDisplayName \
                   -name kMDItemLatitude -name kMDItemLongitude \
     > /tmp/candidate_mdls_raw.txt
   ```

   **重要**：`mdls` 給多個 `-name` 時，每個檔案的輸出是依「屬性名稱字母順序」排列，不是你下參數的順序。上面四個屬性字母順序剛好是 `kMDItemContentCreationDate` → `kMDItemDisplayName` → `kMDItemLatitude` → `kMDItemLongitude`，所以每個檔案固定輸出 4 行，且各檔案的區塊順序跟 `/tmp/candidate_photos.txt` 裡的檔案順序一致。解析時要照這個固定順序切。

4. 寫一個 python3 腳本（寫到暫存檔再執行，不要在 shell 裡手刻複雜解析）：
   - 把 `/tmp/candidate_photos.txt`（路徑，依序）跟 `/tmp/candidate_mdls_raw.txt`（每 4 行一筆，同樣的順序）對應起來，組成 `[{path, created_at, lat, lon}]`（`(null)` 就存 `None`）。
   - 讀 `/tmp/places_needing_photos.json`。
   - 對每個地點：候選 = 建立時間與 `visited_at` 相差 ≤2 小時的照片。
     - 若候選中有帶 GPS 的，用 haversine 公式算與地點 `(lat, lon)` 的距離，用 300 公尺為門檻篩選；如果 300 公尺內沒有，放寬到 1.5 公里；依距離排序，最多留 5 張。
     - 若候選都沒有 GPS，退回純用時間差排序，最多留 5 張。
   - 輸出一個 JSON：`{place_id: [{path, created_at, distance_m 或 null, time_diff_min}, ...]}`，寫到 `/tmp/place_photo_candidates.json`。

## 4. 視覺判斷（候選 ≥2 張才需要跑這步）

對每個有 ≥2 張候選的地點，最多看前 5 張：
- 若副檔名是 `.HEIC`/`.heic`，先轉成可預覽的 JPEG（Read 工具不保證能讀 HEIC）：
  ```bash
  sips -s format jpeg "<原始路徑>" --out "/tmp/preview_<place_id>_<n>.jpg"
  ```
- 用 `Read` 工具逐一查看轉出來的 JPEG（或原本就是 JPEG/JPG 的就直接讀原檔），依序判斷並挑選：
  1. 雙人合照（兩個人或以上、看起來像同行的人）優先
  2. 食物合拍優先
  3. 都沒有明顯符合的，選時間最接近（其次距離最近）的那張
- 若某張檔案 Read 失敗（讀不到），直接排除，不要用猜的。

候選只有 1 張的地點跳過這步，直接用那張。候選 0 張的標記「未找到候選照片」。

## 5. Preview 表格（寫入前的硬性關卡）

用 Markdown 表格列出每個待補地點：

```
place_id | 名稱 | visited_at | 選中照片檔名 | 挑選原因（雙人合照／美食合拍／時間最近／GPS最近） | 或「無候選照片」
```

表格後明確寫：

> 以上還沒有上傳任何照片、也沒有更新資料庫。請回覆「confirm」以上傳並套用以上全部配對，或告訴我要排除哪些 place_id。

**在使用者明確回覆確認前，不要執行任何上傳（POST storage）或 PATCH。**

## 6. 上傳 + 更新（只有在使用者確認後，對每個確認要處理的地點）

一律轉成 JPEG 再上傳（原站台用 `<img>` 直接渲染 `image_url`，HEIC 在多數瀏覽器不會顯示，所以即使原檔是 JPEG 也統一走 `sips` 正規化一次是安全的；已經是 JPEG 的可以直接用原檔跳過轉檔），檔名固定用 `${place_id}.jpg`：

```bash
curl -sS -X POST "$SUPABASE_URL/storage/v1/object/$BUCKET/${PLACE_ID}.jpg" \
  -H "apikey: $SUPABASE_KEY" \
  -H "Authorization: Bearer $SUPABASE_KEY" \
  -H "Content-Type: image/jpeg" \
  --data-binary @"$SRC"

curl -sS -X PATCH "$SUPABASE_URL/rest/v1/$TABLE?id=eq.${PLACE_ID}" \
  -H "apikey: $SUPABASE_KEY" \
  -H "Authorization: Bearer $SUPABASE_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d "{\"image_url\": \"$SUPABASE_URL/storage/v1/object/public/$BUCKET/${PLACE_ID}.jpg\"}"
```

## 7. 回報

每個地點：成功補圖（附上挑選的原始檔名與理由）或未找到候選照片。任何 HTTP 非 2xx 回應原文顯示，不要吞掉。
