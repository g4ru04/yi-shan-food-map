#!/usr/bin/env bash
# ============================================================
#  為 Supabase Storage 現有圖片補產縮圖（thumbs/ 路徑）
#  - macOS 原生工具（curl + sips），無需安裝套件
#  - 冪等：已有縮圖的檔案自動跳過，可重複執行
#  用法：bash scripts/generate-thumbs.sh
# ============================================================
set -euo pipefail

SUPABASE_URL="https://gylxgpqdbhbuoxaxbazb.supabase.co"
KEY="sb_publishable_3bpRJx_gbvhNNMWM5TlpAg_qss7NmHl"
BUCKET="place-photos"
MAX_DIM=480
QUALITY=75

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

list_names() {  # $1 = prefix
  curl -sf -X POST "$SUPABASE_URL/storage/v1/object/list/$BUCKET" \
    -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -d "{\"prefix\":\"$1\",\"limit\":1000,\"sortBy\":{\"column\":\"name\",\"order\":\"asc\"}}" \
  | python3 -c "import json,sys;[print(f['name']) for f in json.load(sys.stdin) if f.get('metadata')]"
}

echo "列出 bucket 檔案中…"
list_names "" > "$TMP/all.txt"
list_names "thumbs/" > "$TMP/thumbs.txt" || true

ok=0; skip=0; fail=0
while IFS= read -r name; do
  # 跳過非圖片與已有縮圖的
  case "$name" in *.jpg|*.jpeg|*.png|*.webp) ;; *) continue ;; esac
  if grep -qxF "$name" "$TMP/thumbs.txt"; then
    skip=$((skip+1)); continue
  fi

  src="$TMP/src"; out="$TMP/thumb.jpg"
  if ! curl -sf "$SUPABASE_URL/storage/v1/object/public/$BUCKET/$name" -o "$src"; then
    echo "✗ 下載失敗：$name"; fail=$((fail+1)); continue
  fi
  if ! sips -Z $MAX_DIM -s format jpeg -s formatOptions $QUALITY "$src" --out "$out" >/dev/null 2>&1; then
    echo "✗ 縮圖失敗：$name"; fail=$((fail+1)); continue
  fi
  if curl -sf -X POST "$SUPABASE_URL/storage/v1/object/$BUCKET/thumbs/$name" \
      -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
      -H "Content-Type: image/jpeg" -H "cache-control: max-age=3600" \
      --data-binary "@$out" >/dev/null; then
    ok=$((ok+1)); echo "✓ $name ($(du -k "$out" | cut -f1) KB)"
  else
    echo "✗ 上傳失敗：$name"; fail=$((fail+1))
  fi
done < "$TMP/all.txt"

echo "------------------------------------------"
echo "完成：成功 ${ok}、跳過(已存在) ${skip}、失敗 ${fail}"
