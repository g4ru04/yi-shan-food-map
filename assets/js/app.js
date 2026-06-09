// ============================================================
//  阿珊的美食地圖 - 主程式
// ============================================================
const CFG = window.SUPABASE_CONFIG;
const sb = supabase.createClient(CFG.url, CFG.key);
const TABLE = CFG.table || 'places';
const TAIWAN = [23.97, 120.97];

let places = [];
let mainMap, markerLayer;
let pickMap, pickMarker;
let editingId = null;
let pendingImport = null;

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
  return new Date(iso).toLocaleString('zh-TW', { hour12: false });
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
$$('.nav-btn').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

// ---------- 讀取資料 ----------
async function loadPlaces() {
  const { data, error } = await sb.from(TABLE)
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    toast('讀取失敗：' + error.message, true);
    console.error(error);
    return;
  }
  places = data || [];
  $('#count-badge').textContent = `${places.length} 筆紀錄`;
  renderMap();
  renderList();
}

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
  places.forEach(p => {
    if (p.lat == null || p.lon == null) return;
    const m = L.marker([p.lat, p.lon]);
    m.bindPopup(`
      <div class="popup-name">${esc(p.name)}</div>
      <div class="popup-meta">我的 ${p.rating ?? '—'}★ · Google ${p.google_rating ?? '—'}★</div>
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
    <h3>${esc(p.name)}</h3>
    <div class="pc-meta">
      ${stars(p.rating)} 我的　${stars(p.google_rating, 'g')} Google
      <span>🕑 ${fmtDate(p.created_at)}</span>
    </div>
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
  if (!places.length) {
    c.innerHTML = '<p class="hint">還沒有任何紀錄，去「新增 / 匯入」加第一筆吧！</p>';
    return;
  }
  c.innerHTML = places.map(p => `
    <div class="place-card">
      <div class="pc-main">
        <h3>${esc(p.name)}</h3>
        <div class="pc-meta">
          ${stars(p.rating)} 我的　${stars(p.google_rating, 'g')} Google
          <span>🕑 ${fmtDate(p.created_at)}</span>
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
  };
  if (!rec.name || isNaN(rec.lat) || isNaN(rec.lon)) {
    return toast('店名、緯度、經度為必填', true);
  }
  let error;
  if (editingId) {
    ({ error } = await sb.from(TABLE).update(rec).eq('id', editingId));
  } else {
    ({ error } = await sb.from(TABLE).insert(rec));
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
  $('#cancel-edit').hidden = true;
  if (pickMarker) { pickMap.removeLayer(pickMarker); pickMarker = null; }
}

window.editPlace = function (id) {
  const p = places.find(x => x.id === id);
  if (!p) return;
  const f = $('#place-form');
  f.name.value = p.name ?? '';
  f.lat.value = p.lat ?? '';
  f.lon.value = p.lon ?? '';
  f.review.value = p.review ?? '';
  f.rating.value = p.rating ?? '';
  f.google_rating.value = p.google_rating ?? '';
  f.google_url.value = p.google_url ?? '';
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
  { name: '阿珊牛肉麵', lat: 25.0330, lon: 121.5654, review: '湯頭濃郁，肉大塊！', rating: 4.5, google_rating: 4.2, google_url: 'https://maps.app.goo.gl/example' },
  { name: '巷口豆花', lat: 25.0410, lon: 121.5430, review: '古早味，便宜大碗', rating: 4, google_rating: 4.4, google_url: '' },
];
const FIELDS = ['name', 'lat', 'lon', 'review', 'rating', 'google_rating', 'google_url'];

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
  };
  return out;
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

// ---------- 啟動 ----------
initMainMap();
initPickMap();
loadPlaces();
