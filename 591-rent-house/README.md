# 591 + 樂屋網 租屋清單

每 5 小時爬一次 591 與樂屋網的租屋,記下每間房何時出現、何時消失,用網頁瀏覽,有明顯變動時發 Slack 通知。

- **網頁**:https://g4ru04.github.io/yi-shan-food-map/591-rent-house/(密碼同美食地圖「新增地點」頁)
- **搜尋條件**
  - 591:台中市東區 + 北區 + 中區 + 西區、租金 5,000–10,000、坪數 8–20(不限房型),寫死在 `scripts/591-rent.mjs` 的 `QUERY`(591 section id:東區 99、北區 102、中區 98、西區 101)
  - 樂屋網:同四區(zipcode 404 北、400 中、401 東、403 西)、獨立套房、租金 5,000–10,000、坪數 8–20,寫死在 `RAKUYA_LIST`(就是 https://rent.rakuya.com.tw/result?zipcode=404,400,401,403&usecode=8&price=5000~10000&size=8~20 )。樂屋整站在 Cloudflare 後面,用 playwright 開本機 Google Chrome 抓(見下方安裝)
  - 兩邊抓回來後走同一條合併 / 判圖 / 通知流程;樂屋房源的 id = 1,000,000,000 + 樂屋物件編號(591 的 id 是 8 位數,不會撞),`data.source` 標 `rakuya`,網頁有「來源」篩選與「樂屋」標籤
- **關注範圍**:距基準點 ≤ 1.5 km 且 591 刊登 ≤ 7 天(`scripts/591-rent.mjs` 的 `MAX_KM` / `MAX_POST_DAYS`)。範圍外的房源照樣爬、照樣存 Supabase,但**不發 Slack、不判圖**;網頁的「距離 ≤」「刊登 ≤」篩選預設就是這兩個值,清空即可看全部
- **資料**:只存在 Supabase,不進 git
- **照片**:每間房的照片存在跑排程那台電腦的 `591-rent-house/data/photos/<id>/`(不進 git),下架後也留著;想看已消失房源的照片跑 `node scripts/591-rent.mjs photos`

## 架構

```
          每 5 小時(launchd / cron)
                     │
          scripts/591-watch.sh ── 載入 ~/.config/591-rent/env(Slack token、claude 登入 token)、git pull 最新程式碼
                     │
      node scripts/591-rent.mjs watch
        1. 讀 Supabase 現況(rent_listings)
        2. 爬 591 列表(翻到最後一頁)+ 樂屋網列表(playwright + Chrome 翻完 32 頁);只抓新房源的詳情頁
        3. 合併:仍在 / 新上架 / 消失 / 回來 / 換 id 重刊 / 改價
        4. 把還沒存過的房源照片存到本機 data/photos/<id>/(1600px、每張 ~400KB、每間最多 12 張)
        5. 新房源照片丟給 `claude -p` 判斷採光、雙人床
        6. 寫回 Supabase(rent_listings、rent_snapshots)
        7. 新上架 + 消失 + 回來 ≥ 3 → Slack DM(摘要 + thread 列出每間)
                     │
                 Supabase ──────────► 591-rent-house/index.html(網頁直接讀,重新整理就是最新)
                     │
       node scripts/591-rent.mjs dump ──► 591-rent-house/data.json(靜態備份版,手動更新)
```

### Supabase 資料表

| 表 | 一列代表 | 主要欄位 |
|---|---|---|
| `rent_listings` | 一間房(換 id 重刊會併成同一列,以最新 id 為準) | `id`、`status`(new / active / gone)、`first_seen`、`last_seen`、`data`(jsonb,網頁要用的全部欄位) |
| `rent_snapshots` | 一次成功的爬取 | `scraped_at`、`count`(爬到幾筆)、`total`(591 頁面顯示幾筆) |

`data` 裡比較重要的欄位:

- **房源資訊**:`price`、`manage_fee`、`area_ping`(可使用坪數)、`area_build`(建物面積,不含公設)、`floor`、`has_elevator`、`has_washer`、`lat`/`lng`、`phones`、`post_date`
- **判圖結果**:`lighting`(good / fair / poor / unknown)、`double_bed`(yes / no / unknown)、`iron_window`(陽台鐵窗:yes / no / unknown;null = 還沒判,加欄位前判過的舊資料會在之後幾輪自動重判補上)、`vision_note`
- **手動標註**:`labels`(字串陣列,例如 `["行銷騙術"]`;直接改 Supabase 的 `data.labels`,爬蟲每輪沿用不覆寫,網頁顯示成橘色 badge、可用關鍵字搜尋)
- **備註**:`note`(字串;網頁每間房的「＋ 備註 / 編輯備註」按鈕編輯,存檔時重讀該列 `data` 只改 `note` 再寫回;爬蟲同 `labels` 沿用不覆寫,且寫回前會重讀一次 `note` / `labels`,避免蓋掉爬取期間在網頁上的修改)
- **歷史紀錄**:`price_history`、`old_ids`(換 id 前的舊 id)、`seen_count`、`gone_at`
- **內部用**:`detail`(詳情頁原始欄位)、`match`(換 id 比對用)

建表 SQL 在 repo 根目錄的 `schema.sql` 最後一段,RLS 與美食地圖的 `places` 相同(publishable key 可讀寫)。

### 判斷規則

- **新上架**:`first_seen` 在 24 小時內。網頁上標「24h 內新上架」。
- **消失**:上一輪還在、這一輪不在列表上時,會先打開該房源的詳情頁確認。
  - 詳情頁已下架 → 立刻標成消失。
  - 詳情頁還在 → 多半是改價或改條件,不在搜尋範圍內了;連續 3 輪(約 15 小時)都沒出現才算消失。
- **回來**:已經消失的房源,同一個 id 又出現。
- **換 id 重刊**:新 id 會跟 14 天內不見的房源比對,樓層和地址都相同,而且電話、標題、聯絡人+坪數其中一項相同,就視為同一間。網頁上標「換 id 重刊」。
- **防呆**:列表抓到的筆數少於頁面 total 的 95%,這輪就不寫回並發失敗通知,避免把一批房源誤判成消失。

## 指令

都在 repo 根目錄執行,需要 Node ≥ 18。

| 指令 | 做什麼 |
|---|---|
| `bash scripts/591-watch.sh` | 排程用的入口:載入 env 檔、`git pull --ff-only` 拉最新程式碼(拉不到就用本機版本)、防止同時跑兩份、log 寫到 `591-rent-house/data/watch.log` |
| `node scripts/591-rent.mjs watch` | 跑一輪完整流程(上面架構的 1–6) |
| `… watch --dry-run` | 只爬取與合併,不寫入、不發 Slack,印出結果和會發的訊息 |
| `… watch --notify-min 0` | 不管變動多少都發 Slack(預設門檻 3) |
| `… watch --full` | 已知房源的詳情也全部重抓(約 4 分鐘;預設只抓新房源) |
| `… watch --no-vision` | 跳過判圖 |
| `… watch --vision-max N` | 這輪最多判 N 間(預設 20;要一次補判很多間時調大,例如 `CLAUDE_BIN=$(which bridge-cli) … --vision-max 40`) |
| `node scripts/591-rent.mjs dump` | 從 Supabase 匯出成 `591-rent-house/data.json`(要 commit 才會更新網頁的靜態版) |
| `node scripts/591-rent.mjs photos` | 補抓 Supabase 上所有房源還沒存的照片,並產生 `591-rent-house/data/gallery.html`(只列已消失的;`photos all` 列全部),`open` 該檔即可瀏覽 |

### 照片存本機

- 位置:`591-rent-house/data/photos/<房源 id>/1.jpg …`(依 591 詳情頁順序,最多 12 張)+ `info.json`(標題、租金、地址等,方便離線辨識)。
- 每輪 `watch` 只抓**資料夾還不存在**的房源;下架(消失)後資料夾照留,所以已消失房源的照片都還在。
- 換 id 重刊時舊 id 的列會從 Supabase 刪掉,舊資料夾仍保留,`gallery.html` 會標成「已換 id 重刊(舊 id)」。
- 空間:每間約 2MB,2026-10-22 回補 305 間共 666MB,2026-10-24 加入中區 + 西區後 441 間共 1.1GB;之後每天新增幾間,一年約多 3–4GB。要清理就刪整個 `data/photos/`,下一輪會把在架的重抓回來(已消失的不會)。
- 判圖(`claude -p`)也是看這裡的 1.jpg~6.jpg,不再另外下載。

網頁資料來源在 `index.html`,把下面兩行的註解對調就能切換:

```js
const DATA_SOURCE = 'supabase';
// const DATA_SOURCE = 'json';
```

json 模式在本機預覽要用 http server(repo 根目錄 `make start` → http://localhost:8080/591-rent-house/)。

## 在新電腦安裝排程(每 5 小時)

**1. 準備**

- 安裝 Node ≥ 18 與 Claude Code,並 `git clone` 這個 repo。
- 確認 `node -v`、`which node`、`which claude` 都有結果。
- 樂屋網需要 **Google Chrome** 與 **playwright**:`npm i playwright` 裝在 node 從 `scripts/` 往上找得到的任一層 `node_modules`(這台 ben 的機器裝在 `/Users/ben/claude-assistant/node_modules`),不用 `npx playwright install`(用的是本機 Chrome,`channel: 'chrome'`)。
- 第一次跑(或 cookie 失效時)會開一個 Chrome 視窗過 Cloudflare 驗證,視窗移到螢幕外、跑完自動關;之後 headless 共用 `591-rent-house/data/chrome-profile/` 裡的 cookie(效期一年,不進 git)。

**2. 建立設定檔**(不進 git)

```bash
mkdir -p ~/.config/591-rent
cp 591-rent-house/env.example ~/.config/591-rent/env
chmod 600 ~/.config/591-rent/env
```

接著編輯 `~/.config/591-rent/env`:

| 變數 | 填什麼 |
|---|---|
| `PATH` | 要包含 `which node`、`which claude` 所在的資料夾 |
| `SLACK_BOT_TOKEN` | Slack bot token(`xoxb-…`,需要 `chat:write`、`im:write`);留空就不發通知 |
| `SLACK_USER_ID` | 要收 DM 的 Slack user id |
| `CLAUDE_BIN` | `which claude` 的結果 |
| `CLAUDE_CODE_OAUTH_TOKEN` | 先執行 `claude setup-token`,把產生的 token 貼進來 |

> **一定要設 `CLAUDE_CODE_OAUTH_TOKEN`**:排程環境讀不到平常的登入狀態,`claude -p` 會出現 `Failed to authenticate: OAuth session expired`,判圖就會失敗。沒判到的房源下一輪會自動補判。

**3. 手動跑一次確認**

```bash
bash scripts/591-watch.sh --notify-min 0
tail -20 591-rent-house/data/watch.log
```

應該看到一行 `列表 N/N、詳情 … → 新上架 …、判圖 …`,Slack 也會收到一則訊息。

**4. 掛上排程**(二選一)

macOS LaunchAgent(建議,每天 0:07、5:07、10:07、15:07、20:07 執行;電腦睡眠時錯過的那一輪醒來會補跑):

```bash
sed "s#__REPO__#$PWD#g" 591-rent-house/launchd.plist.example > ~/Library/LaunchAgents/tw.g4ru04.591-rent-watch.plist
launchctl load ~/Library/LaunchAgents/tw.g4ru04.591-rent-watch.plist
launchctl list | grep 591-rent          # 確認有掛上
```

- 停用:`launchctl unload ~/Library/LaunchAgents/tw.g4ru04.591-rent-watch.plist`
- 如果 repo 放在「桌面 / 文件 / 下載」底下,要到「系統設定 → 隱私權與安全性 → 完全取用磁碟」加入 `/bin/bash`,否則排程讀不到檔案。

Linux / cron(每天 0:07、5:07、10:07、15:07、20:07):

```bash
crontab -e
# 加入這一行(路徑換成 repo 的絕對路徑)
7 */5 * * * /bin/bash /path/to/yi-shan-food-map/scripts/591-watch.sh
```

**5. 只能有一台電腦掛排程。** 兩台同時寫入時,後跑的那台會偵測到並放棄那一輪,不會寫壞資料,但會浪費一次爬取。

## Slack 通知長這樣

主訊息:

```
🏠 591 租屋變動 10/17 14:07:新上架 4、消失 2、換 id 重刊 1(在架 228 間)
打開租屋清單
```

Thread 回覆(依距離排序;每則超過約 3,500 字會自動拆開):

```
🆕 新上架 4 間(依距離)
• 1.0km|$6,500+500|12.6坪|4F/7F|採光好・雙人床
   夢幻可貓💕電梯【可租補】木質

👋 消失 2 間
• 1.3km|$9,499+1000|15坪|2F/6F|採光好・床?|在架 11 小時
   台體一中✨搶先預定✨租屋補助✨陽台獨洗✨專屬女生
```

- 爬取失敗(591 擋爬、Supabase 專案被暫停等)時會發一則 ⚠️,恢復時發一則 ✅;中間不會重複通知。
- 門檻用 `watch --notify-min N` 調整。

## Claude 指令 `/auto-retrieve-rent-data`

想在 Claude Code 裡手動跑一輪並看整理過的結果時使用。正本在 `591-rent-house/claude/auto-retrieve-rent-data.md`,安裝方式是連結到個人指令資料夾:

```bash
mkdir -p ~/.claude/commands
ln -sf "$PWD/591-rent-house/claude/auto-retrieve-rent-data.md" ~/.claude/commands/auto-retrieve-rent-data.md
```

| 用法 | 做什麼 |
|---|---|
| `/auto-retrieve-rent-data` | 跑一輪(寫入 Supabase,有變動就發 Slack),然後整理新上架、消失清單 |
| `/auto-retrieve-rent-data dry` | 只看會有什麼變動,不寫入 |
| `/auto-retrieve-rent-data view` | 只打開網頁 |
| `/auto-retrieve-rent-data photos` | 補抓照片並打開已消失房源的本機相簿 `data/gallery.html` |

<details>
<summary>指令檔內容(md 長這樣)</summary>

檔案是一般 Markdown,開頭的 front matter 是指令清單上顯示的說明,內文是給 Claude 看的步驟:

```markdown
---
description: 爬 591 + 樂屋網租屋(台中東區+北區+中區+西區、5000-10000 元、8-20 坪;只通知 1.5km 內、刊登 7 天內),與 Supabase 合併、判圖、發 Slack,並回報變動
---

# Auto Retrieve Rent Data (591)

## 參數($ARGUMENTS)
- 無參數:完整執行(寫入 Supabase;有任何變動就發 Slack)
- `dry`:只爬取與合併,不寫入、不發 Slack
- `view`:不爬,只打開網頁

## 流程
1. 執行:`bash scripts/591-watch.sh --notify-min 0`(dry 時改 `node scripts/591-rent.mjs watch --dry-run`)
2. 看結果:`tail -20 591-rent-house/data/watch.log`;出現「失敗:」照實回報原因
3. 打開網頁
4. 用表格回報新上架、消失、回來、換 id 重刊、改價、判圖的數量與清單
```

完整內容請直接看 `591-rent-house/claude/auto-retrieve-rent-data.md`。
</details>

## 常見問題

| 狀況 | 處理 |
|---|---|
| log 出現 `fetch failed`、DNS 錯誤 | Supabase 免費專案閒置會被暫停,到 Supabase dashboard 按 Resume |
| `列表只抓到 x/y 筆` | 591 列表翻頁不穩或暫時擋爬,下一輪通常就恢復 |
| `判圖失敗 … Failed to authenticate` | env 檔沒設或設錯 `CLAUDE_CODE_OAUTH_TOKEN`,重跑 `claude setup-token` |
| `判圖失敗 … ENOENT` | `CLAUDE_BIN` 路徑錯誤 |
| `執行期間已有其他程序寫入` | 兩台電腦都在跑排程,停掉其中一台 |
| 想改搜尋條件 | 改 `scripts/591-rent.mjs` 的 `QUERY`(591)/ `RAKUYA_LIST`(樂屋);縮小條件時舊資料會產生大量「消失」,建議先清空兩張表(放寬條件不會) |
| `樂屋網 Cloudflare 擋住` | 刪掉 `591-rent-house/data/chrome-profile/` 重跑(會再開一次有視窗的 Chrome 拿 cookie);還是不行就是樂屋改了防護,先把 `rakuyaList()` 那行暫時拿掉只跑 591 |
| `Cannot find package 'playwright'` | 跑排程那台沒裝 playwright,見「在新電腦安裝排程」 |
| `樂屋第 N 頁找不到列表資料` / 詳情全部 gone | 樂屋改版(列表 `section.search-obj`、詳情 `window.itemInfo` 等結構變了),對照 `rakuyaList` / `rakuyaDetail` 的選擇器修 |
| 想改關注範圍(距離 / 刊登天數) | 改 `scripts/591-rent.mjs` 的 `MAX_KM` / `MAX_POST_DAYS`,以及 `591-rent-house/index.html` 篩選欄 `#dmax` / `#pdmax` 的 `value` |
| 想改執行頻率 | 改 `launchd.plist.example` 的 `StartCalendarInterval`(或 crontab 那一行)後重新安裝;24 不能被 5 整除,所以 20:07 到隔天 0:07 只隔 4 小時 |
| 想改距離基準點 | 改 `591-rent-house/index.html` 和 `scripts/591-rent.mjs` 兩處的 `ORIGIN` |
