// ============================================================
//  阿珊的美食地圖 - 主程式
// ============================================================
const CFG = window.SUPABASE_CONFIG;
const sb = supabase.createClient(CFG.url, CFG.key);
const TABLE = CFG.table || 'places';
const BUCKET = CFG.bucket || 'place-photos';
const QUEUE_TABLE = CFG.queueTable || 'pending_url_queue';
const TAIWAN = [23.97, 120.97];
// 地圖預設視野（Google Maps 網址格式：@24.1515728,120.6461127,11.8z）
const DEFAULT_VIEW = { center: [24.1515728, 120.6461127], zoom: 11.8 };

// 上傳前壓縮：等比縮到最長邊 maxDim、重新編碼成 JPEG
async function compressImage(file, maxDim = 1600, quality = 0.82) {
  // 非圖片或 GIF（怕弄壞動畫）就原檔上傳
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  try {
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = dataUrl;
    });
    let { width, height } = img;
    if (Math.max(width, height) > maxDim) {
      const scale = maxDim / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    if (!blob || blob.size >= file.size) return file;   // 壓不贏原檔就用原檔
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;   // 壓縮失敗就退回原檔，不擋上傳
  }
}

// 原圖網址 → 縮圖網址（thumbs/ 路徑慣例）；外部網址沒有縮圖，原樣回傳
function thumbUrl(url) {
  if (!url || !url.includes(`/${BUCKET}/`) || url.includes(`/${BUCKET}/thumbs/`)) return url;
  return url.replace(`/${BUCKET}/`, `/${BUCKET}/thumbs/`);
}

// 上傳圖片到 Supabase Storage（原圖 + thumbs/ 縮圖），回傳原圖公開網址
async function uploadImage(file) {
  const out = await compressImage(file);
  const ext = (out.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, out, {
    cacheControl: '3600', upsert: false, contentType: out.type,
  });
  if (error) throw error;

  // 縮圖（列表 / 地圖 popup 用）：失敗不擋流程，前端會 fallback 回原圖
  try {
    const thumb = await compressImage(file, 480, 0.75);
    const { error: thumbErr } = await sb.storage.from(BUCKET).upload(`thumbs/${path}`, thumb, {
      cacheControl: '3600', upsert: false, contentType: thumb.type,
    });
    if (thumbErr) console.warn('縮圖上傳失敗：', thumbErr.message);
  } catch (err) {
    console.warn('縮圖產生失敗：', err);
  }

  return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

// 從公開網址刪除 bucket 內的原圖與縮圖（外部網址略過）；失敗不擋流程
async function removeStoredImage(url) {
  const marker = `/${BUCKET}/`;
  const i = url ? url.indexOf(marker) : -1;
  if (i === -1) return;
  const path = url.slice(i + marker.length);
  if (path.startsWith('thumbs/')) return;
  try {
    await sb.storage.from(BUCKET).remove([path, `thumbs/${path}`]);
  } catch (err) {
    console.warn('刪除舊圖失敗：', err);
  }
}

let places = [];
let mainMap, markerLayer;
let pickMap, pickMarker;
let editingId = null;
let removeImageFlag = false;   // 編輯時按了「移除照片」
let onlyRestaurants = false;   // 篩選：只顯示餐廳
let pickModeActive = false;    // 主地圖選座標模式
let firstMapRender = true;     // 第一次畫地圖不要 fitBounds（保留預設視野）

// 套用篩選後要顯示的資料
function visiblePlaces() {
  return onlyRestaurants ? places.filter(p => p.is_restaurant) : places;
}

// ---------- 小工具 ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2800);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('zh-TW', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// 任意日期字串 → ISO（無法解析則回 null），給匯入用

// ISO 字串 → <input type="datetime-local"> 需要的本地時間字串
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function stars(v, cls = '') {
  if (v == null || v === '') return '<span class="muted">—</span>';
  return `<span class="badge ${cls}"><span class="star">★</span>${Number(v)}</span>`;
}

// 產生 Google Maps 連結：完整網址直接用 / place_id 轉連結 / 否則用座標
function googleMapsUrl(p) {
  const g = (p.google_url || '').trim();
  if (g) {
    if (/^https?:\/\//i.test(g)) return g;
    const id = g.replace(/^place_id:/i, '');
    if (/^[A-Za-z0-9_-]{15,}$/.test(id)) {
      return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(id)}`;
    }
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(g)}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`;
}

// ---------- Google URL 解析 ----------
function parseGoogleUrl(text) {
  const result = { lat: null, lon: null, name: null };
  if (!text) return result;

  // 精確地點座標 !3dLAT!4dLON
  const exact = text.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
  if (exact) { result.lat = parseFloat(exact[1]); result.lon = parseFloat(exact[2]); }

  // 視野中心 @LAT,LON
  if (result.lat == null) {
    const at = text.match(/@(-?[\d.]+),(-?[\d.]+)/);
    if (at) { result.lat = parseFloat(at[1]); result.lon = parseFloat(at[2]); }
  }

  // query 參數 ?q=LAT,LON 或 &query=LAT,LON
  if (result.lat == null) {
    const q = text.match(/[?&](?:q|query)=(-?[\d.]+),(-?[\d.]+)/);
    if (q) { result.lat = parseFloat(q[1]); result.lon = parseFloat(q[2]); }
  }

  // 店名：/maps/place/名稱/@...
  const nm = text.match(/\/maps\/place\/([^/@]+)/);
  if (nm) result.name = decodeURIComponent(nm[1].replace(/\+/g, ' ')).trim();

  return result;
}

// ---------- 短網址解析工具 ----------
const CORS_PROXIES = [
  url => 'https://corsproxy.io/?' + encodeURIComponent(url),
  url => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
  url => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url),
];

function extractRedirectUrl(res, html) {
  // 策略 1: proxy 已跟隨重導向，res.url 即為最終 URL
  if (res.url && /google\.\w+\/maps/i.test(res.url)) return res.url;

  // 策略 2: <meta http-equiv="refresh" content="...url=...">
  const metaRefresh = html.match(
    /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]+content\s*=\s*["'][^"']*url\s*=\s*([^"'\s>]+)/i
  );
  if (metaRefresh && /google\.\w+\/maps/i.test(metaRefresh[1])) return metaRefresh[1];

  // 策略 3: <link rel="canonical" href="...">
  const canonical = html.match(
    /<link[^>]+rel\s*=\s*["']canonical["'][^>]+href\s*=\s*["']([^"']+)/i
  );
  if (canonical && /google\.\w+\/maps/i.test(canonical[1])) return canonical[1];

  // 策略 4: HTML 內任何 Google Maps URL（優先含座標的）
  const allUrls = html.match(/https?:\/\/(?:www\.)?google\.\w+\/maps\/[^\s"'<>)}\]]+/gi);
  if (allUrls) {
    const withCoords = allUrls.find(u => /!3d-?[\d.]+!4d-?[\d.]+/.test(u) || /@-?[\d.]+,-?[\d.]+/.test(u));
    return withCoords || allUrls[0];
  }
  return null;
}

async function resolveShortUrl(shortUrl) {
  const errors = [];
  for (const makeProxyUrl of CORS_PROXIES) {
    try {
      const proxyUrl = makeProxyUrl(shortUrl);
      const res = await fetch(proxyUrl, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();

      // 優先從重導向 URL 擷取座標
      const redirectUrl = extractRedirectUrl(res, html);
      if (redirectUrl) {
        const parsed = parseGoogleUrl(redirectUrl);
        if (parsed.lat != null) return { textToParse: redirectUrl, error: null };
      }

      // 退路：直接解析 HTML 本體
      const parsed = parseGoogleUrl(html);
      if (parsed.lat != null) return { textToParse: html, error: null };

      errors.push(new Error('此代理回傳的內容找不到座標'));
    } catch (err) {
      errors.push(err);
    }
  }
  const lastMsg = errors.length ? errors[errors.length - 1].message : '未知錯誤';
  return { textToParse: null, error: new Error(lastMsg) };
}

// ---------- 待處理佇列（短網址解析失敗）----------
async function enqueueFailedUrl(url, note) {
  return sb.from(QUEUE_TABLE).insert({ google_url: url, note });
}

async function loadQueue() {
  const box = $('#queue-list');
  if (!box) return;
  const { data, error } = await sb.from(QUEUE_TABLE).select('*').order('created_at', { ascending: false });
  if (error) { box.innerHTML = `<p class="hint">佇列載入失敗：${error.message}</p>`; return; }
  if (!data || !data.length) { box.innerHTML = '<p class="hint">目前沒有待處理的短網址</p>'; return; }

  box.innerHTML = data.map(row => `
    <div class="queue-item" data-id="${row.id}">
      <div class="queue-item-info">
        <span class="queue-item-time">${new Date(row.created_at).toLocaleString('zh-TW')}</span>
        <a href="${row.google_url}" target="_blank" rel="noopener">${row.google_url}</a>
        ${row.note ? `<span class="hint">${row.note}</span>` : ''}
      </div>
      <button type="button" class="btn small queue-item-del">已處理，移除</button>
    </div>
  `).join('');
}

$('#queue-list')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('.queue-item-del');
  if (!btn) return;
  const id = btn.closest('.queue-item').dataset.id;
  const { error } = await sb.from(QUEUE_TABLE).delete().eq('id', id);
  if (error) { toast('移除失敗：' + error.message); return; }
  loadQueue();
});

loadQueue();

// ---------- 導覽 ----------
function showView(name) {
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'map' && mainMap) setTimeout(() => mainMap.invalidateSize(), 50);
  if (name === 'add' && pickMap) setTimeout(() => pickMap.invalidateSize(), 50);
}
$$('.nav-btn').forEach(b => b.addEventListener('click', async () => {
  // 進入「新增」頁需要密碼；每次從側邊欄進來，兩個分區都預設收合
  if (b.dataset.view === 'add') {
    if (!(await unlockAdd())) return;
    $('#sec-quick').open = false;
    $('#sec-full').open = false;
  }
  showView(b.dataset.view);
}));

// ---------- 密碼鎖（新增 / 匯入頁）----------
const ADD_PWD_HASH = 'c0d7c54022345b39c9be73e19b30ccb040ba03b1fefb2566a9f510a09aba4796';
let addUnlocked = false;

async function sha256(str) {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 通過一次後整個 session 都記住，回傳是否解鎖成功
async function unlockAdd() {
  if (addUnlocked) return true;
  const pwd = prompt('請輸入密碼：');
  if (pwd === null) return false;            // 使用者按取消
  if ((await sha256(pwd)) === ADD_PWD_HASH) {
    addUnlocked = true;
    return true;
  }
  toast('密碼錯誤', true);
  return false;
}

// ---------- 使用者名字（cookie）----------
function getCookie(name) {
  const m = document.cookie.split('; ').find(c => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.split('=').slice(1).join('=')) : null;
}
function setCookie(name, value, days) {
  const d = new Date();
  d.setTime(d.getTime() + days * 864e5);
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${d.toUTCString()}; path=/; SameSite=Lax`;
}
function renderGreeting(name) {
  const g = $('#greeting');
  g.textContent = `Hi, ${name} 👋`;
  g.hidden = false;
}
// 目前使用者名稱（給「建立者」用）
function currentUser() {
  return getCookie('username') || '訪客';
}
// 名字輸入彈窗（取代 prompt；密碼仍走瀏覽器 prompt）
// cancelable=false 時沒有取消鈕、Esc 也關不掉，一定要給名字
function askName({ title, value = '', cancelable = true }) {
  return new Promise(resolve => {
    const modal = $('#name-modal');
    const input = $('#name-input');
    const cancelBtn = $('#name-cancel');
    $('#name-title').textContent = title;
    input.value = value;
    cancelBtn.hidden = !cancelable;
    modal.hidden = false;
    setTimeout(() => { input.focus(); input.select(); }, 0);

    const close = result => {
      modal.hidden = true;
      $('#name-confirm').removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onOk = () => {
      const v = input.value.trim();
      if (!v && !cancelable) { input.focus(); return; }   // 首次進入不能留空
      close(v || null);
    };
    const onCancel = () => close(null);
    const onKey = e => {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      if (e.key === 'Escape' && cancelable) onCancel();
    };

    $('#name-confirm').addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

async function initUserName() {
  let name = getCookie('username');
  if (!name) {
    name = (await askName({ title: '歡迎！請輸入你的名字', cancelable: false })) || '訪客';
    setCookie('username', name, 365);
  }
  renderGreeting(name);
}
// 點問候語可改名字
$('#greeting').addEventListener('click', async () => {
  const name = await askName({ title: '修改名字', value: getCookie('username') || '' });
  if (name) { setCookie('username', name, 365); renderGreeting(name); }
});

// ---------- 讀取資料 ----------
async function loadPlaces() {
  const { data, error } = await sb.from(TABLE)
    .select('*')
    .order('visited_at', { ascending: false, nullsFirst: false })  // 造訪時間新到舊（沒填的排後面）
    .order('created_at', { ascending: false });
  if (error) {
    toast('讀取失敗：' + error.message, true);
    console.error(error);
    return;
  }
  places = data || [];
  render();
}

// 套用目前篩選後重畫地圖與列表
function render() {
  const vis = visiblePlaces();
  $('#count-badge').textContent = onlyRestaurants
    ? `${vis.length} / ${places.length} 筆（只餐廳）`
    : `${places.length} 筆紀錄`;
  renderMap();
  renderList();
}

// 篩選開關（地圖頁與列表頁的勾選框共用同一狀態）
$$('.filter-toggle').forEach(cb => cb.addEventListener('change', e => {
  onlyRestaurants = e.target.checked;
  $$('.filter-toggle').forEach(other => { other.checked = onlyRestaurants; });
  render();
}));

// ---------- 1) 地圖 ----------
function initMainMap() {
  mainMap = L.map('map', { doubleClickZoom: false, zoomSnap: 0.1 })
    .setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(mainMap);
  markerLayer = L.layerGroup().addTo(mainMap);

  // 雙擊放大 4 級（取代預設的 +1）
  mainMap.on('dblclick', e => {
    if (pickModeActive) return;   // pick mode 時不觸發 zoom
    mainMap.flyTo(e.latlng, Math.min(mainMap.getZoom() + 4, mainMap.getMaxZoom()));
  });
}

// ---------- 我的位置 ----------
let locMarker = null;

function initLocateBtn() {
  const btn = $('#btn-locate');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!navigator.geolocation) return toast('你的瀏覽器不支援定位功能', true);
    btn.classList.add('locating');
    navigator.geolocation.getCurrentPosition(
      pos => {
        btn.classList.remove('locating');
        const { latitude: lat, longitude: lng } = pos.coords;
        mainMap.flyTo([lat, lng], 16);
        if (locMarker) locMarker.setLatLng([lat, lng]);
        else {
          locMarker = L.circleMarker([lat, lng], {
            radius: 8, fillColor: '#4285f4', fillOpacity: 1,
            color: '#fff', weight: 3,
          }).addTo(mainMap);
        }
        locMarker.bindPopup('你的位置').openPopup();
      },
      err => {
        btn.classList.remove('locating');
        const msgs = { 1: '定位權限被拒絕，請在瀏覽器設定中允許', 2: '無法取得位置資訊', 3: '定位逾時，請重試' };
        toast(msgs[err.code] || '定位失敗', true);
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  });
}

function renderMap() {
  if (!markerLayer) return;
  markerLayer.clearLayers();
  const pts = [];
  visiblePlaces().forEach(p => {
    if (p.lat == null || p.lon == null) return;
    const m = L.marker([p.lat, p.lon]);
    m.bindPopup(`
      <div class="popup-name">${esc(p.name)}${p.category ? ` <span class="popup-cat">${esc(p.category)}</span>` : ''}${p.is_closed ? ' <span class="popup-cat closed">已歇業</span>' : ''}</div>
      <div class="popup-meta">乙珊評分 ${p.rating ?? '—'}★ · Google ${p.google_rating ?? '—'}★${p.author ? ` · ✍️ ${esc(p.author)}` : ''}</div>
      ${p.image_url ? `<img class="popup-img" src="${esc(thumbUrl(p.image_url))}" data-full="${esc(p.image_url)}" loading="lazy" onerror="this.onerror=null;this.src=this.dataset.full" alt="${esc(p.name)}" />` : ''}
      <button class="btn small primary" onclick="openDetail(${p.id})">看詳細</button>
    `);
    m.addTo(markerLayer);
    pts.push([p.lat, p.lon]);
  });
  // 首次載入維持 DEFAULT_VIEW；之後重畫（切篩選、新增/刪除後）才自動框住所有點
  if (pts.length && !firstMapRender) mainMap.fitBounds(pts, { padding: [50, 50], maxZoom: 15 });
  firstMapRender = false;
}

// ---------- 詳細視窗 ----------
window.openDetail = function (id) {
  const p = places.find(x => x.id === id);
  if (!p) return;
  $('#detail-box').innerHTML = `
    <button class="modal-close" onclick="closeDetail()" aria-label="關閉">×</button>
    <h3>${esc(p.name)}${p.category ? ` <span class="badge cat">${esc(p.category)}</span>` : ''}${p.is_restaurant === false ? ' <span class="badge">非餐廳</span>' : ''}${p.is_closed ? ' <span class="badge closed">已永久歇業</span>' : ''}</h3>
    <div class="pc-meta">
      ${stars(p.rating)} 乙珊評分　${stars(p.google_rating, 'g')} Google
      <span>✍️ ${esc(p.author || '—')}</span>
      ${p.visited_at ? `<span>📅 造訪 ${fmtDate(p.visited_at)}</span>` : ''}
      <span>🕑 建立 ${fmtDate(p.created_at)}</span>
    </div>
    ${p.image_url ? `<a href="${esc(p.image_url)}" target="_blank" rel="noopener"><img class="detail-img" src="${esc(p.image_url)}" alt="${esc(p.name)}" /></a>` : ''}
    <div class="pc-review">${p.review ? esc(p.review) : '<span class="muted">（沒有評價）</span>'}</div>
    <div class="modal-actions">
      <a class="btn primary" href="${googleMapsUrl(p)}" target="_blank" rel="noopener">🗺️ 在 Google Maps 開啟</a>
      <button class="btn" onclick="editPlace(${p.id})">✏️ 編輯</button>
      <button class="btn danger" onclick="deletePlace(${p.id})">🗑️ 刪除</button>
    </div>`;
  $('#detail-modal').hidden = false;
};
window.closeDetail = () => ($('#detail-modal').hidden = true);
$('#detail-modal').addEventListener('click', e => {
  if (e.target.id === 'detail-modal') closeDetail();
});

// ---------- 2) 列表 ----------
// 依「年份 + 四季」分組：春 2-4 月、夏 5-7 月、秋 8-10 月、冬 11-12 月+隔年 1 月
// （冬季橫跨年末年初，統一算「11、12 月那一年」的冬天，所以 2025/11、2025/12、
// 2026/1 都是「2025 冬」，接著才是 2026 春）
const SEASONS = ['春', '夏', '秋', '冬'];
function seasonKey(p) {
  const iso = p.visited_at || p.created_at;
  if (!iso) return { key: 'unknown', label: '未填時間', sort: -1 };
  const d = new Date(iso);
  let y = d.getFullYear();
  const m = d.getMonth() + 1;
  let s;
  if (m === 1) { s = 3; y -= 1; }   // 1 月算前一年的冬天
  else if (m <= 4) s = 0;           // 2-4 月 春
  else if (m <= 7) s = 1;           // 5-7 月 夏
  else if (m <= 10) s = 2;          // 8-10 月 秋
  else s = 3;                       // 11-12 月 冬
  return { key: `${y}-${s}`, label: `${y} ${SEASONS[s]}`, sort: y * 10 + s };
}

// 記住哪些季節區塊是展開的（切篩選重畫時不要全部收回去）
let openSeasons = null;

function placeCardHtml(p) {
  return `
    <div class="place-card">
      ${p.image_url ? `<img class="pc-thumb" src="${esc(thumbUrl(p.image_url))}" data-full="${esc(p.image_url)}" loading="lazy" onerror="this.onerror=null;this.src=this.dataset.full" alt="${esc(p.name)}" onclick="openDetail(${p.id})" />` : ''}
      <div class="pc-main">
        <h3>${esc(p.name)}${p.category ? ` <span class="badge cat">${esc(p.category)}</span>` : ''}${p.is_closed ? ' <span class="badge closed">已永久歇業</span>' : ''}</h3>
        <div class="pc-meta">
          ${stars(p.rating)} 乙珊評分　${stars(p.google_rating, 'g')} Google
          <span>✍️ ${esc(p.author || '—')}</span>
          <span>📅 ${p.visited_at ? '造訪 ' + fmtDate(p.visited_at) : '建立 ' + fmtDate(p.created_at)}</span>
        </div>
        <div class="pc-review">${p.review ? esc(p.review) : '<span class="muted">（沒有評價）</span>'}</div>
      </div>
      <div class="pc-actions">
        <button class="btn small" onclick="openDetail(${p.id})">詳細</button>
        <a class="btn small" href="${googleMapsUrl(p)}" target="_blank" rel="noopener">Google</a>
        <button class="btn small danger" onclick="deletePlace(${p.id})">刪除</button>
      </div>
    </div>`;
}

function renderList() {
  const c = $('#list-container');
  const list = visiblePlaces();
  if (!list.length) {
    c.innerHTML = `<p class="hint">${places.length ? '沒有符合「只顯示餐廳」的紀錄。' : '還沒有任何紀錄，去「新增地點」加第一筆吧！'}</p>`;
    return;
  }

  // 分組（list 已依造訪時間新到舊排好，組內順序直接沿用）
  const groups = new Map();
  list.forEach(p => {
    const g = seasonKey(p);
    if (!groups.has(g.key)) groups.set(g.key, { ...g, items: [] });
    groups.get(g.key).items.push(p);
  });
  const sorted = [...groups.values()].sort((a, b) => b.sort - a.sort);   // 新到舊，未填時間排最後

  // 第一次進來只展開最新那組；之後沿用使用者自己開合的狀態
  if (openSeasons === null) openSeasons = new Set(sorted.length ? [sorted[0].key] : []);

  c.innerHTML = sorted.map(g => `
    <details class="section-card season-group" data-key="${g.key}"${openSeasons.has(g.key) ? ' open' : ''}>
      <summary>
        <span class="sec-title">${esc(g.label)}</span>
        <span class="sec-sub">${g.items.length} 筆</span>
      </summary>
      <div class="section-body">${g.items.map(placeCardHtml).join('')}</div>
    </details>`).join('');

  // 記住展開狀態
  $$('.season-group', c).forEach(d => d.addEventListener('toggle', () => {
    d.open ? openSeasons.add(d.dataset.key) : openSeasons.delete(d.dataset.key);
  }));
}

window.deletePlace = async function (id) {
  if (!confirm('確定要刪除這筆紀錄？')) return;
  const p = places.find(x => x.id === id);
  const { error } = await sb.from(TABLE).delete().eq('id', id);
  if (error) return toast('刪除失敗：' + error.message, true);
  if (p?.image_url) removeStoredImage(p.image_url);   // 連同 Storage 的原圖 + 縮圖一起刪
  closeDetail();
  toast('已刪除');
  loadPlaces();
};

// ---------- 3) 新增 / 編輯 ----------
function initPickMap() {
  pickMap = L.map('pick-map').setView(TAIWAN, 7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap',
  }).addTo(pickMap);
  pickMap.on('click', e => setPick(e.latlng.lat, e.latlng.lng));
  // 收合區展開時，地圖才有尺寸，需重算（外層分區與內層「其他資料」都要）
  const resizePick = e => {
    if (!e.target.open) return;
    setTimeout(() => {
      pickMap.invalidateSize();
      if (pickMarker) pickMap.setView(pickMarker.getLatLng(), 14);
    }, 60);
  };
  $('#more-fields').addEventListener('toggle', resizePick);
  $('#sec-full').addEventListener('toggle', resizePick);
}

function setPick(lat, lon) {
  const form = $('#place-form');
  form.lat.value = Number(lat).toFixed(6);
  form.lon.value = Number(lon).toFixed(6);
  if (pickMarker) pickMarker.setLatLng([lat, lon]);
  else pickMarker = L.marker([lat, lon]).addTo(pickMap);
}

document.querySelector('[name="review"]').addEventListener('input', e => {
  $('#review-count').textContent = e.target.value.length;
});

// 選照片時即時預覽
document.querySelector('[name="image"]').addEventListener('change', e => {
  const file = e.target.files[0];
  const prev = $('#image-preview');
  if (file) { prev.src = URL.createObjectURL(file); prev.hidden = false; removeImageFlag = false; }
  else { prev.hidden = true; prev.removeAttribute('src'); }
  $('#btn-remove-image').hidden = prev.hidden;
});

// 移除照片：清掉已選檔案與預覽；編輯模式下存檔時會清空 image_url 並刪除舊圖檔
$('#btn-remove-image').addEventListener('click', () => {
  $('#place-form').image.value = '';
  removeImageFlag = true;
  const prev = $('#image-preview');
  prev.hidden = true;
  prev.removeAttribute('src');
  $('#btn-remove-image').hidden = true;
});

$('#place-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const rec = {
    name: f.name.value.trim(),
    lat: parseFloat(f.lat.value),
    lon: parseFloat(f.lon.value),
    review: f.review.value.trim() || null,
    rating: f.rating.value === '' ? null : parseFloat(f.rating.value),
    google_rating: f.google_rating.value === '' ? null : parseFloat(f.google_rating.value),
    google_url: f.google_url.value.trim() || null,
    visited_at: f.visited_at.value ? new Date(f.visited_at.value).toISOString() : null,
    category: f.category.value.trim() || null,
    is_restaurant: f.is_restaurant.checked,
    is_closed: f.is_closed.checked,
  };
  if (!rec.name || isNaN(rec.lat) || isNaN(rec.lon)) {
    $('#more-fields').open = true;   // 必填欄在收合區，展開讓使用者看到
    setTimeout(() => pickMap.invalidateSize(), 50);
    return toast('店名、緯度、經度為必填（在「其他資料」裡）', true);
  }

  // 照片：有選新檔就上傳；編輯時沒選新檔則沿用舊圖；按過「移除照片」則清空
  const file = f.image.files[0];
  const oldUrl = editingId ? (places.find(x => x.id === editingId)?.image_url ?? null) : null;
  rec.image_url = removeImageFlag ? null : oldUrl;
  if (file) {
    const btn = $('#submit-btn');
    btn.disabled = true; btn.textContent = '上傳圖片中…';
    try { rec.image_url = await uploadImage(file); }
    catch (err) { btn.disabled = false; return toast('圖片上傳失敗：' + err.message, true); }
    btn.disabled = false;
  }

  let error;
  if (editingId) {
    ({ error } = await sb.from(TABLE).update(rec).eq('id', editingId));  // 編輯保留原建立者
  } else {
    ({ error } = await sb.from(TABLE).insert({ ...rec, author: currentUser() }));
  }
  if (error) return toast('儲存失敗：' + error.message, true);
  // 照片被移除或替換：把舊的原圖 + 縮圖從 Storage 刪掉，避免佔空間
  if (oldUrl && rec.image_url !== oldUrl) removeStoredImage(oldUrl);
  toast(editingId ? '已更新' : '已新增');
  resetForm();
  await loadPlaces();
  showView('list');
});

function resetForm() {
  const f = $('#place-form');
  f.reset();
  editingId = null;
  $('#review-count').textContent = '0';
  $('#form-title').textContent = '新增一個地點';
  $('#submit-btn').textContent = '儲存地點';
  $('#submit-btn').disabled = false;
  $('#cancel-edit').hidden = true;
  $('#image-preview').hidden = true;
  $('#image-preview').removeAttribute('src');
  $('#btn-remove-image').hidden = true;
  removeImageFlag = false;
  $('#place-form').classList.remove('editing');   // 回到新增模式（完整展開）
  $('#rating-row').prepend($('#rating-field'));    // 我的星等回到與 Google 星等同列
  $('#more-fields').open = true;
  if (pickMarker) { pickMap.removeLayer(pickMarker); pickMarker = null; }
  exitPickMode();
}

// ---------- 從大地圖選座標 ----------
function enterPickMode() {
  pickModeActive = true;
  showView('map');
  $('#map').classList.add('pick-mode');
  $('#pick-mode-bar').hidden = false;
  $('#btn-locate').style.display = 'none';
}
function exitPickMode() {
  pickModeActive = false;
  $('#map').classList.remove('pick-mode');
  $('#pick-mode-bar').hidden = true;
  $('#btn-locate').style.display = '';
}

function initPickMode() {
  mainMap.on('click', e => {
    if (!pickModeActive) return;
    setPick(e.latlng.lat, e.latlng.lng);
    if (pickMap) {
      pickMap.setView([e.latlng.lat, e.latlng.lng], 14);
      setTimeout(() => pickMap.invalidateSize(), 50);
    }
    toast(`已選擇座標：${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`);
    exitPickMode();
    showView('add');
  });
  $('#btn-pick-main').addEventListener('click', enterPickMode);
  $('#pick-mode-cancel').addEventListener('click', () => { exitPickMode(); showView('add'); });
}

window.editPlace = async function (id) {
  const p = places.find(x => x.id === id);
  if (!p) return;
  if (!(await unlockAdd())) return;          // 編輯也需要密碼
  const f = $('#place-form');
  f.name.value = p.name ?? '';
  f.lat.value = p.lat ?? '';
  f.lon.value = p.lon ?? '';
  f.review.value = p.review ?? '';
  f.rating.value = p.rating ?? '';
  f.google_rating.value = p.google_rating ?? '';
  f.google_url.value = p.google_url ?? '';
  f.visited_at.value = toLocalInput(p.visited_at);
  f.category.value = p.category ?? '';
  f.is_restaurant.checked = p.is_restaurant !== false;   // null/undefined 視為餐廳
  f.is_closed.checked = p.is_closed === true;
  f.image.value = '';
  removeImageFlag = false;
  const prev = $('#image-preview');
  if (p.image_url) { prev.src = p.image_url; prev.hidden = false; }
  else { prev.hidden = true; prev.removeAttribute('src'); }
  $('#btn-remove-image').hidden = prev.hidden;
  $('#review-count').textContent = (p.review ?? '').length;
  editingId = id;
  f.classList.add('editing');        // 編輯模式：評價類置頂、其他資料收合
  $('#rating-slot').appendChild($('#rating-field'));   // 我的星等搬到置頂
  $('#more-fields').open = false;
  $('#sec-full').open = true;        // 編輯一定要看得到表單
  $('#sec-quick').open = false;
  $('#form-title').textContent = `編輯：${p.name}`;
  $('#submit-btn').textContent = '更新地點';
  $('#cancel-edit').hidden = false;
  closeDetail();
  showView('add');
  if (p.lat != null && p.lon != null) {
    setTimeout(() => { setPick(p.lat, p.lon); pickMap.setView([p.lat, p.lon], 14); }, 100);
  }
};
$('#cancel-edit').addEventListener('click', resetForm);

// ---------- Google URL 自動填入按鈕 ----------
$('#btn-parse-url').addEventListener('click', async () => {
  const form = $('#place-form');
  const url = form.google_url.value.trim();
  const hint = $('#url-parse-hint');
  hint.hidden = true;

  if (!url) { hint.textContent = '請先貼上 Google Maps 網址'; hint.hidden = false; return; }

  let textToParse = url;
  const isShort = /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\//i.test(url);

  // 短網址：透過 CORS proxy 取得重導向後的完整網址
  if (isShort) {
    hint.textContent = '正在解析短網址…'; hint.hidden = false;
    const { textToParse: resolved, error } = await resolveShortUrl(url);
    if (error || !resolved) {
      await enqueueFailedUrl(url, '展開短網址失敗：' + (error ? error.message : '未知錯誤'));
      loadQueue();
      hint.textContent = '短網址解析失敗，已加入待處理佇列，可稍後手動處理（或現在自行輸入座標）。';
      hint.hidden = false;
      toast('已加入待處理佇列');
      return;
    }
    textToParse = resolved;
  }

  const parsed = parseGoogleUrl(textToParse);
  const filled = [];

  if (parsed.lat != null && parsed.lon != null && !isNaN(parsed.lat) && !isNaN(parsed.lon)) {
    form.lat.value = parsed.lat.toFixed(6);
    form.lon.value = parsed.lon.toFixed(6);
    setPick(parsed.lat, parsed.lon);
    if (pickMap) pickMap.setView([parsed.lat, parsed.lon], 14);
    filled.push('座標');
  }

  if (parsed.name && !form.name.value.trim()) {
    form.name.value = parsed.name;
    filled.push('店名');
  }

  if (filled.length) {
    hint.textContent = `已自動填入：${filled.join('、')}`;
    hint.hidden = false;
    toast(`已從網址帶入${filled.join('、')}`);
  } else if (isShort) {
    await enqueueFailedUrl(url, '已展開網址但無法擷取座標');
    loadQueue();
    hint.textContent = '短網址已展開，但無法擷取座標，已加入待處理佇列，可稍後手動處理。';
    hint.hidden = false;
    toast('已加入待處理佇列');
  } else {
    hint.textContent = '無法從此網址擷取座標，請確認是 Google Maps 網址';
    hint.hidden = false;
  }
});

// ---------- 快速登錄（時間 + 短網址 + 備註 → pending 表）----------
// 在外面吃完先記一筆，之後把清單複製給 LLM 補齊資料，再由 LLM 寫進 places。
// 這裡刻意「不」解析短網址（不呼叫 resolveShortUrl），原樣存、原樣複製。
const PENDING_TABLE = CFG.pendingTable || 'pending_places';
let pendingRows = [];

// datetime-local 要的是本地時間字串 YYYY-MM-DDTHH:mm（toISOString 是 UTC，不能直接用）
function nowLocalInput() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 複製給 LLM 用的時間格式：YYYY-MM-DD HH:mm（本地時區）
function fmtLocalStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 展開「快速登錄」時才帶時間、載清單（收合時不打 API）
$('#sec-quick').addEventListener('toggle', () => {
  if (!$('#sec-quick').open) return;
  $('#quick-form').visited_at.value = nowLocalInput();   // 每次展開都帶到「現在」
  loadPending();
});

async function loadPending() {
  const { data, error } = await sb.from(PENDING_TABLE)
    .select('*')
    .order('visited_at', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) {
    toast('讀取待處理失敗：' + error.message, true);
    console.error(error);
    return;
  }
  pendingRows = data || [];
  renderPending();
}

function renderPending() {
  $('#pending-count').textContent = pendingRows.length;
  // 一行一筆，直接可全選複製；不換行（wrap=off），長網址橫向捲動
  $('#pending-board').value = pendingCopyText();
}

$('#quick-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const url = f.google_url.value.trim();
  if (!url) return toast('請貼上 Google 短網址', true);
  const rec = {
    visited_at: f.visited_at.value ? new Date(f.visited_at.value).toISOString() : new Date().toISOString(),
    google_url: url,
    note: f.note.value.trim() || null,
    author: currentUser(),
  };
  const btn = $('#quick-submit');
  btn.disabled = true;
  const { error } = await sb.from(PENDING_TABLE).insert(rec);
  btn.disabled = false;
  if (error) return toast('登錄失敗：' + error.message, true);
  toast('已登錄，等待處理');
  f.google_url.value = '';
  f.note.value = '';
  f.visited_at.value = nowLocalInput();   // 下一筆一樣預設現在
  await loadPending();
});

// 複製格式：每行一筆「時間 | 短網址 | 備註」（沒備註就只有兩段）
function pendingCopyText() {
  return pendingRows.map(r => {
    const parts = [fmtLocalStamp(r.visited_at), r.google_url];
    if (r.note) parts.push(r.note);
    return parts.join(' | ');
  }).join('\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 非 https 或舊瀏覽器：退回隱藏 textarea + execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

$('#pending-board').addEventListener('focus', e => e.target.select());
$('#pending-board').addEventListener('click', e => e.target.select());

$('#pending-copy').addEventListener('click', async () => {
  if (!pendingRows.length) return toast('目前沒有待處理資料', true);
  const ok = await copyText(pendingCopyText());
  toast(ok ? `已複製 ${pendingRows.length} 筆` : '複製失敗，請手動選取', !ok);
});

// 清空全部：兩段確認，只刪目前清單上看到的這些 id（避免誤刪剛剛才新增的）
$('#pending-clear').addEventListener('click', async () => {
  if (!pendingRows.length) return toast('目前沒有待處理資料', true);
  const n = pendingRows.length;
  if (!confirm(`要清空全部 ${n} 筆待處理資料嗎？`)) return;
  if (!confirm(`最後確認：這 ${n} 筆會直接從資料庫刪除，無法復原。確定要清空？`)) return;
  const btn = $('#pending-clear');
  btn.disabled = true;
  const { error } = await sb.from(PENDING_TABLE).delete().in('id', pendingRows.map(r => r.id));
  btn.disabled = false;
  if (error) return toast('清空失敗：' + error.message, true);
  toast(`已清空 ${n} 筆`);
  await loadPending();
});

// ---------- 首次進入彈窗（尋人啟事風格）----------
// 每位使用者第一次進入網頁都會看到，點「確認」後記住不再跳出。
// done() 會在彈窗關閉後（或不需顯示時）呼叫，接著才跑改名等流程。
function initPoster(done) {
  const SEEN_KEY = 'ashan_poster_seen';
  let seen = false;
  try { seen = localStorage.getItem(SEEN_KEY) === '1'; } catch { /* 隱私模式等 */ }
  if (seen) { done(); return; }

  const modal = $('#poster-modal');
  modal.hidden = false;
  $('#poster-confirm').addEventListener('click', () => {
    modal.hidden = true;
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* 忽略 */ }
    done();
  }, { once: true });
}

// ---------- 啟動 ----------
// 先讓地圖等背景就緒，彈窗確認後才問使用者名字（避免 prompt 蓋住彈窗）
initMainMap();
initLocateBtn();
initPickMode();
initPickMap();
loadPlaces();
initPoster(initUserName);
