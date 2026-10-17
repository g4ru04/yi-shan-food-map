#!/bin/bash
# 591 租屋排程入口(每 5 小時,由 launchd / cron 呼叫)。用法見 591-rent-house/README.md
# 載入 ~/.config/591-rent/env(Slack token、PATH 等,不進 git)→ 跑 watch;同一台電腦同時只跑一份。
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${RENT591_ENV:-$HOME/.config/591-rent/env}"
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a

LOG="${RENT591_LOG:-$REPO/591-rent-house/data/watch.log}"
LOCK="${TMPDIR:-/tmp}/591-rent-watch.lock"
mkdir -p "$(dirname "$LOG")"

# 上一輪還在跑就跳過;lock 超過 2 小時視為殘留(當機/重開機),強制清掉
if [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +120 2>/dev/null)" ]; then rmdir "$LOCK"; fi
if ! mkdir "$LOCK" 2>/dev/null; then echo "$(date '+%F %T') 上一輪尚未結束,跳過" >> "$LOG"; exit 0; fi
trap 'rmdir "$LOCK"' EXIT

cd "$REPO" || exit 1
node scripts/591-rent.mjs watch "$@" >> "$LOG" 2>&1
