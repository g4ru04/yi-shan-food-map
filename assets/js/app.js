// ============================================================
//  阿珊的美食地圖 - 主程式
// ============================================================
const CFG = window.SUPABASE_CONFIG;
const sb = supabase.createClient(CFG.url, CFG.key);
const TABLE = CFG.table || 'places';
const BUCKET = CFG.bucket || 'place-photos';
const TAIWAN = [23.97, 120.97];

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

// 上傳圖片到 Supabase Storage，回傳公開網址
async function uploadImage(file) {
  const out = await compressImage(file);
  const ext = (out.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, out, {
    cacheControl: '3600', upsert: false, contentType: out.type,
  });
  if (error) throw error;
  return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

let places = [];
let mainMap, markerLayer;
let pickMap, pickMarker;
let editingId = null;
let pendingImport = null;
let onlyRestaurants = false;   // 篩選：只顯示餐廳

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
function parseDate(v) {
  if (!v) return null;
  const d = new Date(String(v).trim());
  return isNaN(d.getTime()) ? null : d.toISOString();
}

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

// ---------- 導覽 ----------
function showView(name) {
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'map' && mainMap) setTimeout(() => mainMap.invalidateSize(), 50);
  if (name === 'add' && pickMap) setTimeout(() => pickMap.invalidateSize(), 50);
}
$$('.nav-btn').forEach(b => b.addEventListener('click', async () => {
  // 進入「新增 / 匯入」頁需要密碼
  if (b.dataset.view === 'add' && !(await unlockAdd())) return;
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
function initUserName() {
  let name = getCookie('username');
  if (!name) {
    name = (prompt('歡迎！請輸入你的名字：') || '').trim() || '訪客';
    setCookie('username', name, 365);
  }
  renderGreeting(name);
}
// 點問候語可改名字
$('#greeting').addEventListener('click', () => {
  const name = (prompt('修改名字：', getCookie('username') || '') || '').trim();
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
  mainMap = L.map('map').setView(TAIWAN, 7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(mainMap);
  markerLayer = L.layerGroup().addTo(mainMap);
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
      <div class="popup-meta">我的 ${p.rating ?? '—'}★ · Google ${p.google_rating ?? '—'}★${p.author ? ` · ✍️ ${esc(p.author)}` : ''}</div>
      ${p.image_url ? `<img class="popup-img" src="${esc(p.image_url)}" alt="${esc(p.name)}" />` : ''}
      <button class="btn small primary" onclick="openDetail(${p.id})">看詳細</button>
    `);
    m.addTo(markerLayer);
    pts.push([p.lat, p.lon]);
  });
  if (pts.length) mainMap.fitBounds(pts, { padding: [50, 50], maxZoom: 15 });
}

// ---------- 詳細視窗 ----------
window.openDetail = function (id) {
  const p = places.find(x => x.id === id);
  if (!p) return;
  $('#detail-box').innerHTML = `
    <h3>${esc(p.name)}${p.category ? ` <span class="badge cat">${esc(p.category)}</span>` : ''}${p.is_restaurant === false ? ' <span class="badge">非餐廳</span>' : ''}${p.is_closed ? ' <span class="badge closed">已永久歇業</span>' : ''}</h3>
    <div class="pc-meta">
      ${stars(p.rating)} 我的　${stars(p.google_rating, 'g')} Google
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
      <button class="btn ghost" onclick="closeDetail()">關閉</button>
    </div>`;
  $('#detail-modal').hidden = false;
};
window.closeDetail = () => ($('#detail-modal').hidden = true);
$('#detail-modal').addEventListener('click', e => {
  if (e.target.id === 'detail-modal') closeDetail();
});

// ---------- 2) 列表 ----------
function renderList() {
  const c = $('#list-container');
  const list = visiblePlaces();
  if (!list.length) {
    c.innerHTML = `<p class="hint">${places.length ? '沒有符合「只顯示餐廳」的紀錄。' : '還沒有任何紀錄，去「新增 / 匯入」加第一筆吧！'}</p>`;
    return;
  }
  c.innerHTML = list.map(p => `
    <div class="place-card">
      ${p.image_url ? `<img class="pc-thumb" src="${esc(p.image_url)}" alt="${esc(p.name)}" onclick="openDetail(${p.id})" />` : ''}
      <div class="pc-main">
        <h3>${esc(p.name)}${p.category ? ` <span class="badge cat">${esc(p.category)}</span>` : ''}${p.is_closed ? ' <span class="badge closed">已永久歇業</span>' : ''}</h3>
        <div class="pc-meta">
          ${stars(p.rating)} 我的　${stars(p.google_rating, 'g')} Google
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
    </div>`).join('');
}

window.deletePlace = async function (id) {
  if (!confirm('確定要刪除這筆紀錄？')) return;
  const { error } = await sb.from(TABLE).delete().eq('id', id);
  if (error) return toast('刪除失敗：' + error.message, true);
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
  // 收合區展開時，地圖才有尺寸，需重算
  $('#more-fields').addEventListener('toggle', e => {
    if (e.target.open) setTimeout(() => {
      pickMap.invalidateSize();
      if (pickMarker) pickMap.setView(pickMarker.getLatLng(), 14);
    }, 60);
  });
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
  if (file) { prev.src = URL.createObjectURL(file); prev.hidden = false; }
  else { prev.hidden = true; prev.removeAttribute('src'); }
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

  // 照片：有選新檔就上傳；編輯時沒選新檔則沿用舊圖
  const file = f.image.files[0];
  if (editingId) rec.image_url = places.find(x => x.id === editingId)?.image_url ?? null;
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
  $('#more-fields').open = false;   // 其他資料區恢復收合
  if (pickMarker) { pickMap.removeLayer(pickMarker); pickMarker = null; }
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
  const prev = $('#image-preview');
  if (p.image_url) { prev.src = p.image_url; prev.hidden = false; }
  else { prev.hidden = true; prev.removeAttribute('src'); }
  $('#review-count').textContent = (p.review ?? '').length;
  editingId = id;
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

// ---------- 批次匯入 ----------
const SAMPLE = [
  { name: '阿珊牛肉麵', lat: 25.0330, lon: 121.5654, review: '湯頭濃郁，肉大塊！', rating: 4.5, google_rating: 4.2, google_url: 'https://maps.app.goo.gl/example', author: '阿珊', image_url: '', visited_at: '2026-06-07 17:00', category: '麵食', is_restaurant: true, is_closed: false },
  { name: '彩虹眷村', lat: 24.1339, lon: 120.6107, review: '拍照景點', rating: 4, google_rating: 4.3, google_url: '', author: '阿珊', image_url: '', visited_at: '', category: '景點', is_restaurant: false, is_closed: false },
];
const FIELDS = ['name', 'lat', 'lon', 'review', 'rating', 'google_rating', 'google_url', 'author', 'image_url', 'visited_at', 'category', 'is_restaurant', 'is_closed'];

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function toCSV(rows) {
  const head = FIELDS.join(',');
  const body = rows.map(r => FIELDS.map(k => {
    const v = r[k] ?? '';
    return /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
  }).join(',')).join('\n');
  return head + '\n' + body;
}

$('#download-sample').addEventListener('click', () =>
  download('美食地圖範例.csv', '﻿' + toCSV(SAMPLE), 'text/csv;charset=utf-8'));
$('#download-sample-json').addEventListener('click', () =>
  download('美食地圖範例.json', JSON.stringify(SAMPLE, null, 2), 'application/json'));

// 簡易 CSV 解析（支援引號內逗號 / 換行）
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(x => x !== ''));
}

function normalize(raw) {
  const out = {
    name: (raw.name ?? '').toString().trim(),
    lat: parseFloat(raw.lat),
    lon: parseFloat(raw.lon),
    review: (raw.review ?? '').toString().trim().slice(0, 500) || null,
    rating: raw.rating === '' || raw.rating == null ? null : parseFloat(raw.rating),
    google_rating: raw.google_rating === '' || raw.google_rating == null ? null : parseFloat(raw.google_rating),
    google_url: (raw.google_url ?? '').toString().trim() || null,
    author: (raw.author ?? '').toString().trim() || currentUser(),  // 沒填就用目前使用者
    image_url: (raw.image_url ?? '').toString().trim() || null,     // 匯入時填圖片網址即可
    visited_at: parseDate(raw.visited_at),                          // 造訪時間（可留空）
    category: (raw.category ?? '').toString().trim() || null,
    is_restaurant: parseBool(raw.is_restaurant),                    // 留空預設為餐廳
    is_closed: parseBool(raw.is_closed, false),                     // 留空預設未歇業
  };
  return out;
}

// 解析布林：空白用 dflt；false/0/否/no/n 視為 false，其餘視為 true
function parseBool(v, dflt = true) {
  const s = String(v ?? '').trim();
  if (s === '') return dflt;
  return !/^(false|0|否|no|n)$/i.test(s);
}

$('#import-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  let records = [];
  try {
    if (file.name.toLowerCase().endsWith('.json') || text.trim().startsWith('[')) {
      records = JSON.parse(text).map(normalize);
    } else {
      const rows = parseCSV(text);
      const header = rows.shift().map(h => h.trim().toLowerCase());
      records = rows.map(cols => {
        const obj = {};
        header.forEach((h, i) => (obj[h] = cols[i]));
        return normalize(obj);
      });
    }
  } catch (err) {
    return toast('檔案解析失敗：' + err.message, true);
  }
  const valid = records.filter(r => r.name && !isNaN(r.lat) && !isNaN(r.lon));
  const skipped = records.length - valid.length;
  pendingImport = valid;
  $('#import-preview').innerHTML =
    `讀到 <b>${records.length}</b> 筆，有效 <b>${valid.length}</b> 筆` +
    (skipped ? `，略過 ${skipped} 筆（缺名稱或座標）` : '') +
    (valid.length ? `<br>例：${esc(valid[0].name)}（${valid[0].lat}, ${valid[0].lon}）` : '');
  $('#import-confirm').hidden = valid.length === 0;
});

$('#import-confirm').addEventListener('click', async () => {
  if (!pendingImport || !pendingImport.length) return;
  $('#import-confirm').disabled = true;
  const { error } = await sb.from(TABLE).insert(pendingImport);
  $('#import-confirm').disabled = false;
  if (error) return toast('匯入失敗：' + error.message, true);
  toast(`成功匯入 ${pendingImport.length} 筆`);
  pendingImport = null;
  $('#import-preview').innerHTML = '';
  $('#import-confirm').hidden = true;
  $('#import-file').value = '';
  await loadPlaces();
  showView('list');
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
initPickMap();
loadPlaces();
initPoster(initUserName);
