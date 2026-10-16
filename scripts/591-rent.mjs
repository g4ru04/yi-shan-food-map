#!/usr/bin/env node
/**
 * 591 租屋爬取 + 快照比對
 *
 * 條件:台中市(8) 東區(99)+北區(102)、租金 5000-10000、坪數 11-20(不限房型、不限優選,
 * 優選與否記在 preferred 欄位)。
 *
 * Usage:
 *   node scripts/591-rent.mjs scrape [--no-detail] [--limit N]   翻到最後一頁並抓詳情,存快照後自動 diff
 *   node scripts/591-rent.mjs diff [舊快照檔 新快照檔]            預設比對最新兩份快照
 *   node scripts/591-rent.mjs images [--all] [--download [--max N]]   列出尚未做圖片判斷(採光/雙人床)的房源;--download 把照片存到 photos/ 並切批次到 vision-batches/<時間戳>/
 *   node scripts/591-rent.mjs vision <id> <lighting> <double_bed> [note]   寫入圖片判斷結果
 *   node scripts/591-rent.mjs backfill                               替最新快照補抓缺少的詳情欄位(目前:建物面積 area_build_ping),只新增不改既有值
 *   node scripts/591-rent.mjs sync                                   彙整所有快照 + 圖片判斷,upsert 到 Supabase(rent_listings / rent_snapshots),網頁即時讀取
 *   node scripts/591-rent.mjs dump                                   從 Supabase 讀回,寫成 591-rent-house/data.json(網頁的靜態 JSON 版)
 *   node scripts/591-rent.mjs json                                   不經 Supabase,直接由本機快照寫出 591-rent-house/data.json
 *
 * 網頁:591-rent-house/index.html(密碼鎖;DATA_SOURCE 切換讀 Supabase 或 data.json)
 * 原始資料(皆在 591-rent-house/data/;photos/、vision-batches/ 不進 git):
 *   snapshots/YYYYMMDD-HHMMSS.json   每次抓取的完整快照
 *   latest.json                      最新快照
 *   diff-YYYYMMDD-HHMMSS.md          與上一份的差異
 *   vision.json                      圖片判斷結果(以 id 為 key)
 *
 * 同一間房的判斷:id 相同;id 不同時,以電話 / 標題 / (地址+聯絡人+坪數) 配對,視為換 id 重刊。
 */
import https from 'node:https';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, '591-rent-house');
const OUT = path.join(PAGE, 'data');
const SNAP = path.join(OUT, 'snapshots');
// 執行紀錄統一寫在 claude-assistant(不在本 repo,*.log 也被 gitignore)
const LOG = path.join(os.homedir(), 'claude-assistant', 'claude-export', 'execution-log.log');
const VISION = path.join(OUT, 'vision.json');

const QUERY = { region: '8', section: '102,99', price: '5000_10000', acreage: '11$_20$', sort: 'area_desc' };
const LIST_URL = (firstRow, sort = QUERY.sort) =>
  'https://rent.591.com.tw/list?' +
  Object.entries({ ...QUERY, sort, firstRow }).map(([k, v]) => `${k}=${v}`).join('&');
// 坪數相同的房源在 area_desc 下順序不穩,翻頁會重複/漏掉;改以多種排序取聯集直到湊滿 total
const SORTS = ['area_desc', 'posttime_desc', 'area_asc'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(url, tries = 4) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'zh-TW' }, timeout: 20000 }, (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (b += d));
        res.on('end', () => {
          if (res.statusCode === 200) return resolve(b);
          retry(new Error(`HTTP ${res.statusCode} ${url}`), n);
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout ' + url)));
      req.on('error', (e) => retry(e, n));
    };
    const retry = (e, n) => (n >= tries ? reject(e) : setTimeout(() => attempt(n + 1), 1500 * n));
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

async function scrapePass(sort, items, tops, topItems) {
  let total = null;
  for (let fr = 0; ; fr += 30) {
    const d = findData(await nuxt(LIST_URL(fr, sort)), (x) => Array.isArray(x.items) && 'total' in x);
    if (!d) throw new Error(`第 ${fr} 筆起找不到列表資料`);
    total = Number(String(d.total).replace(/,/g, ''));
    for (const it of d.items) if (!items.has(it.id) || items.get(it.id).kind_name === undefined) items.set(it.id, it);
    // topData 是置頂廣告,欄位較少且常與一般分頁重複:只標旗標,一般列表的完整資料優先
    for (const it of d.topData || []) if (it && it.id) { tops.add(it.id); topItems.set(it.id, it); }
    console.log(`  list sort=${sort} firstRow=${fr}: +${d.items.length} (累計 ${items.size}/${total})`);
    if (!d.items.length || fr + 30 >= total) break;
    await sleep(600);
  }
  return total;
}

async function scrapeList() {
  const items = new Map();
  const tops = new Set();
  const topItems = new Map();
  let total = null;
  for (const sort of SORTS) {
    total = await scrapePass(sort, items, tops, topItems);
    for (const id of topItems.keys()) if (!items.has(id)) items.set(id, topItems.get(id));
    if (items.size >= total) break;
    console.log(`  目前 ${items.size}/${total},換排序補抓…`);
  }
  for (const [id, it] of topItems) if (!items.has(id)) { items.set(id, it); console.warn(`  置頂廣告 ${id} 未出現在一般分頁,以置頂資料補入`); }
  return { items: [...items.values()], total, tops };
}

const num = (s) => { const m = String(s ?? '').replace(/,/g, '').match(/[\d.]+/); return m ? Number(m[0]) : null; };
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
    community: d.positionRound?.communityName || null,
    deposit: cost.deposit || d.deposit || null,
    service_fee: cost.serviceFee || null,
    manage_fee_text: cost.manageprice || d.rent_calculation_data?.manage_fee_text || null,
    manage_fee_amount: d.rent_calculation_data?.manage_fee ?? null,
    rent_includes: cost.priceContainText || null,
    water_fee: d.rent_calculation_data?.water_fee_type || cost.waterFee || null,
    electric_fee: cost.electricFee || d.rent_calculation_data?.electric_fee_type || null,
    extra_fee_text: d.extra_fee_text || null,
    area_use_ping: num(info.area || base.area),
    area_right_ping: num(info.area_right),
    area_build_ping: num(info.buildArea), // 建物面積(不含公設)
    house_age: info.age || null,
    shape: base.shape || gtm.shape_name || null,
    elevator_detail: info.lift || null,
    facilities,
    has_washer: facilities.includes('洗衣機'),
    has_elevator_detail: facilities.includes('電梯') || info.lift === '有',
    post_time: d.publish?.postTime || null,
    update_time: d.publish?.updateTime || null,
    end_time: d.endTime || null,
    status: d.status || null,
    contact_name: d.linkInfo.name || null,
    contact_role: d.linkInfo.roleName || null,
    contact_company: d.linkInfo.roleTxt || null,
    phones: [...phones],
    line: d.linkInfo.line || null,
    photos: (findData(data, (x) => Array.isArray(x.items) && x.items[0]?.photo)?.items || [])
      .filter((p) => p.key === 'picture' || p.photo).map((p) => p.photo),
    description: remarkText.replace(/\s+/g, ' ').trim().slice(0, 1500),
  };
}

function normalize(it, detail, tops) {
  const tags = it.tags || [];
  const [fl, tot] = String(it.floor_name || '').split('/');
  const dt = detail || {};
  const mt = dt.manage_fee_text;
  const manageFree = tags.includes('免管理費') || mt === '無' || /含租金/.test(mt || '');
  return {
    id: it.id,
    url: it.url || `https://rent.591.com.tw/${it.id}`,
    title: it.title,
    kind: it.kind_name,
    preferred: !!it.preferred,
    is_top_ad: tops.has(it.id),
    price: num(it.price),
    manage_fee: manageFree ? 0 : (dt.manage_fee_amount || num(mt) || null), // 0=免/含租金內;null=未載明
    manage_fee_note: mt || null,
    area_ping: num(it.area ?? it.area_name) ?? dt.area_use_ping ?? null,
    floor: fl || null,
    floor_total: tot || null,
    has_elevator: tags.includes('有電梯') || !!dt.has_elevator_detail,
    has_washer: detail ? dt.has_washer : null,
    section: String(it.address || '').split('-')[0] || null,
    address: it.address || null,
    contact_listing: it.linkman || null,
    role: it.role_name || null,
    refresh_time: it.refresh_time || null,
    browse_count: it.browse_count ?? null,
    tags,
    list_photos: (it.photoList || []).map((u) => u.replace(/!\d+x\d+\.jpg$/, '')),
    ...(detail ? { detail } : { detail: null }),
  };
}

const keyPhones = (h) => (h.detail?.phones || []).filter(Boolean);

function samePlace(a, b) {
  if (a.id === b.id) return 'id';
  // 同仲介常以同一組標題/照片/電話刊登多間不同房:非 id 的配對一律要求樓層相同,避免把鄰居房誤判成同一間
  if (a.floor && b.floor && a.floor !== b.floor) return null;
  if (!a.address || a.address !== b.address) return null;
  const pa = keyPhones(a), pb = new Set(keyPhones(b));
  if (pa.some((p) => pb.has(p))) return 'phone+address+floor';
  if (a.title && a.title === b.title) return 'title+address+floor';
  if (a.contact_listing && a.contact_listing === b.contact_listing && a.area_ping === b.area_ping)
    return 'address+contact+area+floor';
  return null;
}

function listSnapshots() {
  if (!fs.existsSync(SNAP)) return [];
  return fs.readdirSync(SNAP).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(SNAP, f));
}

function diff(oldSnap, newSnap) {
  const oldMap = new Map(oldSnap.items.map((i) => [i.id, i]));
  const newMap = new Map(newSnap.items.map((i) => [i.id, i]));
  const stay = [], added = [], gone = [], relisted = [];
  const unmatchedOld = [...oldSnap.items.filter((i) => !newMap.has(i.id))];
  for (const n of newSnap.items) {
    if (oldMap.has(n.id)) { stay.push([oldMap.get(n.id), n]); continue; }
    const idx = unmatchedOld.findIndex((o) => samePlace(o, n));
    if (idx >= 0) { const [o] = unmatchedOld.splice(idx, 1); n.same_as = o.id; relisted.push([o, n, samePlace(o, n)]); }
    else added.push(n);
  }
  gone.push(...unmatchedOld);
  const changed = stay.filter(([o, n]) => o.price !== n.price || o.preferred !== n.preferred);
  const row = (i) => `| ${i.id} | ${i.title} | ${i.price} | ${i.area_ping} | ${i.floor}/${i.floor_total} | ${i.address} | [連結](${i.url}) |`;
  const hdr = '| id | 標題 | 租金 | 坪 | 樓層 | 地址 | 連結 |\n|---|---|---|---|---|---|---|';
  let md = `# 591 差異報告\n\n- 舊快照:${oldSnap.scraped_at}(${oldSnap.items.length} 筆)\n- 新快照:${newSnap.scraped_at}(${newSnap.items.length} 筆)\n\n`;
  md += `| 項目 | 數量 |\n|---|---|\n| 仍在(同 id) | ${stay.length} |\n| 新增 | ${added.length} |\n| 消失 | ${gone.length} |\n| 換 id 重刊(判定同一間) | ${relisted.length} |\n| 租金/優選變動 | ${changed.length} |\n\n`;
  md += `## 新增\n\n${added.length ? hdr + '\n' + added.map(row).join('\n') : '無'}\n\n`;
  md += `## 消失(可能已租出/下架)\n\n${gone.length ? hdr + '\n' + gone.map(row).join('\n') : '無'}\n\n`;
  md += `## 換 id 重刊\n\n${relisted.length ? '| 舊 id | 新 id | 依據 | 標題 |\n|---|---|---|---|\n' + relisted.map(([o, n, w]) => `| ${o.id} | ${n.id} | ${w} | ${n.title} |`).join('\n') : '無'}\n\n`;
  md += `## 租金/優選變動\n\n${changed.length ? '| id | 標題 | 租金 | 優選 |\n|---|---|---|---|\n' + changed.map(([o, n]) => `| ${n.id} | ${n.title} | ${o.price}→${n.price} | ${o.preferred}→${n.preferred} |`).join('\n') : '無'}\n`;
  return { md, counts: { stay: stay.length, added: added.length, gone: gone.length, relisted: relisted.length, changed: changed.length } };
}

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const logLine = (msg) => {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, `${new Date().toISOString().slice(0, 10)} | 591-rent | ${msg}\n`);
};

async function cmdScrape(args) {
  const noDetail = args.includes('--no-detail');
  const li = args.indexOf('--limit');
  const limit = li >= 0 ? Number(args[li + 1]) : Infinity;
  console.log('抓取列表…');
  const { items, total, tops } = await scrapeList();
  if (items.length < total) console.warn(`⚠ 抓到 ${items.length} 筆,少於頁面 total=${total}(可能有重複或廣告項)`);
  const out = [];
  let n = 0;
  for (const it of items) {
    let detail = null;
    if (!noDetail && n < limit) {
      try { detail = parseDetail(await nuxt(`https://rent.591.com.tw/${it.id}`)); }
      catch (e) { console.warn(`  詳情失敗 ${it.id}: ${e.message}`); }
      n++;
      if (n % 20 === 0) console.log(`  detail ${n}/${items.length}`);
      await sleep(900);
    }
    out.push(normalize(it, detail, tops));
  }
  const prevFiles = listSnapshots();
  const prev = prevFiles.length ? JSON.parse(fs.readFileSync(prevFiles.at(-1), 'utf8')) : null;
  const snap = { scraped_at: new Date().toISOString(), query: QUERY, query_url: LIST_URL(0), total_reported: total, count: out.length, items: out };
  let report = null;
  if (prev) report = diff(prev, snap); // 會在 items 上標 same_as
  fs.mkdirSync(SNAP, { recursive: true });
  const file = path.join(SNAP, stamp() + '.json');
  fs.writeFileSync(file, JSON.stringify(snap, null, 2));
  fs.writeFileSync(path.join(OUT, 'latest.json'), JSON.stringify(snap, null, 2));
  console.log(`已存 ${file}(${out.length} 筆,頁面 total=${total})`);
  let msg = `scrape ${out.length}/${total} 筆 -> ${path.relative(ROOT, file)}`;
  if (report) {
    const df = path.join(OUT, `diff-${stamp()}.md`);
    fs.writeFileSync(df, report.md);
    console.log('差異:', JSON.stringify(report.counts), '->', df);
    msg += `; diff ${JSON.stringify(report.counts)}`;
  } else console.log('第一份快照,無可比對。');
  logLine(msg);
}

function cmdDiff(args) {
  let a, b;
  if (args.length >= 2) [a, b] = args;
  else { const f = listSnapshots(); if (f.length < 2) return console.error('快照不足 2 份'); [a, b] = f.slice(-2); }
  const r = diff(JSON.parse(fs.readFileSync(a, 'utf8')), JSON.parse(fs.readFileSync(b, 'utf8')));
  const df = path.join(OUT, `diff-${stamp()}.md`);
  fs.writeFileSync(df, r.md);
  console.log(r.md);
  logLine(`diff ${JSON.stringify(r.counts)} -> ${path.relative(ROOT, df)}`);
}

const loadVision = () => (fs.existsSync(VISION) ? JSON.parse(fs.readFileSync(VISION, 'utf8')) : {});

function cmdImages(args) {
  const latest = path.join(OUT, 'latest.json');
  if (!fs.existsSync(latest)) return console.error('尚無快照,先執行 scrape');
  const snap = JSON.parse(fs.readFileSync(latest, 'utf8'));
  const vis = loadVision();
  const todo = [];
  for (const i of snap.items) {
    if (vis[i.id] && !args.includes('--all')) continue;
    if (i.same_as && vis[i.same_as] && !args.includes('--all')) { vis[i.id] = { ...vis[i.same_as], carried_from: i.same_as }; continue; }
    todo.push({ id: i.id, title: i.title, photos: (i.detail?.photos?.length ? i.detail.photos : i.list_photos) });
  }
  fs.writeFileSync(VISION, JSON.stringify(vis, null, 2));
  if (args.includes('--download')) return downloadPhotos(todo, args);
  console.log(JSON.stringify(todo, null, 1));
  console.error(`待判斷 ${todo.length} 筆(已判斷 ${snap.items.length - todo.length})`);
}

async function downloadPhotos(todo, args) {
  const ni = args.indexOf('--max');
  const max = ni >= 0 ? Number(args[ni + 1]) : 6;
  const dir = path.join(OUT, 'photos');
  const manifest = {};
  for (const t of todo) {
    fs.mkdirSync(path.join(dir, String(t.id)), { recursive: true });
    manifest[t.id] = [];
    for (const [k, u] of t.photos.slice(0, max).entries()) {
      const file = path.join(dir, String(t.id), `${k + 1}.jpg`);
      if (!fs.existsSync(file)) {
        try { fs.writeFileSync(file, await getBin(u.replace(/!.*$/, '!800x.water2.jpg'))); await sleep(150); }
        catch (e) { console.warn(`  照片失敗 ${t.id}#${k + 1}: ${e.message}`); continue; }
      }
      manifest[t.id].push(path.relative(ROOT, file));
    }
  }
  fs.writeFileSync(path.join(OUT, 'photos-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`已下載 ${Object.values(manifest).flat().length} 張 -> ${path.relative(ROOT, dir)}(清單 photos-manifest.json)`);
  // 切成每批 20 間的 in-NN.json,給 LLM 分批判斷後寫 out-NN.json,再用 591-merge-vision.py <批次目錄> 合併
  const entries = Object.entries(manifest).filter(([, f]) => f.length);
  if (!entries.length) return;
  const bdir = path.join(OUT, 'vision-batches', stamp());
  fs.mkdirSync(bdir, { recursive: true });
  for (let k = 0; k * 20 < entries.length; k++)
    fs.writeFileSync(path.join(bdir, `in-${String(k + 1).padStart(2, '0')}.json`), JSON.stringify(Object.fromEntries(entries.slice(k * 20, k * 20 + 20)), null, 1));
  console.log(`批次 -> ${path.relative(ROOT, bdir)}(${Math.ceil(entries.length / 20)} 批)`);
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

function cmdVision([id, lighting, doubleBed, ...note]) {
  if (!id || !lighting || !doubleBed) return console.error('用法: vision <id> <good|fair|poor|unknown> <yes|no|unknown> [note]');
  const vis = loadVision();
  vis[id] = { lighting, double_bed: doubleBed, note: note.join(' '), judged_at: new Date().toISOString() };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(VISION, JSON.stringify(vis, null, 2));
  console.log('ok', id);
}

function postDays(s, scrapedAt) {
  let m;
  if (!s) return null;
  if (/小時|分鐘/.test(s)) return 0;
  if ((m = s.match(/(\d+)天前/))) return Number(m[1]);
  if ((m = s.match(/(\d+)月(\d+)日/))) {
    const now = new Date(scrapedAt);
    let d = new Date(now.getFullYear(), m[1] - 1, m[2]);
    if (d > now) d = new Date(now.getFullYear() - 1, m[1] - 1, m[2]);
    return Math.floor((now - d) / 864e5);
  }
  return null;
}

// 舊快照沒有後來才加的詳情欄位時,重抓詳情補上;只新增缺的 key,既有資料不動
const BACKFILL_KEYS = ['area_build_ping'];
async function cmdBackfill() {
  const file = listSnapshots().at(-1);
  if (!file) return console.error('尚無快照,先執行 scrape');
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const todo = snap.items.filter((i) => i.detail && BACKFILL_KEYS.some((k) => !(k in i.detail)));
  console.log(`${path.basename(file)}:待補 ${todo.length}/${snap.items.length} 筆`);
  let ok = 0;
  for (const [n, i] of todo.entries()) {
    try {
      const d = parseDetail(await nuxt(`https://rent.591.com.tw/${i.id}`));
      if (d) { for (const k of BACKFILL_KEYS) if (!(k in i.detail)) i.detail[k] = d[k]; ok++; }
      else console.warn(`  ${i.id} 無詳情(可能已下架)`);
    } catch (e) { console.warn(`  ${i.id} 失敗: ${e.message}`); }
    if ((n + 1) % 20 === 0) console.log(`  ${n + 1}/${todo.length}`);
    await sleep(900);
  }
  fs.writeFileSync(file, JSON.stringify(snap, null, 2));
  const latest = path.join(OUT, 'latest.json');
  if (JSON.parse(fs.readFileSync(latest, 'utf8')).scraped_at === snap.scraped_at) fs.writeFileSync(latest, JSON.stringify(snap, null, 2));
  console.log(`已補 ${ok}/${todo.length} 筆 -> ${path.relative(ROOT, file)}`);
  logLine(`backfill ${BACKFILL_KEYS.join(',')} ${ok}/${todo.length} -> ${path.relative(ROOT, file)}`);
}

// 591 圖床要帶尺寸後綴(不帶會 404);有些網址已帶 !fit… 後綴要先去掉,影片封面(.png)不能縮,跳過
function thumb(i) {
  const u = [...(i.list_photos || []), ...(i.detail?.photos || [])].find((x) => !x.includes('/video/'));
  return u ? u.replace(/!.*$/, '') + '!510x400.jpg' : '';
}

// 彙整所有快照:每間房一列,記首次/最後爬到時間與是否還在;換 id 重刊(same_as)併成同一列
// 輸出格式 = data.json = Supabase rent_listings.data,網頁兩種來源共用同一套 render
function buildDataset() {
  const snaps = listSnapshots().map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
    .sort((a, b) => a.scraped_at.localeCompare(b.scraped_at));
  if (!snaps.length) throw new Error('尚無快照,先執行 scrape');
  const vis = loadVision();
  const last = snaps.at(-1).scraped_at;
  const recs = new Map(); // key = 該房最新的 id
  for (const s of snaps) {
    for (const i of s.items) {
      let r = recs.get(i.id);
      if (!r && i.same_as && recs.has(i.same_as)) { r = recs.get(i.same_as); recs.delete(i.same_as); }
      if (!r) r = { first_seen: s.scraped_at, ids: [], prices: [], seen_count: 0 };
      if (!r.ids.includes(i.id)) r.ids.push(i.id);
      if (r.prices.at(-1) !== i.price) r.prices.push(i.price);
      Object.assign(r, { item: i, scraped_at: s.scraped_at, last_seen: s.scraped_at, seen_count: r.seen_count + 1 });
      recs.set(i.id, r);
    }
  }
  const nextAfter = (t) => snaps.find((s) => s.scraped_at > t)?.scraped_at || null;
  const items = [...recs.values()].map((r) => {
    const i = r.item, d = i.detail || {};
    const v = r.ids.map((id) => vis[id]).findLast(Boolean) || {};
    const active = r.last_seen === last;
    return {
      id: i.id, old_ids: r.ids.slice(0, -1), url: i.url, title: i.title, kind: i.kind, preferred: i.preferred,
      price: i.price, price_history: r.prices, manage_fee: i.manage_fee, manage_fee_note: i.manage_fee_note,
      area_ping: i.area_ping, area_build: d.area_build_ping ?? null, area_right: d.area_right_ping ?? null, floor: i.floor, floor_total: i.floor_total, floor_n: num(i.floor),
      has_elevator: i.has_elevator, has_washer: i.has_washer, section: i.section,
      address: d.address_detail || i.address, lat: d.lat, lng: d.lng,
      contact: d.contact_name || i.role, contact_role: d.contact_role, phones: d.phones || [],
      post_time: (d.post_time || '').replace(/^此房屋在|發佈$/g, ''), post_days: postDays(d.post_time, r.scraped_at),
      refresh_time: i.refresh_time, facilities: d.facilities || [], tags: i.tags || [],
      deposit: d.deposit, house_age: d.house_age,
      lighting: v.lighting || 'unknown', double_bed: v.double_bed || 'unknown', vision_note: v.note || '', has_vision: !!v.lighting,
      photo: thumb(i), // 網站上沒有本機照片,一律用 591 遠端圖
      first_seen: r.first_seen, last_seen: r.last_seen, seen_count: r.seen_count,
      gone_at: active ? null : nextAfter(r.last_seen),
      status: !active ? 'gone' : snaps.length > 1 && r.first_seen === last ? 'new' : 'active',
    };
  });
  return { snapshots: snaps.map((s) => ({ at: s.scraped_at, count: s.items.length, total: s.total_reported, query_url: s.query_url })), items };
}

function summary(data) {
  const c = (st) => data.items.filter((i) => i.status === st).length;
  const missing = data.items.filter((i) => i.status !== 'gone' && !i.has_vision).length;
  return `${data.snapshots.length} 次快照、累計 ${data.items.length} 間(在架 ${c('active') + c('new')},本次新上架 ${c('new')},已消失 ${c('gone')})` +
    (missing ? `,⚠ ${missing} 間在架房源尚未做圖片判斷` : '');
}

const DATA_JSON = path.join(PAGE, 'data.json');
function cmdJson() {
  const data = buildDataset();
  fs.writeFileSync(DATA_JSON, JSON.stringify(data));
  console.log(`已寫 ${path.relative(ROOT, DATA_JSON)}:${summary(data)}`);
}

// Supabase 連線設定直接讀網站的 config.js(publishable key 本來就公開),不重複寫死
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

async function cmdSync() {
  const data = buildDataset();
  if (!data.items.length) throw new Error('dataset 0 筆,中止(避免把 Supabase 清空)');
  const api = supa();
  const now = new Date().toISOString();
  const rows = data.items.map((i) => ({ id: i.id, status: i.status, first_seen: i.first_seen, last_seen: i.last_seen, data: i, updated_at: now }));
  for (let k = 0; k < rows.length; k += 200)
    await api('POST', 'rent_listings?on_conflict=id', rows.slice(k, k + 200), 'resolution=merge-duplicates,return=minimal');
  await api('POST', 'rent_snapshots?on_conflict=scraped_at',
    data.snapshots.map((s) => ({ scraped_at: s.at, count: s.count, total: s.total, query_url: s.query_url })), 'resolution=merge-duplicates,return=minimal');
  // upsert 成功後才清掉已不在 dataset 的列(換 id 重刊被併掉的舊 id)
  const keep = new Set(rows.map((r) => r.id));
  const stale = (await readAll(api, 'rent_listings', 'id')).map((r) => r.id).filter((id) => !keep.has(id));
  if (stale.length) await api('DELETE', `rent_listings?id=in.(${stale.join(',')})`);
  const msg = `sync ${rows.length} 列 + ${data.snapshots.length} 快照,刪除舊 id ${stale.length} 列`;
  console.log(`${msg}:${summary(data)}`);
  logLine(msg);
}

async function cmdDump() {
  const api = supa();
  const items = (await readAll(api, 'rent_listings', 'id')).map((r) => r.data);
  const snapshots = (await readAll(api, 'rent_snapshots', 'scraped_at.asc'))
    .map((s) => ({ at: new Date(s.scraped_at).toISOString(), count: s.count, total: s.total, query_url: s.query_url }));
  const data = { snapshots, items };
  fs.writeFileSync(DATA_JSON, JSON.stringify(data));
  console.log(`已從 Supabase 寫出 ${path.relative(ROOT, DATA_JSON)}:${summary(data)}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const cmds = { scrape: cmdScrape, diff: cmdDiff, images: cmdImages, vision: cmdVision, backfill: cmdBackfill, json: cmdJson, sync: cmdSync, dump: cmdDump };
if (!cmds[cmd]) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*?/, ''));
  process.exit(cmd ? 1 : 0);
}
await cmds[cmd](rest);
