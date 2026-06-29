PORT ?= 8080

.PHONY: init start browser

## 檢查必要工具
init:
	@command -v python3 >/dev/null 2>&1 || { echo "需要 python3，請先安裝"; exit 1; }
	@echo "✓ python3 已就緒，無需額外安裝"

## 啟動本地伺服器
start:
	@echo "啟動 http://localhost:$(PORT)"
	python3 -m http.server $(PORT)

## 用瀏覽器開啟頁面
browser:
	open http://localhost:$(PORT)
