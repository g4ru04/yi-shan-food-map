---
description: 爬 591 租屋(台中東區+北區、5000-10000 元、11-20 坪),與 Supabase 合併、判圖、發 Slack,並回報變動
---

# Auto Retrieve Rent Data (591)

手動跑一次和每小時排程相同的流程(`scripts/591-rent.mjs watch`),並把結果整理給使用者。
正本在 repo `591-rent-house/claude/auto-retrieve-rent-data.md`;`~/.claude/commands/` 底下是它的 symlink / 複本。

- Repo:`yi-shan-food-map`(下列指令都在 repo 根目錄執行;這台電腦是 `/Users/mac-ben/claude-assistant/yi-shan-food-map`)
- 網頁:https://g4ru04.github.io/yi-shan-food-map/591-rent-house/(密碼同美食地圖新增頁)
- 資料:只存在 Supabase(`rent_listings` 每間房一列、`rent_snapshots` 每次成功爬取一列),不進 git
- 詳細說明:`591-rent-house/README.md`

## 參數($ARGUMENTS)

- 無參數:完整執行(寫入 Supabase;有任何變動就發 Slack)
- `dry`:只爬取與合併,不寫入、不發 Slack,印出會發的訊息
- `view`:不爬,只打開網頁

## 流程

1. **執行**(`view` 時跳過)。用 Bash `run_in_background` 跑,等完成通知,不要輪詢:

   ```bash
   bash scripts/591-watch.sh --notify-min 0        # 無參數
   node scripts/591-rent.mjs watch --dry-run       # dry
   ```

   - `591-watch.sh` 會載入 `~/.config/591-rent/env`(Slack token、claude 路徑),log 寫在 `591-rent-house/data/watch.log`。
   - 約 1 分鐘;有新房源時會用 `claude -p` 判圖,每 5 間多約 1–2 分鐘。

2. **看結果**:`tail -20 591-rent-house/data/watch.log`。
   - 成功時有一行摘要:`列表 N/M、詳情 K 次 → 新上架 …、消失 …、回來 …、換 id …、改價 …、判圖 …、在架 …`。
   - 出現「失敗:」就照實回報原因,不要假裝成功:
     - DNS 失敗或連不上 Supabase → 專案被暫停,請使用者到 Supabase dashboard 按 Resume。
     - `列表只抓到 x/y 筆` → 591 列表不穩或擋爬,等下一輪。
     - `已有其他程序寫入` → 另一台電腦的排程剛跑完,這輪放棄是正常的。
   - 出現「判圖失敗」→ 檢查 env 檔的 `CLAUDE_BIN` 與 `CLAUDE_CODE_OAUTH_TOKEN`;沒判到的房源下一輪會自動補判。

3. **打開網頁**:`open "https://g4ru04.github.io/yi-shan-food-map/591-rent-house/"`。

4. **回報**:用 Markdown table 列出新上架、消失、回來、換 id 重刊、改價、判圖的數量。新上架 ≤ 10 間時逐一列出(標題、租金、坪數、距離、採光、雙人床、連結),資料從 Supabase 讀:

   ```bash
   node scripts/591-rent.mjs dump   # 會覆寫 591-rent-house/data.json;只是要看資料的話,看完用 git checkout 還原
   ```

   或直接請使用者看 Slack thread。

## 注意

- 不要 commit 任何資料檔;`591-rent-house/data/` 整個被 gitignore。
- 想更新網頁的靜態 JSON 備份版時才跑 `dump` 並 commit `591-rent-house/data.json`;push 前先詢問使用者(repo 規則)。
- 排程在另一台電腦上跑時,手動執行可能和排程撞期:腳本偵測到就會放棄這輪,不會重複寫入。
