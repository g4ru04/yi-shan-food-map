#!/usr/bin/env node
/**
 * 591 租屋:爬取 → 與 Supabase 現況合併 → 判圖 → 寫回 Supabase → Slack 通知
 *
 * 條件:台中市(8) 東區(99)+北區(102)、租金 5000-10000、坪數 11-20(不限房型、不限優選)。
 * 資料以 Supabase 為唯一來源(rent_listings 每間房一列、rent_snapshots 每次成功爬取一列),不進 git。
 *
 * Usage:
 *   node scripts/591-rent.mjs watch [--dry-run] [--full] [--no-vision] [--notify-min N]
 *       --dry-run      爬取 + 合併,但不寫 Supabase、不發 Slack(只印出結果與訊息內容)
 *       --full         已知房源的詳情也全部重抓(預設只抓新 id 的詳情)
 *       --no-vision    跳過 claude -p 判圖
 *       --notify-min N 新上架 + 消失 + 回來 ≥ N 間才發 Slack(預設 3;0 = 每次都發)
 *   node scripts/591-rent.mjs dump      從 Supabase 讀回,寫成 591-rent-house/data.json(網頁的靜態 JSON 版)
 *
 * 環境變數(排程用 scripts/591-watch.sh 從 ~/.config/591-rent/env 載入):
 *   SLACK_BOT_TOKEN / SLACK_USER_ID   Slack DM 通知(沒設就只印出)
 *   CLAUDE_BIN                        claude 執行檔(預設 PATH 上的 claude);排程環境用 CLAUDE_CODE_OAUTH_TOKEN 登入
 *   RENT591_LOG                       log 檔(由 591-watch.sh 導向;預設 591-rent-house/data/watch.log)
 *
 * 同一間房的判斷:id 相同;新 id 則與 14 天內不見的房源比對(樓層 + 地址相同,且電話 / 標題 / 聯絡人+坪數其一相同)→ 視為換 id 重刊。
 */
import https from 'node:https';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, '591-rent-house');
const DATA_DIR = path.join(PAGE, 'data'); // 本機暫存(照片、log、失敗旗標),整個 gitignore
const PHOTOS = path.join(DATA_DIR, 'photos');
const FAIL_FLAG = path.join(DATA_DIR, '.last-run-failed');
const DATA_JSON = path.join(PAGE, 'data.json');
const SITE_URL = 'https://g4ru04.github.io/yi-shan-food-map/591-rent-house/';

const QUERY = { region: '8', section: '102,99', price: '5000_10000', acreage: '11$_20$', sort: 'area_desc' };
const LIST_URL = (firstRow, sort = QUERY.sort) =>
  'https://rent.591.com.tw/list?' +
  Object.entries({ ...QUERY, sort, firstRow }).map(([k, v]) => `${k}=${v}`).join('&');
// 坪數相同的房源在 area_desc 下順序不穩,翻頁會重複/漏掉;改以多種排序取聯集直到湊滿 total
const SORTS = ['area_desc', 'posttime_desc', 'area_asc'];
// 距離基準點(同 591-rent-house/index.html 的 ORIGIN)
const ORIGIN = [24.1418, 120.6870];
const NEW_WINDOW_MS = 24 * 3600e3;   // first_seen 24h 內算「新上架」
const RELIST_WINDOW_MS = 14 * 864e5; // 換 id 重刊只跟 14 天內不見的房源比對
const MISS_LIMIT = 3;                // 詳情頁還在但連續 N 輪不在搜尋結果 → 視為消失(多半是改價/改條件)
const VISION_MAX = 20, VISION_BATCH = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => { const m = String(s ?? '').replace(/,/g, '').match(/[\d.]+/); return m ? Number(m[0]) : null; };
const has = (args, f) => args.includes(f);
const argVal = (args, f, d) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : d);
const fmtTW = (t, o = { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) =>
  new Date(t).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', ...o });
// 只印 stdout;排程時由 591-watch.sh 導向 log 檔
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

// ---------------------------------------------------------------- 591 爬取
function get(url, tries = 4) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'zh-TW' }, timeout: 20000 }, (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (b += d));
        res.on('end', () => {
          if (res.statusCode === 200) return resolve(b);
          const e = Object.assign(new Error(`HTTP ${res.statusCode} ${url}`), { status: res.statusCode });
          res.statusCode === 404 ? reject(e) : retry(e, n);
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout ' + url)));
      req.on('error', (e) => retry(e, n));
    };
    const retry = (e, n) => (n >= tries ? reject(e) : setTimeout(() => attempt(n + 1), 1500 * n));
    attempt(1);
  });
}

function getBin(url, tries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return n >= tries ? reject(new Error('HTTP ' + res.statusCode)) : setTimeout(() => attempt(n + 1), 1000); }
      const bufs = [];
      res.on('data', (d) => bufs.push(d));
      res.on('end', () => resolve(Buffer.concat(bufs)));
    }).on('error', (e) => (n >= tries ? reject(e) : setTimeout(() => attempt(n + 1), 1000)));
    attempt(1);
  });
}

async function nuxt(url) {
  const html = await get(url);
  const m = html.match(/<script>(window\.__NUXT__=.*?)<\/script>/s);
  if (!m) throw new Error('找不到 __NUXT__: ' + url);
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(m[1], ctx, { timeout: 5000 });
  return ctx.window.__NUXT__.data;
}

const findData = (data, pred) => {
  for (const v of Object.values(data)) if (v && typeof v === 'object' && v.data && pred(v.data)) return v.data;
  return null;
};

async function scrapePass(sort, items, topItems) {
  let total = null;
  for (let fr = 0; ; fr += 30) {
    const d = findData(await nuxt(LIST_URL(fr, sort)), (x) => Array.isArray(x.items) && 'total' in x);
    if (!d) throw new Error(`第 ${fr} 筆起找不到列表資料`);
    total = Number(String(d.total).replace(/,/g, ''));
    for (const it of d.items) if (!items.has(it.id) || items.get(it.id).kind_name === undefined) items.set(it.id, it);
    // topData 是置頂廣告,欄位較少且常與一般分頁重複:一般列表的完整資料優先
    for (const it of d.topData || []) if (it && it.id) topItems.set(it.id, it);
    if (!d.items.length || fr + 30 >= total) break;
    await sleep(600);
  }
  return total;
}

async function scrapeList() {
  const items = new Map(), topItems = new Map();
  let total = null;
  for (const sort of SORTS) {
    total = await scrapePass(sort, items, topItems);
    if (items.size >= total) break;
  }
  for (const [id, it] of topItems) if (!items.has(id)) items.set(id, it);
  return { items: [...items.values()], total };
}

const PHONE_RE = /0[89]\d{2}[-\s]?\d{3}[-\s]?\d{3}/g;

function parseDetail(data) {
  const d = findData(data, (x) => x.linkInfo && x.costData);
  if (!d) return null;
  const cost = Object.fromEntries((d.costData?.data || []).map((x) => [x.key, x.value]));
  const info = Object.fromEntries((d.infoData?.data || []).map((x) => [x.key, x.value]));
  const base = Object.fromEntries((d.info || []).map((x) => [x.key, x.value]));
  const gtm = d.gtm_detail_data || {};
  const remarkText = String(d.remark?.content || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const phones = new Set();
  for (const p of [d.linkInfo.mobile, d.linkInfo.phone]) if (p) phones.add(String(p).replace(/\s/g, ''));
  for (const p of remarkText.match(PHONE_RE) || []) phones.add(p.replace(/[\s]/g, ''));
  const facilities = (gtm.facility_name || '').split(',').filter(Boolean);
  return {
    address_detail: d.positionRound?.address || null,
    lat: d.positionRound?.lat ? Number(d.positionRound.lat) : null,
    lng: d.positionRound?.lng ? Number(d.positionRound.lng) : null,
    deposit: cost.deposit || d.deposit || null,
    manage_fee_text: cost.manageprice || d.rent_calculation_data?.manage_fee_text || null,
    manage_fee_amount: d.rent_calculation_data?.manage_fee ?? null,
    area_use_ping: num(info.area || base.area),
    area_right_ping: num(info.area_right),
    area_build_ping: num(info.buildArea), // 建物面積(不含公設)
    house_age: info.age || null,
    facilities,
    has_washer: facilities.includes('洗衣機'),
    has_elevator_detail: facilities.includes('電梯') || info.lift === '有',
    post_time: d.publish?.postTime || null,
    status: d.status || null,
    contact_name: d.linkInfo.name || null,
    contact_role: d.linkInfo.roleName || null,
    phones: [...phones],
    photos: (findData(data, (x) => Array.isArray(x.items) && x.items[0]?.photo)?.items || [])
      .filter((p) => p.key === 'picture' || p.photo).map((p) => p.photo).slice(0, 12),
  };
}

// 詳情頁:{ ok: 詳情 } / { gone: true }(404 或已關閉) / { error }
async function fetchDetail(id) {
  try {
    const d = parseDetail(await nuxt(`https://rent.591.com.tw/${id}`));
    if (!d || (d.status && d.status !== 'open')) return { gone: true };
    return { ok: d };
  } catch (e) {
    return e.status === 404 ? { gone: true } : { error: e.message };
  }
}

// 「此房屋在3天前發佈」等相對時間 → 絕對日期(存起來,之後每輪重算天數,不會隨時間失準)
function postDate(s, at) {
  let m;
  if (!s) return null;
  const now = new Date(at);
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
  if (/小時|分鐘/.test(s)) return day(now);
  if ((m = s.match(/(\d+)天前/))) return day(new Date(now - m[1] * 864e5));
  if ((m = s.match(/(\d+)月(\d+)日/))) {
    let d = new Date(now.getFullYear(), m[1] - 1, m[2]);
    if (d > now) d = new Date(now.getFullYear() - 1, m[1] - 1, m[2]);
    return day(d);
  }
  return null;
}

// 591 圖床要帶尺寸後綴(不帶會 404);有些網址已帶 !fit… 後綴要先去掉,影片封面(.png)不能縮,跳過
const firstPhoto = (urls) => (urls || []).find((x) => !x.includes('/video/'));
const thumbUrl = (u) => (u ? u.replace(/!.*$/, '') + '!510x400.jpg' : '');

// ---------------------------------------------------------------- 每間房的資料形狀(= rent_listings.data = data.json items[])
// list:591 列表項;det:parseDetail 結果(沿用舊列時傳 prev.detail);prev:Supabase 上的舊 data(新房源為 null)
function toItem(list, det, prev, now) {
  const tags = list.tags || [];
  const [fl, tot] = String(list.floor_name || '').split('/');
  const d = det || {};
  const mt = d.manage_fee_text;
  const manageFree = tags.includes('免管理費') || mt === '無' || /含租金/.test(mt || '');
  const price = num(list.price);
  const listPhotos = (list.photoList || []).map((u) => u.replace(/!\d+x\d+\.jpg$/, ''));
  const post = d.post_date ? new Date(d.post_date) : null;
  return {
    // 歷史欄位(由 mergeRun 設定;這裡先帶舊值)
    first_seen: prev?.first_seen ?? now, last_seen: now, seen_count: (prev?.seen_count ?? 0) + 1,
    old_ids: prev?.old_ids ?? [], price_history: prev ? [...prev.price_history] : [], gone_at: null, miss_count: 0,
    status: 'active', detail_missing: !det, // toItem 只用在「這次有出現」的房源;new/active 由 mergeRun 依 first_seen 重算
    lighting: prev?.lighting ?? 'unknown', double_bed: prev?.double_bed ?? 'unknown',
    vision_note: prev?.vision_note ?? '', has_vision: prev?.has_vision ?? false,
    // 房源欄位
    id: list.id, url: list.url || `https://rent.591.com.tw/${list.id}`, title: list.title, kind: list.kind_name,
    preferred: !!list.preferred, price,
    manage_fee: manageFree ? 0 : (d.manage_fee_amount || num(mt) || null), // 0=免/含租金內;null=未載明
    manage_fee_note: mt || null,
    area_ping: num(list.area ?? list.area_name) ?? d.area_use_ping ?? null,
    area_build: d.area_build_ping ?? null, area_right: d.area_right_ping ?? null,
    floor: fl || null, floor_total: tot || null, floor_n: num(fl),
    has_elevator: tags.includes('有電梯') || !!d.has_elevator_detail, has_washer: det ? !!d.has_washer : null,
    section: String(list.address || '').split('-')[0] || null,
    address: d.address_detail || list.address || null, lat: d.lat ?? null, lng: d.lng ?? null,
    contact: d.contact_name || list.role_name || null, contact_role: d.contact_role || null, phones: d.phones || [],
    post_time: post ? fmtTW(post, { month: 'numeric', day: 'numeric' }) : '', post_days: post ? Math.floor((new Date(now) - post) / 864e5) : null,
    refresh_time: list.refresh_time || null, facilities: d.facilities || [], tags,
    deposit: d.deposit || null, house_age: d.house_age || null,
    photo: thumbUrl(firstPhoto(listPhotos) || firstPhoto(d.photos)),
    // 換 id 重刊比對用(列表上的原始地址/聯絡人)
    match: { address: list.address || null, floor: fl || null, title: list.title, contact_listing: list.linkman || null, area_ping: num(list.area ?? list.area_name), phones: d.phones || [] },
    // 原始詳情子集:之後沿用舊列時,用它 + 新列表重新推導所有欄位
    detail: det ? { ...det, post_date: det.post_date ?? postDate(det.post_time, now), photos: (det.photos || []).slice(0, 6) } : (prev?.detail ?? null),
  };
}

// 同仲介常以同一組標題/照片/電話刊登多間不同房:非 id 的配對一律要求樓層 + 地址相同,避免把鄰居房誤判成同一間
function samePlace(a, b) {
  if (a.floor && b.floor && a.floor !== b.floor) return null;
  if (!a.address || a.address !== b.address) return null;
  const pb = new Set(b.phones || []);
  if ((a.phones || []).some((p) => pb.has(p))) return 'phone+address+floor';
  if (a.title && a.title === b.title) return 'title+address+floor';
  if (a.contact_listing && a.contact_listing === b.contact_listing && a.area_ping === b.area_ping) return 'address+contact+area+floor';
  return null;
}

// ---------------------------------------------------------------- 合併(純函式:不做 IO)
// prev:Map(id → 舊 data);scraped:這次列表項;details:Map(id → { ok } / { gone } / { error });now:ISO
// 回傳 { rows: 要寫回的 data[], deleteIds, events: { added, gone, back, relisted, price } }
function mergeRun(prev, scraped, details, now, { full = false } = {}) {
  const t = Date.parse(now);
  const out = new Map(), deleteIds = [];
  const ev = { added: [], gone: [], back: [], relisted: [], price: [] };
  const seen = new Set(scraped.map((i) => i.id));
  const det = (id) => details.get(id)?.ok || null;

  // 1. 同 id(含曾經消失又回來的)
  const fresh = [];
  for (const list of scraped) {
    const p = prev.get(list.id);
    if (!p) { fresh.push(list); continue; }
    const useDet = (full || p.detail_missing) && det(list.id) ? det(list.id) : p.detail;
    const d = toItem(list, useDet, p, now);
    if (p.price !== d.price) { d.price_history.push(d.price); ev.price.push([p, d]); }
    if (p.status === 'gone') ev.back.push(d);
    out.set(d.id, d);
  }

  // 2. 新 id:先和「這次不在列表上、14 天內還見過」的舊房源比對換 id 重刊(最近的優先,每個舊房源只配一次)
  const pool = [...prev.values()]
    .filter((p) => !seen.has(p.id) && t - Date.parse(p.last_seen) <= RELIST_WINDOW_MS)
    .sort((a, b) => b.last_seen.localeCompare(a.last_seen));
  for (const list of fresh) {
    const dd = det(list.id);
    const m = toItem(list, dd, null, now).match;
    const idx = dd ? pool.findIndex((p) => p.match && samePlace(m, p.match)) : -1;
    if (idx >= 0) {
      const [p] = pool.splice(idx, 1);
      const d = toItem(list, dd, p, now);
      d.old_ids = [...p.old_ids, p.id];
      if (p.price !== d.price) d.price_history.push(d.price);
      ev.relisted.push([p, d, samePlace(m, p.match)]);
      deleteIds.push(p.id);
      out.set(d.id, d);
    } else {
      const d = toItem(list, dd, null, now);
      d.price_history = [d.price];
      ev.added.push(d);
      out.set(d.id, d);
    }
  }

  // 3. 上次在架、這次不在列表上:詳情頁已下架 → 消失;詳情還在 → 連續 MISS_LIMIT 輪才算消失
  const relistedOld = new Set(deleteIds);
  for (const p of prev.values()) {
    if (seen.has(p.id) || relistedOld.has(p.id) || p.status === 'gone') continue;
    const r = details.get(p.id);
    const miss = (p.miss_count ?? 0) + 1;
    if (r?.gone || miss >= MISS_LIMIT) {
      const d = { ...p, status: 'gone', gone_at: now, miss_count: miss };
      ev.gone.push(d);
      out.set(d.id, d);
    } else {
      out.set(p.id, { ...p, miss_count: miss }); // 暫時漏抓/查詢失敗:先不動狀態
    }
  }

  // 4. 狀態與天數每輪重算
  for (const d of out.values()) {
    if (d.status !== 'gone') d.status = t - Date.parse(d.first_seen) < NEW_WINDOW_MS ? 'new' : 'active';
    const pd = d.detail?.post_date;
    if (pd) d.post_days = Math.floor((t - Date.parse(pd)) / 864e5);
  }
  return { rows: [...out.values()], deleteIds, events: ev };
}

// ---------------------------------------------------------------- 判圖(claude -p,只開放 Read)
const VISION_PROMPT = (ids) => `你是租屋照片判讀員。目前目錄下每個資料夾是一間房源(資料夾名 = 房源 id),裡面是 1.jpg~6.jpg。
請用 Read 工具逐張看以下房源的照片:${ids.join(', ')}
每間判斷:
- lighting:good(大窗/落地窗、自然光充足)、fair(有窗但小或偏暗、主要靠燈)、poor(無對外窗/暗房/窗對牆)、unknown(看不出)
- double_bed:yes(床寬明顯 ≥ 雙人,約 150cm+)、no(單人床)、unknown(空房無床或看不出)
- note:繁體中文一句說明依據(≤ 40 字)
看完後只輸出一個 JSON 物件,不要其他文字:{"<id>": {"lighting": "...", "double_bed": "...", "note": "..."}}`;

function runClaude(prompt, cwd) {
  const bin = process.env.CLAUDE_BIN || 'claude';
  const args = ['-p', prompt, '--allowedTools', 'Read', '--strict-mcp-config', '--no-session-persistence'];
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { cwd, timeout: 600e3, maxBuffer: 16 << 20, env: process.env }, (err, stdout, stderr) =>
      err ? reject(new Error(`claude 結束碼 ${err.code ?? err.signal}:${(String(stderr) + String(stdout)).trim().slice(-300)}`)) : resolve(stdout));
    child.stdin.end(); // 不關 stdin 的話 claude 會先空等 3 秒
  });
}

async function judgePhotos(rows) {
  const todo = rows.filter((d) => d.status !== 'gone' && !d.has_vision && d.detail?.photos?.length)
    .sort((a, b) => b.first_seen.localeCompare(a.first_seen)).slice(0, VISION_MAX);
  if (!todo.length) return 0;
  let done = 0;
  for (let k = 0; k < todo.length; k += VISION_BATCH) {
    const batch = todo.slice(k, k + VISION_BATCH);
    for (const d of batch) {
      const dir = path.join(PHOTOS, String(d.id));
      fs.mkdirSync(dir, { recursive: true });
      for (const [n, u] of d.detail.photos.filter((x) => !x.includes('/video/')).slice(0, 6).entries()) {
        const f = path.join(dir, `${n + 1}.jpg`);
        if (!fs.existsSync(f)) try { fs.writeFileSync(f, await getBin(u.replace(/!.*$/, '') + '!800x.water2.jpg')); } catch { /* 單張失敗略過 */ }
      }
    }
    try {
      const outText = await runClaude(VISION_PROMPT(batch.map((d) => d.id)), PHOTOS);
      const res = JSON.parse(outText.slice(outText.indexOf('{'), outText.lastIndexOf('}') + 1));
      for (const d of batch) {
        const r = res[d.id];
        if (!r || !['good', 'fair', 'poor', 'unknown'].includes(r.lighting) || !['yes', 'no', 'unknown'].includes(r.double_bed)) continue;
        Object.assign(d, { lighting: r.lighting, double_bed: r.double_bed, vision_note: String(r.note || '').slice(0, 80), has_vision: true });
        fs.rmSync(path.join(PHOTOS, String(d.id)), { recursive: true, force: true });
        done++;
      }
    } catch (e) {
      log(`判圖失敗(${batch.map((d) => d.id).join(',')}):${e.message}`);
    }
  }
  return done;
}

// ---------------------------------------------------------------- Supabase
// 連線設定直接讀網站的 config.js(publishable key 本來就公開),不重複寫死
function supa() {
  const cfg = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'config.js'), 'utf8');
  const pick = (k) => cfg.match(new RegExp(`${k}: *'([^']+)'`))[1];
  const url = pick('url'), key = pick('key');
  return async (method, p, body, prefer) => {
    const res = await fetch(`${url}/rest/v1/${p}`, {
      method,
      headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(prefer ? { prefer } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${p.split('?')[0]} → HTTP ${res.status} ${await res.text()}`);
    return res.status === 204 || !(res.headers.get('content-type') || '').includes('json') ? null : res.json();
  };
}

// PostgREST 預設單次最多回 1000 列,分頁讀完
async function readAll(api, table, order) {
  const rows = [];
  for (let off = 0; ; off += 1000) {
    const page = await api('GET', `${table}?select=*&order=${order}&limit=1000&offset=${off}`);
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

const lastSnapshot = async (api) => (await api('GET', 'rent_snapshots?select=*&order=scraped_at.desc&limit=1'))[0] || null;

// ---------------------------------------------------------------- Slack(DM;token 只放在本機 env 檔)
async function slackPost(text, threadTs) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) { console.log(`[slack 未設定,僅印出]${threadTs ? ' (thread)' : ''}\n${text}\n`); return null; }
  const call = async (method, body) => {
    const r = await (await fetch(`https://slack.com/api/${method}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body),
    })).json();
    if (!r.ok) throw new Error(`Slack ${method}: ${r.error}`);
    return r;
  };
  const channel = (await call('conversations.open', { users: process.env.SLACK_USER_ID || 'URQHCM761' })).channel.id;
  return (await call('chat.postMessage', { channel, text, ...(threadTs ? { thread_ts: threadTs } : {}), unfurl_links: false })).ts;
}

// thread 訊息太長時切成多則(Slack 單則上限約 4k 字)
async function slackThread(ts, title, lines) {
  let buf = title;
  for (const l of lines) {
    if (buf.length + l.length > 3500) { await slackPost(buf, ts); buf = `${title}(續)`; }
    buf += '\n' + l;
  }
  await slackPost(buf, ts);
}

function distKm(d) {
  if (!d.lat) return null;
  const r = Math.PI / 180, [a, b] = ORIGIN;
  const h = Math.sin((d.lat - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(d.lat * r) * Math.sin((d.lng - b) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
const LIGHT = { good: '採光好', fair: '採光普通', poor: '採光差', unknown: '採光?' };
const BED = { yes: '雙人床', no: '單人床', unknown: '床?' };
function slackLine(d, extra = '') {
  const km = distKm(d);
  const fee = d.manage_fee ? `+${d.manage_fee}` : '';
  return `• ${km == null ? '?' : km.toFixed(1)}km|$${d.price?.toLocaleString()}${fee}|${d.area_ping}坪|${d.floor ?? '?'}/${d.floor_total ?? '?'}|${LIGHT[d.lighting]}・${BED[d.double_bed]}${extra}\n   <${d.url}|${d.title}>`;
}
const byDist = (a, b) => (distKm(a) ?? 99) - (distKm(b) ?? 99);
const ago = (from, to) => { const h = Math.round((Date.parse(to) - Date.parse(from)) / 3600e3); return h < 48 ? `${h} 小時` : `${Math.round(h / 24)} 天`; };

async function notify(ev, active, now) {
  const head = `🏠 591 租屋變動 ${fmtTW(now)}:新上架 ${ev.added.length}、消失 ${ev.gone.length}` +
    (ev.back.length ? `、回來 ${ev.back.length}` : '') + (ev.relisted.length ? `、換 id 重刊 ${ev.relisted.length}` : '') +
    `(在架 ${active} 間)\n<${SITE_URL}|打開租屋清單>`;
  const ts = await slackPost(head);
  if (ev.added.length) await slackThread(ts, `🆕 新上架 ${ev.added.length} 間(依距離)`, [...ev.added].sort(byDist).map((d) => slackLine(d)));
  if (ev.gone.length) await slackThread(ts, `👋 消失 ${ev.gone.length} 間`, [...ev.gone].sort(byDist).map((d) => slackLine(d, `|在架 ${ago(d.first_seen, now)}`)));
  if (ev.back.length) await slackThread(ts, `🔁 回來 ${ev.back.length} 間`, [...ev.back].sort(byDist).map((d) => slackLine(d)));
}

// ---------------------------------------------------------------- 指令
async function cmdWatch(args) {
  const dry = has(args, '--dry-run'), full = has(args, '--full');
  if (dry) delete process.env.SLACK_BOT_TOKEN; // dry-run 的 Slack 訊息只印出
  const notifyMin = Number(argVal(args, '--notify-min', 3));
  const now = new Date().toISOString();
  const api = supa();
  try {
    const base = await lastSnapshot(api);
    const prev = new Map((await readAll(api, 'rent_listings', 'id')).map((r) => [r.id, r.data]));
    const { items, total } = await scrapeList();
    // 列表沒抓齊就不寫回,避免把一批房源誤標成消失
    if (!items.length || items.length < total * 0.95) throw new Error(`列表只抓到 ${items.length}/${total} 筆`);

    // 需要詳情的:新 id、上次詳情抓失敗的、--full 時全部;以及這次沒出現在列表上的在架房源(確認是否真的下架)
    const seen = new Set(items.map((i) => i.id));
    const needDetail = items.filter((i) => full || !prev.has(i.id) || prev.get(i.id).detail_missing).map((i) => i.id);
    const verify = [...prev.values()].filter((p) => p.status !== 'gone' && !seen.has(p.id)).map((p) => p.id);
    const details = new Map();
    for (const id of [...needDetail, ...verify]) { details.set(id, await fetchDetail(id)); await sleep(900); }

    const { rows, deleteIds, events } = mergeRun(prev, items, details, now, { full });
    const vision = has(args, '--no-vision') || dry ? 0 : await judgePhotos(rows);
    const active = rows.filter((d) => d.status !== 'gone').length;
    const summary = `列表 ${items.length}/${total}、詳情 ${details.size} 次 → 新上架 ${events.added.length}、消失 ${events.gone.length}、回來 ${events.back.length}、` +
      `換 id ${events.relisted.length}、改價 ${events.price.length}、判圖 ${vision}、在架 ${active}`;
    const changes = events.added.length + events.gone.length + events.back.length;

    if (dry) {
      log(`[dry-run] ${summary}`);
      for (const [p, d, w] of events.relisted) console.log(`  換 id:${p.id} → ${d.id}(${w})${d.title}`);
      await notify(events, active, now);
      return;
    }
    // 兩台電腦同時跑:開始後若別人已寫入新的一輪,這輪放棄
    if ((await lastSnapshot(api))?.scraped_at !== base?.scraped_at) throw new Error('執行期間已有其他程序寫入,這輪放棄');

    const now2 = new Date().toISOString();
    const payload = rows.map((d) => ({ id: d.id, status: d.status, first_seen: d.first_seen, last_seen: d.last_seen, data: d, updated_at: now2 }));
    for (let k = 0; k < payload.length; k += 200)
      await api('POST', 'rent_listings?on_conflict=id', payload.slice(k, k + 200), 'resolution=merge-duplicates,return=minimal');
    if (deleteIds.length) await api('DELETE', `rent_listings?id=in.(${deleteIds.join(',')})`);
    await api('POST', 'rent_snapshots', { scraped_at: now, count: items.length, total, query_url: LIST_URL(0) }, 'return=minimal');
    log(summary);

    if (fs.existsSync(FAIL_FLAG)) { fs.rmSync(FAIL_FLAG); await slackPost(`✅ 591 租屋爬取恢復正常(${fmtTW(now)})`); }
    if (changes >= notifyMin && (changes > 0 || notifyMin === 0)) await notify(events, active, now);
  } catch (e) {
    log(`失敗:${e.message}`);
    // 只在「上次成功、這次失敗」時通知一次
    if (!dry && !fs.existsSync(FAIL_FLAG)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FAIL_FLAG, now);
      await slackPost(`⚠️ 591 租屋爬取失敗(${fmtTW(now)}):${e.message}\n恢復前不再重複通知。Supabase 被暫停時到 dashboard 按 Resume;591 擋爬則等下一輪。`).catch(() => {});
    }
    process.exitCode = 1;
  }
}

async function cmdDump() {
  const api = supa();
  const items = (await readAll(api, 'rent_listings', 'id')).map((r) => r.data);
  const snapshots = (await api('GET', 'rent_snapshots?select=*&order=scraped_at.desc&limit=5')).reverse()
    .map((s) => ({ at: new Date(s.scraped_at).toISOString(), count: s.count, total: s.total }));
  fs.writeFileSync(DATA_JSON, JSON.stringify({ snapshots, items }));
  console.log(`已從 Supabase 寫出 ${path.relative(ROOT, DATA_JSON)}:${items.length} 間(在架 ${items.filter((i) => i.status !== 'gone').length})`);
}

const [cmd, ...rest] = process.argv.slice(2);
const cmds = { watch: cmdWatch, dump: cmdDump };
if (!cmds[cmd]) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*?/, ''));
  process.exit(cmd ? 1 : 0);
}
await cmds[cmd](rest);
