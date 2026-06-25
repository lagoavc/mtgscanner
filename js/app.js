const SCRYFALL_API = 'https://api.scryfall.com';
const OCR_SPACE_API = 'https://api.ocr.space/parse/image';
const STORAGE_KEY = 'mtgscanner_cards';
const API_KEY_STORAGE = 'ocr_api_key';
const PRIVACY_KEY = 'privacy_accepted';
const PRICE_REFRESH_HOURS = 1;

let cards = [];
let pendingCard = null;
let lastPricing = null;
let editingIndex = -1;
let cameraStream = null;
let cameraStoppedForBattery = false;

const $ = id => document.getElementById(id);
const $$ = (sel, ctx = document) => ctx.querySelector(sel);
const $$$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function toast(msg, dur = 2500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), dur);
}

function openPanel(id) {
  $$$('.slide-panel.open').forEach(p => p.classList.remove('open'));
  const panel = $(id);
  panel.classList.remove('hidden');
  panel.classList.add('open');
  $('modal-overlay').classList.remove('hidden');
}

function closeAllPanels() {
  $$$('.slide-panel.open').forEach(p => p.classList.remove('open'));
  $('modal-overlay').classList.add('hidden');
  editingIndex = -1;
  if (cameraStoppedForBattery) startCamera();
}

function formatDate() {
  return new Date().toISOString().slice(0, 10);
}

// ─── API Key Management ─────────────────────────────────
function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE) || '';
}
function setApiKey(key) {
  localStorage.setItem(API_KEY_STORAGE, key);
}

// ─── Camera ──────────────────────────────────────────────
function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
    cameraStoppedForBattery = true;
  }
  $('video-camera').srcObject = null;
}

async function startCamera() {
  const video = $('video-camera');
  const errEl = $('camera-error');
  cameraStoppedForBattery = false;
  stopCamera();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    cameraStream = stream;
    video.srcObject = stream;
    await video.play();
    errEl.classList.add('hidden');
  } catch (e) {
    console.error('Camera error:', e);
    errEl.classList.remove('hidden');
  }
}

const initCamera = startCamera;

function capturePhoto() {
  const video = $('video-camera');
  if (!video.videoWidth) return null;
  const canvas = document.createElement('canvas');
  const maxDim = 2000;
  let w = video.videoWidth, h = video.videoHeight;
  if (w > maxDim || h > maxDim) {
    const scale = maxDim / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(video, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.92);
}

function cropRegion(imgData, topPct, heightPct) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      const sy = Math.round(img.height * topPct);
      const sh = Math.round(img.height * heightPct);
      c.width = img.width;
      c.height = sh;
      c.getContext('2d').drawImage(img, 0, sy, img.width, sh, 0, 0, img.width, sh);
      resolve(c.toDataURL('image/jpeg', 0.95));
    };
    img.onerror = () => reject(new Error('Falha ao carregar imagem'));
    img.src = imgData;
  });
}
function cropTop(imgData) { return cropRegion(imgData, 0, 0.25); }
function cropBottom(imgData) { return cropRegion(imgData, 0.5, 0.5); }

// ─── OCR (direct from browser) ────────────────────────────
async function ocrSpace(imageData, label) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('API key do OCR.space não configurada. Abra Ajuda > Definições.');
  }
  const body = new URLSearchParams();
  body.append('apikey', apiKey);
  body.append('base64Image', imageData);
  body.append('language', 'eng');
  body.append('isOverlayRequired', 'false');
  body.append('OCREngine', '2');
  body.append('filetype', 'jpg');

  const r = await fetch(OCR_SPACE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body
  });
  if (r.status === 403 || r.status === 429) {
    throw new Error('Limite do OCR.space atingido (10 requests/dia no free). Usa outra chave ou aguarda.');
  }
  if (!r.ok) throw new Error(`OCR.space HTTP ${r.status}`);

  const data = await r.json();
  if (data.IsErroredOnProcessing || data.ErrorMessage) {
    const msg = Array.isArray(data.ErrorMessage) ? data.ErrorMessage[0] : data.ErrorMessage || 'Erro no OCR.space';
    const msgLower = msg.toLowerCase();
    if (msgLower.includes('limit') || msgLower.includes('daily') || msgLower.includes('exceed')) {
      throw new Error('Limite diário do OCR.space atingido (10 requests/dia no plano free).');
    }
    throw new Error(msg);
  }
  let text = data.ParsedResults?.[0]?.ParsedText || '';
  text = text.replace(/\r/g, '');
  console.log(`[OCR ${label}]`, text.slice(0, 300));
  const parsed = parseOCROutput(text);
  logOcr(text, parsed);
  return parsed;
}

function normalizeNumber(n) {
  return n.replace(/[Oo]/g, '0').replace(/[Ll]/g, '1').replace(/[Ss]/g, '5');
}

function parseCollectorNumber(raw) {
  const m = raw.match(/^0*(\d+)\/?\d*$/);
  return m ? m[1] : raw;
}

// local dev only: logs OCR to server.py terminal
function logOcr(raw, parsed) {
  const u = window.location.href;
  if (u.startsWith('http://localhost') || u.startsWith('http://192.') || u.startsWith('http://10.') || u.startsWith('http://172.')) {
    fetch('/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw, name: parsed.name, number: parsed.number, set: parsed.set })
    }).catch(() => {});
  }
}

function parseOCROutput(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const result = { name: text, number: '', set: '' };
  if (lines.length === 0) return result;

  function looksLikeYear(n) {
    const y = parseInt(n, 10);
    return y >= 1990 && y <= 2030;
  }

  function collectNum(str) {
    // returns the FIRST number-like pattern found in str
    // priority: (rarity?)number/total  >  plain number (2+ digits, not a year)
    // rarity prefix = c/C/u/U/m/M/r/R
    // normalizeNumber is NOT used for matching — it would create spurious
    // digits from letters (O→0, S→5) and match "NICHOLAS" → "NICH0LA5".
    // Instead, raw digits are matched first, then normalized for output.
    const stripped = str.replace(/^[cCuumMrR]\s*/, '');
    let m = stripped.match(/(\d{1,4})\s*\/\s*(\d{1,4})/);
    if (m) return { num: normalizeNumber(m[1]) + '/' + normalizeNumber(m[2]), idx: m.index };
    const norm = normalizeNumber(stripped);
    m = norm.match(/(\d{1,4})\s*\/\s*(\d{1,4})/);
    if (m) return { num: m[1] + '/' + m[2], idx: m.index };
    m = stripped.match(/(\d{2,4})/);
    if (m && !looksLikeYear(m[1])) return { num: normalizeNumber(m[1]), idx: m.index };
    return null;
  }

  console.log('[parseOCROutput] lines:', lines);

  // Search the last 4 lines first (footer region), top-down
  // MTG footer order: collector-number (+set) ABOVE copyright line.
  // Bottom-up would hit copyright first (e.g. "C3020 Viacom" → "3020").
  const searchRange = Math.min(lines.length, 4);
  for (let i = lines.length - searchRange; i < lines.length; i++) {
    const line = lines[i];
    const cn = collectNum(line);
    if (!cn) continue;

    result.number = cn.num;
    break;
  }

  // Fallback: if no number found in footer, try all lines
  if (!result.number) {
    for (let i = 0; i < lines.length; i++) {
      const cn = collectNum(lines[i]);
      if (cn) { result.number = cn.num; break; }
    }
  }

  // Last resort: any 1+ digit sequence at all
  if (!result.number) {
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].replace(/^[cCuumMrR]\s*/, '');
      const m = stripped.match(/(\d+)/);
      if (m) { result.number = m[1]; break; }
    }
  }

  return result;
}

// ─── Scryfall API ─────────────────────────────────────────
async function searchMTGCard(name, set, number) {
  const parts = [];
  if (name) parts.push(name.replace(/["']/g, ''));
  if (set && set.length >= 2) parts.push(`set:${set}`);
  if (number) parts.push(`number:${parseCollectorNumber(number)}`);
  if (parts.length === 0) return [];
  const q = parts.join(' ');
  try {
    const r = await fetch(`${SCRYFALL_API}/cards/search?q=${encodeURIComponent(q)}&order=released&dir=desc`);
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`API error: ${r.status}`);
    const data = await r.json();
    return data.data || [];
  } catch (e) {
    console.error('API search error:', e);
    toast('Erro ao pesquisar carta');
    return [];
  }
}

async function searchCardByNumber(number) {
  const num = parseCollectorNumber(number);
  try {
    const r = await fetch(`${SCRYFALL_API}/cards/search?q=number:${num}&order=released&dir=desc`);
    if (r.status === 404) return [];
    if (!r.ok) return [];
    const data = await r.json();
    return data.data || [];
  } catch { return []; }
}

async function fetchCardBySetNumber(setCode, number) {
  try {
    const r = await fetch(`${SCRYFALL_API}/cards/${setCode.toLowerCase()}/${parseCollectorNumber(number)}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ─── Pricing ─────────────────────────────────────────────
function getPriceFromCard(card, foil) {
  if (!card || !card.prices) return null;
  return foil ? (card.prices.eur_foil || card.prices.usd_foil) : (card.prices.eur || card.prices.usd);
}

function getPriceLowFromCard(card, foil) {
  if (!card || !card.prices) return null;
  const p = foil ? (card.prices.usd_foil || card.prices.eur_foil) : (card.prices.usd || card.prices.eur);
  return p ? parseFloat(p) : null;
}

function updatePriceFromPricing(foil) {
  if (!lastPricing) return;
  const val = foil ? (lastPricing.prices?.eur_foil || lastPricing.prices?.usd_foil) : (lastPricing.prices?.eur || lastPricing.prices?.usd);
  if (val != null) {
    $('field-price').value = parseFloat(val).toFixed(2);
  }
}

// ─── HTML escape helper ───────────────────────────────────
function escapeHTML(val) {
  const s = String(val ?? '');
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── JSON Backup / Restore ────────────────────────────────
function exportJSON() {
  if (cards.length === 0) { toast('Lista vazia'); return; }
  const apiKey = getApiKey();
  const data = { version: '1.0.0', exportedAt: new Date().toISOString(), cards: cards };
  if (apiKey) data.ocrApiKey = apiKey;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mtgscanner_${formatDate()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('📥 Backup JSON exportado');
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      const imported = data.cards || (Array.isArray(data) ? data : []);
      if (!imported.length) { toast('Nenhuma carta encontrada no ficheiro'); return; }
      if (cards.length > 0) {
        if (confirm(`Já tens ${cards.length} cartas. OK = Substituir | Cancelar = Adicionar`)) {
          cards = imported;
        } else {
          cards = cards.concat(imported);
        }
      } else {
        cards = imported;
      }
      if (data.ocrApiKey) setApiKey(data.ocrApiKey);
      migrateCards();
      saveCards();
      renderCollection();
      toast(`✅ ${imported.length} carta(s) importada(s)`);
    } catch {
      toast('❌ Ficheiro JSON inválido');
    }
  };
  reader.readAsText(file);
}

// ─── Persistence & Migration ──────────────────────────────
function saveCards() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
}

function migrateCard(c) {
  if (c.image === undefined) c.image = '';
  if (c.setId === undefined) c.setId = '';
  if (c.priceUsd === undefined) c.priceUsd = null;
  if (c.priceEur === undefined) c.priceEur = null;
  if (c.priceFoilUsd === undefined) c.priceFoilUsd = null;
  if (c.priceFoilEur === undefined) c.priceFoilEur = null;
  if (c.lastPriceUpdate === undefined) c.lastPriceUpdate = null;
  return c;
}

function migrateCards() {
  cards = cards.map(migrateCard);
}

function loadCards() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    cards = stored ? JSON.parse(stored) : [];
    migrateCards();
  } catch {
    cards = [];
  }
}

// ─── Price Refresh ────────────────────────────────────────
function needsPriceRefresh(lastUpdate) {
  if (!lastUpdate) return true;
  const diff = Date.now() - new Date(lastUpdate).getTime();
  return diff > PRICE_REFRESH_HOURS * 60 * 60 * 1000;
}

async function refreshPrices() {
  const toRefresh = cards.filter(c => needsPriceRefresh(c.lastPriceUpdate) && c.setId && c.number);
  if (toRefresh.length === 0) return;

  console.log(`Refreshing prices for ${toRefresh.length} cards...`);
  const batchSize = 5;
  for (let i = 0; i < toRefresh.length; i += batchSize) {
    const batch = toRefresh.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(c => fetchCardBySetNumber(c.setId, c.number))
    );
    results.forEach((result, idx) => {
      if (result.status === 'fulfilled' && result.value) {
        const cardData = result.value;
        const cardIdx = cards.indexOf(batch[idx]);
        if (cardIdx >= 0) {
          cards[cardIdx].priceUsd = cardData.prices?.usd ? parseFloat(cardData.prices.usd) : null;
          cards[cardIdx].priceEur = cardData.prices?.eur ? parseFloat(cardData.prices.eur) : null;
          cards[cardIdx].priceFoilUsd = cardData.prices?.usd_foil ? parseFloat(cardData.prices.usd_foil) : null;
          cards[cardIdx].priceFoilEur = cardData.prices?.eur_foil ? parseFloat(cardData.prices.eur_foil) : null;
          cards[cardIdx].lastPriceUpdate = new Date().toISOString();
        }
      }
    });
    if (i + batchSize < toRefresh.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  saveCards();
  console.log('Price refresh complete');
}

// ─── Privacy ──────────────────────────────────────────────
function checkPrivacy() {
  if (!localStorage.getItem(PRIVACY_KEY)) {
    $('privacy-overlay').classList.remove('hidden');
  }
}

// ─── Sort ─────────────────────────────────────────────────
let sortKey = 'name-asc';

function sortCards() {
  const [field, dir] = sortKey.split('-');
  cards.sort((a, b) => {
    let cmp;
    if (field === 'name') {
      cmp = (a.name || '').localeCompare(b.name || '');
    } else if (field === 'price') {
      const pa = a.foil ? (a.priceEur ?? a.priceUsd ?? 0) : (a.priceEur ?? a.priceUsd ?? 0);
      const pb = b.foil ? (b.priceEur ?? b.priceUsd ?? 0) : (b.priceEur ?? b.priceUsd ?? 0);
      cmp = pa - pb;
    }
    return dir === 'desc' ? -cmp : cmp;
  });
}

$$$('.sort-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.sort === sortKey) return;
    sortKey = btn.dataset.sort;
    $$$('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === sortKey));
    sortCards();
    renderCollection();
  });
});

// ─── Collection UI ────────────────────────────────────────
function renderCollection() {
  sortCards();
  const grid = $('collection-grid');
  const empty = $('empty-msg');
  const header = $('list-content');

  grid.innerHTML = '';
  if (cards.length === 0) {
    empty.classList.remove('hidden');
    header.classList.add('hidden');
    $('count-badge').textContent = '0';
    return;
  }
  empty.classList.add('hidden');
  header.classList.remove('hidden');
  $('count-badge').textContent = cards.length;

  cards.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'card-tile';
    div.setAttribute('data-index', i);

    const imgSrc = c.image || '';
    const price = c.foil ? (c.priceEur ?? c.priceUsd) : (c.priceEur ?? c.priceUsd);
    const priceStr = price != null ? `€${price.toFixed(2)}` : '';
    const foilLabel = c.foil ? ' ✦ Foil' : '';

    div.innerHTML = `
      <div class="ct-img">${imgSrc ? `<img src="${imgSrc}" alt="${escapeHTML(c.name)}" loading="lazy">` : '<div class="ct-placeholder">?</div>'}</div>
      <div class="ct-info">
        <div class="ct-name">${escapeHTML(c.name)}</div>
        <div class="ct-meta">${escapeHTML(c.set)} ${escapeHTML(c.number)}</div>
        <div class="ct-price">${priceStr}${foilLabel}</div>
      </div>
    `;
    div.addEventListener('click', () => showCardDetail(i));
    grid.appendChild(div);
  });
}

function showCardDetail(index) {
  const c = cards[index];
  if (!c) return;

  $('dt-image').src = c.image || '';
  $('dt-name').textContent = c.name;
  $('dt-set').textContent = c.set;
  $('dt-number').textContent = c.number;
  $('dt-condition').textContent = c.condition;
  $('dt-language').textContent = c.language;
  $('dt-quantity').textContent = c.quantity;

  const foilLabel = c.foil ? 'Yes' : 'No';
  const foilDisplay = document.querySelector('#dt-foil-row');
  if (foilDisplay) foilDisplay.textContent = foilLabel;

  const userPrice = c.price ?? 0;
  const cmPrice = c.foil ? (c.priceEur ?? c.priceUsd) : (c.priceEur ?? c.priceUsd);
  const cmPriceStr = cmPrice != null ? `${cmPrice.toFixed(2)}` : '—';
  const currencySymbol = (c.foil ? (c.priceFoilEur ?? c.priceEur) : (c.priceEur ?? c.priceUsd)) ? '€' : '$';

  $('dt-user-price').innerHTML = `${currencySymbol}${userPrice.toFixed(2)}`;
  $('dt-cm-price').innerHTML = `${currencySymbol}${cmPriceStr}`;

  const lastUpd = c.lastPriceUpdate ? new Date(c.lastPriceUpdate).toLocaleString() : 'Nunca';
  $('dt-price-updated').textContent = lastUpd;

  $('detail-delete').dataset.index = index;
  $('detail-edit').dataset.index = index;

  openPanel('panel-detail');

  function updateDetailFromPricing(cardData) {
    if (!cardData || !cardData.prices) return;
    c.priceUsd = cardData.prices.usd ? parseFloat(cardData.prices.usd) : null;
    c.priceEur = cardData.prices.eur ? parseFloat(cardData.prices.eur) : null;
    c.priceFoilUsd = cardData.prices.usd_foil ? parseFloat(cardData.prices.usd_foil) : null;
    c.priceFoilEur = cardData.prices.eur_foil ? parseFloat(cardData.prices.eur_foil) : null;
    c.lastPriceUpdate = new Date().toISOString();
    saveCards();
    const nc = c.foil ? (c.priceEur ?? c.priceUsd) : (c.priceEur ?? c.priceUsd);
    $('dt-cm-price').innerHTML = nc != null ? `€${nc.toFixed(2)}` : '—';
    $('dt-price-updated').textContent = new Date(c.lastPriceUpdate).toLocaleString();
    renderCollection();
  }

  if (needsPriceRefresh(c.lastPriceUpdate) && c.setId && c.number) {
    fetchCardBySetNumber(c.setId, c.number).then(cardData => {
      if (cardData) updateDetailFromPricing(cardData);
    });
  }
}

$('dt-refresh-price').addEventListener('click', async () => {
  const c = cards[+$('detail-delete').dataset.index];
  if (!c || !c.setId || !c.number) { toast('Sem dados para pesquisar preço'); return; }
  toast('📡 A atualizar preço...');
  const cardData = await fetchCardBySetNumber(c.setId, c.number);
  if (cardData && cardData.prices) {
    c.priceUsd = cardData.prices.usd ? parseFloat(cardData.prices.usd) : null;
    c.priceEur = cardData.prices.eur ? parseFloat(cardData.prices.eur) : null;
    c.priceFoilUsd = cardData.prices.usd_foil ? parseFloat(cardData.prices.usd_foil) : null;
    c.priceFoilEur = cardData.prices.eur_foil ? parseFloat(cardData.prices.eur_foil) : null;
    c.lastPriceUpdate = new Date().toISOString();
    saveCards();
    const nc = c.foil ? (c.priceEur ?? c.priceUsd) : (c.priceEur ?? c.priceUsd);
    $('dt-cm-price').innerHTML = nc != null ? `€${nc.toFixed(2)}` : '—';
    $('dt-price-updated').textContent = new Date(c.lastPriceUpdate).toLocaleString();
    renderCollection();
    toast(`💰 Preço: ${nc != null ? `€${nc.toFixed(2)}` : '—'}`);
  } else {
    toast('❌ Não foi possível obter preço');
  }
});

function editCard(index) {
  const c = cards[index];
  if (!c) return;
  editingIndex = index;
  closeAllPanels();

  $('field-name').value = c.name;
  $('field-set').value = c.set;
  $('field-number').value = c.number;
  $('field-price').value = c.price.toFixed(2);
  $('field-qty').value = c.quantity;
  $('field-condition').value = c.condition;
  $('field-language').value = c.language;
  $('field-foil').checked = c.foil;
  $('search-results').classList.add('hidden');
  $('card-details').classList.remove('hidden');

  pendingCard = {
    name: c.name, set: c.set, number: c.number, image: c.image || ''
  };

  lastPricing = null;
  $('btn-add').textContent = '💾 Guardar Alterações';
  openPanel('panel-review');
}

// ─── Review Panel UI ───────────────────────────────────────
function clearReviewPanel() {
  $('field-name').value = '';
  $('field-set').value = '';
  $('field-number').value = '';
  $('field-price').value = '0.00';
  $('field-qty').value = '1';
  $('field-condition').value = 'NM';
  $('field-language').value = 'English';
  $('field-foil').checked = false;
  $('search-results').classList.add('hidden');
  $('search-results').innerHTML = '';
  $('card-details').classList.add('hidden');
  $('captured-img').src = '';
  pendingCard = null;
  lastPricing = null;
  editingIndex = -1;
  $('btn-add').textContent = '✅ Adicionar à Coleção';
}

function showReview(imageData) {
  $('captured-img').src = imageData;
  openPanel('panel-review');
}

// ─── Event Handlers ───────────────────────────────────────

// Capture with OCR
$('btn-capture').addEventListener('click', async () => {
  if (!getApiKey()) { toast('🔑 Configura a API key na Ajuda primeiro'); openPanel('panel-help'); return; }
  const imgData = capturePhoto();
  if (!imgData) { toast('Câmara não disponível'); return; }
  stopCamera();
  toast('📡 OCR em curso...');
  try {
    showReview(imgData);
    const ocr = await ocrSpace(imgData, 'FULL');
    if (ocr && ocr.name) {
      const lines = ocr.name.split('\n').map(l => l.trim()).filter(Boolean);
      for (const l of lines) {
        const clean = l.replace(/[^A-Za-zÀ-ÿ0-9\s\-'.,!]/g, '').trim();
        if (!clean || clean.length < 3 || /^\d+$/.test(clean) || /^[cCuumMrR]\d+$/.test(clean)) continue;
        if (clean.split(' ').length > 6) continue;
        $('field-name').value = clean;
        break;
      }
    }
    if (ocr && ocr.number) {
      $('field-number').value = ocr.number;
      searchByNumber(ocr.number, '', $('field-name').value);
      toast(`🔍 OCR: ${$('field-name').value || 'nº ' + ocr.number}`);
    } else if (ocr && !ocr.number) {
      toast('📄 OCR não encontrou nº de carta. Escreve o nome.');
    } else {
      toast('❌ OCR não respondeu. Escreve o nome manualmente.');
    }
  } catch (e) {
    toast(`⚠️ ${e.message}`);
  }
  $('field-name').focus();
});

// Fullscreen button (two-click fallback)
let fsFallbackTimer;
$('btn-fullscreen').addEventListener('click', () => {
  if (fsFallbackTimer) {
    clearTimeout(fsFallbackTimer);
    fsFallbackTimer = null;
    return;
  }
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen()
      .then(() => {})
      .catch(() => {
        fsFallbackTimer = setTimeout(() => { fsFallbackTimer = null; }, 3000);
        toast('Prima o botão de ecrã inteiro do seu navegador', 3000);
      });
  }
});
document.addEventListener('fullscreenchange', () => {
  const active = !!document.fullscreenElement;
  const btn = $('btn-fullscreen');
  if (active) {
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" fill="#fff"><path d="M8 3v3H3v2h5V3h2zm8 0v5h-2V5h-3V3h5zM3 16v-2h5v5H6v-3H3zm16-2h2v5h-5v-2h3v-3z"/></svg>';
  } else {
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" fill="#fff"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
  }
});

// File input fallback
$('file-input').addEventListener('change', async (e) => {
  if (!getApiKey()) { toast('🔑 Configura a API key na Ajuda primeiro'); openPanel('panel-help'); return; }
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    const imgData = ev.target.result;
    toast('📡 OCR em curso...');
    try {
      showReview(imgData);
      const [topOcr, bottomOcr] = await Promise.all([
        ocrSpace(await cropTop(imgData), 'TOP'),
        ocrSpace(await cropBottom(imgData), 'BOT')
      ]);
      const ocr = bottomOcr;
      const nameLines = (topOcr.name || '').split('\n').map(l => l.trim()).filter(Boolean);
      let cardName = '';
      for (const l of nameLines) {
        const clean = l.replace(/[^A-Za-zÀ-ÿ0-9\s\-'.]/g, '').trim();
        if (!clean || clean.length < 3 || /^\d+$/.test(clean) || /^[cCuumMrR]\d+$/.test(clean)) continue;
        if (clean.split(' ').length > 6) continue;
        cardName = clean;
        break;
      }
      if (cardName) $('field-name').value = cardName;
      if (ocr && ocr.number) {
        $('field-number').value = ocr.number;
        toast(`🔍 OCR: ${cardName || 'nº ' + ocr.number}`);
        searchByNumber(ocr.number, '', cardName);
      } else if (ocr && !ocr.number) {
        toast('📄 OCR não encontrou nº de carta. Escreve o nome.');
      } else {
        toast('❌ OCR não respondeu. Escreve o nome manualmente.');
      }
    } catch (e) {
      toast(`⚠️ ${e.message}`);
    }
    $('field-name').focus();
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

// Auto-suggest
let suggestTimeout = null;
$('field-name').addEventListener('input', () => {
  clearTimeout(suggestTimeout);
  const name = $('field-name').value.trim();
  if (name.length < 2) { $('search-results').classList.add('hidden'); return; }
  suggestTimeout = setTimeout(async () => {
    $('search-results').classList.remove('hidden');
    $('search-results').innerHTML = '<p style="color:var(--text2);padding:8px 0">A pesquisar...</p>';
    const results = await searchMTGCard(name, '', '');
    if (results.length === 0) {
      $('search-results').innerHTML = '<p style="color:var(--text2);padding:8px 0">Nenhum resultado</p>';
      return;
    }
    $('search-results').innerHTML = '';
    results.slice(0, 6).forEach(card => {
      const div = document.createElement('div');
      div.className = 'search-item';
      const imgUrl = card.image_uris?.small || (card.card_faces?.[0]?.image_uris?.small) || '';
      div.innerHTML = `
        <img src="${imgUrl}" alt="${card.name}" onerror="this.style.display='none'">
        <div class="si-info">
          <div class="si-name">${card.name} <span style="color:var(--accent2);font-size:11px">${card.collector_number || ''}</span></div>
          <div class="si-meta">${card.set_name || ''}</div>
        </div>
      `;
      div.addEventListener('click', () => { selectCard(card); });
      $('search-results').appendChild(div);
    });
  }, 350);
});

// Search by number
async function searchByNumber(number, setCode, cardName) {
  const resultsEl = $('search-results');
  resultsEl.classList.remove('hidden');
  resultsEl.innerHTML = '<p style="color:var(--text2);padding:8px 0">🔍 A pesquisar...</p>';
  let cardsRes = [];

  if (setCode && number) {
    const card = await fetchCardBySetNumber(setCode, number);
    if (card) cardsRes = [card];
  }

  if (cardsRes.length === 0 && cardName) {
    const q = `${cardName} number:${parseCollectorNumber(number)}`;
    try {
      const r = await fetch(`${SCRYFALL_API}/cards/search?q=${encodeURIComponent(q)}`);
      if (r.ok) cardsRes = (await r.json()).data || [];
    } catch {}
  }

  if (cardsRes.length === 0) {
    cardsRes = await searchCardByNumber(number);
  }

  if (cardsRes.length === 0) {
    resultsEl.innerHTML = '<p style="color:var(--text2);padding:8px 0">Nenhum resultado para este número</p>';
    return;
  }
  resultsEl.innerHTML = '';
  cardsRes.slice(0, 8).forEach(card => {
    const div = document.createElement('div');
    div.className = 'search-item';
    const imgUrl = card.image_uris?.small || (card.card_faces?.[0]?.image_uris?.small) || '';
    div.innerHTML = `
      <img src="${imgUrl}" alt="${card.name}" onerror="this.style.display='none'">
      <div class="si-info">
        <div class="si-name">${card.name} <span style="color:var(--accent2)">${card.collector_number || ''}</span></div>
        <div class="si-meta">${card.set_name || ''} ${card.rarity ? '• ' + card.rarity : ''}</div>
      </div>
    `;
    div.addEventListener('click', () => { selectCard(card); });
    resultsEl.appendChild(div);
  });
}

// Search button
$('btn-search').addEventListener('click', async () => {
  const name = $('field-name').value.trim();
  const set = $('field-set').value.trim();
  const number = $('field-number').value.trim();
  const resultsEl = $('search-results');
  if (!name && !number) { toast('Preencha o nome ou número da carta'); return; }
  resultsEl.innerHTML = '<p style="color:var(--text2)">A pesquisar...</p>';
  resultsEl.classList.remove('hidden');
  let results;
  if (number && !name) {
    results = await searchCardByNumber(number);
  } else {
    results = await searchMTGCard(name, set, number);
  }
  if (results.length === 0) {
    resultsEl.innerHTML = '<p style="color:var(--text2);padding:12px 0">Nenhum resultado. Tente outro nome.</p>';
    return;
  }
  resultsEl.innerHTML = '';
  results.forEach(card => {
    const div = document.createElement('div');
    div.className = 'search-item';
    const imgUrl = card.image_uris?.small || (card.card_faces?.[0]?.image_uris?.small) || '';
    div.innerHTML = `
      <img src="${imgUrl}" alt="${card.name}" onerror="this.style.display='none'">
      <div class="si-info">
        <div class="si-name">${card.name} <span style="color:var(--accent2);font-size:11px">${card.collector_number || ''}</span></div>
        <div class="si-meta">${card.set_name || ''} ${card.rarity ? '• ' + card.rarity : ''}</div>
      </div>
    `;
    div.addEventListener('click', () => { selectCard(card); });
    resultsEl.appendChild(div);
  });
});

function selectCard(card) {
  $('field-name').value = card.name;
  $('field-set').value = card.set_name || '';
  $('field-number').value = card.collector_number || '';
  $('search-results').innerHTML = `<p style="color:var(--accent2);padding:8px 0">✅ Carta selecionada: ${card.name}</p>`;

  const imgUrl = card.image_uris?.large || card.image_uris?.small || (card.card_faces?.[0]?.image_uris?.large) || '';
  const setId = card.set?.toLowerCase() || (card.set_id || '');

  pendingCard = {
    name: card.name,
    set: card.set_name || '',
    number: card.collector_number || '',
    image: imgUrl,
    setId: card.set?.toLowerCase() || '',
  };

  $('card-details').classList.remove('hidden');

  lastPricing = card;
  const foil = $('field-foil').checked;
  const val = foil ? (card.prices?.eur_foil || card.prices?.usd_foil) : (card.prices?.eur || card.prices?.usd);
  if (val != null) {
    $('field-price').value = parseFloat(val).toFixed(2);
    toast(`💰 Preço: ${parseFloat(val).toFixed(2)}`);
  }
}

$('field-foil').addEventListener('change', () => {
  updatePriceFromPricing($('field-foil').checked);
});

// Add / Save card
$('btn-add').addEventListener('click', () => {
  const name = $('field-name').value.trim();
  if (!name) { toast('Nome da carta é obrigatório'); return; }

  const card = {
    name: name,
    set: $('field-set').value.trim(),
    number: $('field-number').value.trim(),
    condition: $('field-condition').value,
    language: $('field-language').value,
    price: parseFloat($('field-price').value) || 0,
    quantity: parseInt($('field-qty').value) || 1,
    foil: $('field-foil').checked,
    comments: '',
    addedAt: new Date().toISOString(),
    image: pendingCard?.image || '',
    setId: pendingCard?.setId || '',
    priceUsd: lastPricing?.prices?.usd ? parseFloat(lastPricing.prices.usd) : null,
    priceEur: lastPricing?.prices?.eur ? parseFloat(lastPricing.prices.eur) : null,
    priceFoilUsd: lastPricing?.prices?.usd_foil ? parseFloat(lastPricing.prices.usd_foil) : null,
    priceFoilEur: lastPricing?.prices?.eur_foil ? parseFloat(lastPricing.prices.eur_foil) : null,
    lastPriceUpdate: lastPricing ? new Date().toISOString() : null
  };

  if (editingIndex >= 0 && editingIndex < cards.length) {
    card.addedAt = cards[editingIndex].addedAt;
    card.comments = cards[editingIndex].comments;
    card.image = card.image || cards[editingIndex].image;
    card.setId = card.setId || cards[editingIndex].setId;
    cards[editingIndex] = card;
    toast(`✏️ "${name}" atualizada`);
  } else {
    cards.push(card);
    toast(`✅ "${name}" adicionada à coleção`);
  }

  saveCards();
  renderCollection();
  closeAllPanels();
  clearReviewPanel();
});

// Navigation
$('btn-list').addEventListener('click', () => {
  renderCollection();
  openPanel('panel-list');
});

$('close-review').addEventListener('click', () => {
  closeAllPanels();
  clearReviewPanel();
});
$('close-list').addEventListener('click', closeAllPanels);
$('close-detail').addEventListener('click', closeAllPanels);
$('modal-overlay').addEventListener('click', closeAllPanels);

$('btn-scan-more').addEventListener('click', () => {
  closeAllPanels();
  clearReviewPanel();
});

// Detail panel actions
$('detail-edit').addEventListener('click', () => {
  const idx = parseInt($('detail-edit').dataset.index);
  if (!isNaN(idx)) editCard(idx);
});

$('detail-delete').addEventListener('click', () => {
  const idx = parseInt($('detail-delete').dataset.index);
  if (isNaN(idx)) return;
  if (confirm(`Remover "${cards[idx]?.name}" da coleção?`)) {
    cards.splice(idx, 1);
    saveCards();
    renderCollection();
    closeAllPanels();
    toast('🗑️ Carta removida');
  }
});

// Clear collection
$('btn-clear').addEventListener('click', () => {
  if (cards.length === 0) return;
  if (confirm('Tem a certeza? Todas as cartas serão removidas.')) {
    cards = [];
    saveCards();
    renderCollection();
    toast('Coleção limpa');
  }
});

// Help
$('btn-help').addEventListener('click', () => {
  $('input-api-key').value = getApiKey();
  $('api-key-status').classList.add('hidden');
  openPanel('panel-help');
});
$('close-help').addEventListener('click', closeAllPanels);

$('btn-save-key').addEventListener('click', () => {
  const key = $('input-api-key').value.trim();
  if (!key) { toast('Insere uma API key válida'); return; }
  setApiKey(key);
  const status = $('api-key-status');
  status.classList.remove('hidden');
  status.textContent = '✅ API key guardada com sucesso!';
  status.style.color = 'var(--accent2)';
  toast('🔑 API key do OCR.space guardada');
});

// Privacy
$('btn-accept-privacy').addEventListener('click', () => {
  localStorage.setItem(PRIVACY_KEY, 'true');
  $('privacy-overlay').classList.add('hidden');
});

// JSON export/import
$('btn-export-json').addEventListener('click', exportJSON);
['file-import-json', 'file-import-json-empty'].forEach(id => {
  $(id).addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) importJSON(file);
    e.target.value = '';
  });
});

// Load version
fetch('version.json')
  .then(r => r.json())
  .then(v => { const el = $('app-version'); if (el) el.textContent = v.version; })
  .catch(() => {});

// ─── Init ─────────────────────────────────────────────────
async function init() {
  loadCards();
  renderCollection();
  checkPrivacy();

  if (!getApiKey()) {
    setTimeout(() => toast('🔑 Configura a API key do OCR.space na Ajuda', 4000), 1500);
  }

  await initCamera();

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      console.log('SW registered');
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
            console.log('New SW installed, reloading...');
            window.location.reload();
          }
        });
      });
    } catch (e) {
      console.log('SW registration failed:', e);
    }
  }

  console.log('MTGScanner ready');
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type === 'SW_UPDATED') {
      console.log('SW updated, reloading...');
      window.location.reload();
    }
  });
}

init();
