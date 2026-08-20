'use strict';

const APP_VERSION = '0.13.1-secure';
const DB_NAME = 'research-talk-trainer-mobile';
const DB_VERSION = 1;
const STORE_MATERIALS = 'materials';
const BUNDLED_INDEX = 'materials/index.json';

// Security limits for imported material ZIPs. Keep these conservative for phones.
const MAX_ZIP_BYTES = 50 * 1024 * 1024;          // 50 MB compressed
const MAX_ZIP_FILES = 250;
const MAX_SELECTED_ZIPS = 5;
const MAX_SELECTED_ZIP_BYTES = 100 * 1024 * 1024; // 100 MB per import operation
const MAX_MATERIALS_PER_ZIP = 10;
const MAX_DECLARED_UNCOMPRESSED_BYTES = 120 * 1024 * 1024; // 120 MB total
const MAX_ASSET_BYTES = 15 * 1024 * 1024;        // 15 MB per image
const MAX_JSON_BYTES = 2 * 1024 * 1024;           // 2 MB material JSON
const MAX_ITEMS = 500;
const MAX_CHUNKS_PER_ITEM = 24;
const ALLOWED_ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const ALLOWED_ITEM_TYPES = new Set(['text', 'figure', 'table', 'equation']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;


const state = {
  db: null,
  bundled: [],
  imported: [],
  material: null,
  materialSource: null,
  assetUrls: [],
  filtered: [],
  itemIndex: 0,
  mode: 'chunk',
  variantLevel: 2,
  recallIndex: 0,
  recallRevealed: false,
  deferredInstallPrompt: null,
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function markdownBoldToHtml(text) {
  const safe = escapeHtml(text ?? '');
  return safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}


function assertImport(condition, message) {
  if (!condition) throw new Error(message);
}

function utf8ByteLength(text) {
  return new TextEncoder().encode(String(text ?? '')).byteLength;
}

function ensureSafeZipPath(name) {
  const value = String(name || '');
  assertImport(value.length > 0 && value.length <= 500, 'ZIP内に不正なファイル名があります。');
  assertImport(!value.includes('\\'), `ZIP内のパスに\\は使用できません: ${value}`);
  assertImport(!value.startsWith('/') && !/^[A-Za-z]:/.test(value), `絶対パスは使用できません: ${value}`);
  assertImport(!value.includes('\\0'), `不正なパスです: ${value}`);
  const parts = value.split('/');
  assertImport(!parts.some(part => part === '..' || part === '.'), `相対パス移動は使用できません: ${value}`);
  return value;
}

function fileExtension(path) {
  const name = String(path || '').toLowerCase();
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index) : '';
}

function validateAssetPath(path) {
  const value = ensureSafeZipPath(path.replace(/^\.\//, ''));
  assertImport(value.startsWith('assets/'), `画像パスは assets/ 配下にしてください: ${value}`);
  assertImport(ALLOWED_ASSET_EXTENSIONS.has(fileExtension(value)), `未許可の画像形式です: ${value}`);
  return value;
}

function validateTextField(value, name, maxLength, required = false) {
  if (value == null || value === '') {
    assertImport(!required, `${name} は必須です。`);
    return;
  }
  assertImport(typeof value === 'string', `${name} は文字列である必要があります。`);
  assertImport(value.length <= maxLength, `${name} が長すぎます。`);
}

function validateMaterialJson(json) {
  assertImport(json && typeof json === 'object' && !Array.isArray(json), 'material_v08.json の形式が不正です。');
  assertImport(String(json.material_version) === '0.8', 'material_version は 0.8 である必要があります。');
  validateTextField(json.material_id, 'material_id', 100, true);
  assertImport(SAFE_ID.test(json.material_id), 'material_id は英数字・._-のみ使用できます。');
  validateTextField(json.title, 'title', 500, true);
  validateTextField(json.source_pdf, 'source_pdf', 500, false);
  validateTextField(json.builder, 'builder', 100, false);
  validateTextField(json.training_goal, 'training_goal', 5000, false);

  assertImport(Array.isArray(json.items), 'items は配列である必要があります。');
  assertImport(json.items.length > 0 && json.items.length <= MAX_ITEMS, `items は1〜${MAX_ITEMS}件にしてください。`);

  const ids = new Set();
  for (let index = 0; index < json.items.length; index += 1) {
    const item = json.items[index];
    assertImport(item && typeof item === 'object' && !Array.isArray(item), `items[${index}] の形式が不正です。`);
    validateTextField(item.id, `items[${index}].id`, 120, true);
    assertImport(SAFE_ID.test(item.id), `items[${index}].id に使用できない文字があります。`);
    assertImport(!ids.has(item.id), `item id が重複しています: ${item.id}`);
    ids.add(item.id);

    validateTextField(item.section, `${item.id}.section`, 120, true);
    assertImport(ALLOWED_ITEM_TYPES.has(item.type), `${item.id}.type が不正です。`);
    validateTextField(item.reference, `${item.id}.reference`, 200, false);
    validateTextField(item.paper_text, `${item.id}.paper_text`, 60000, false);
    validateTextField(item.spoken_text, `${item.id}.spoken_text`, 12000, true);
    validateTextField(item.ja_sentence, `${item.id}.ja_sentence`, 12000, true);
    validateTextField(item.english_pattern, `${item.id}.english_pattern`, 3000, false);
    validateTextField(item.pattern_ja, `${item.id}.pattern_ja`, 3000, false);
    validateTextField(item.pattern_note, `${item.id}.pattern_note`, 6000, false);

    if (item.image) validateAssetPath(item.image);
    if (['figure', 'table', 'equation'].includes(item.type)) {
      assertImport(typeof item.image === 'string' && item.image.length > 0, `${item.id}: 画像itemには image が必要です。`);
    }

    const chunks = Array.isArray(item.alignment_chunks) && item.alignment_chunks.length
      ? item.alignment_chunks
      : (Array.isArray(item.chunks) ? item.chunks : []);
    assertImport(chunks.length > 0 && chunks.length <= MAX_CHUNKS_PER_ITEM, `${item.id}: チャンク数が不正です。`);
    for (const chunk of chunks) {
      assertImport(chunk && typeof chunk === 'object', `${item.id}: チャンク形式が不正です。`);
      validateTextField(chunk.id, `${item.id}.chunk.id`, 16, true);
      validateTextField(chunk.ja, `${item.id}.chunk.ja`, 3000, true);
      validateTextField(chunk.en, `${item.id}.chunk.en`, 3000, true);
      const jaOrder = Number(chunk.ja_order);
      const enOrder = Number(chunk.en_order);
      assertImport(Number.isInteger(jaOrder) && jaOrder >= 1 && jaOrder <= MAX_CHUNKS_PER_ITEM, `${item.id}: ja_order が不正です。`);
      assertImport(Number.isInteger(enOrder) && enOrder >= 1 && enOrder <= MAX_CHUNKS_PER_ITEM, `${item.id}: en_order が不正です。`);
    }

    assertImport(Array.isArray(item.variants) && item.variants.length === 4, `${item.id}: variants は4段階必要です。`);
    const levels = item.variants.map(v => Number(v.level)).sort((a, b) => a - b);
    assertImport(levels.join(',') === '1,2,3,4', `${item.id}: variants のlevelは1,2,3,4にしてください。`);
    for (const variant of item.variants) {
      validateTextField(variant.label, `${item.id}.variant.label`, 100, true);
      validateTextField(variant.mixed_text, `${item.id}.variant.mixed_text`, 16000, true);
    }
  }

  return json;
}

function declaredUncompressedSize(entry) {
  const size = entry?._data?.uncompressedSize;
  return Number.isFinite(size) && size >= 0 ? size : null;
}


async function verifyImageSignature(blob, path) {
  const ext = fileExtension(path);
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const starts = (...values) => values.every((value, index) => bytes[index] === value);

  if (ext === '.png') {
    assertImport(starts(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A), `${path}: PNGデータではありません。`);
  } else if (ext === '.jpg' || ext === '.jpeg') {
    assertImport(starts(0xFF, 0xD8, 0xFF), `${path}: JPEGデータではありません。`);
  } else if (ext === '.webp') {
    const riff = starts(0x52, 0x49, 0x46, 0x46);
    const webp = bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    assertImport(riff && webp, `${path}: WebPデータではありません。`);
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_MATERIALS)) {
        db.createObjectStore(STORE_MATERIALS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll() {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(STORE_MATERIALS, 'readonly');
    const req = tx.objectStore(STORE_MATERIALS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(record) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(STORE_MATERIALS, 'readwrite');
    tx.objectStore(STORE_MATERIALS).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbDelete(id) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(STORE_MATERIALS, 'readwrite');
    tx.objectStore(STORE_MATERIALS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function progressKey(materialId) {
  return `rtt-progress:${materialId}`;
}

function loadProgress(materialId) {
  try {
    return JSON.parse(localStorage.getItem(progressKey(materialId)) || '{"items":{}}');
  } catch {
    return { items: {} };
  }
}

function saveProgress(materialId, progress) {
  localStorage.setItem(progressKey(materialId), JSON.stringify(progress));
}

function itemProgress(itemId) {
  if (!state.material) return { seen: 0, mastered: false };
  const p = loadProgress(state.material.material_id);
  return p.items?.[itemId] || { seen: 0, mastered: false };
}

function updateItemProgress(itemId, patch) {
  if (!state.material) return;
  const p = loadProgress(state.material.material_id);
  p.items ||= {};
  p.items[itemId] = { seen: 0, mastered: false, ...(p.items[itemId] || {}), ...patch };
  saveProgress(state.material.material_id, p);
}

async function loadBundledIndex() {
  try {
    const res = await fetch(BUNDLED_INDEX, { cache: 'no-cache' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function refreshMaterialList(preferredValue = null) {
  state.imported = await idbGetAll();
  const select = $('materialSelect');
  const previous = preferredValue || select.value;
  select.innerHTML = '';

  for (const m of state.bundled) {
    const opt = document.createElement('option');
    opt.value = `bundled:${m.id}`;
    opt.textContent = `${m.title}（同梱）`;
    select.appendChild(opt);
  }
  for (const m of state.imported) {
    const opt = document.createElement('option');
    opt.value = `imported:${m.id}`;
    opt.textContent = m.title || m.id;
    select.appendChild(opt);
  }

  if (select.options.length === 0) {
    $('emptyState').classList.remove('hidden');
    $('trainer').classList.add('hidden');
    $('navBar').classList.add('hidden');
    return;
  }

  $('emptyState').classList.add('hidden');
  const valid = [...select.options].some(o => o.value === previous);
  select.value = valid ? previous : select.options[0].value;
  await loadSelectedMaterial();
}

function clearAssetUrls() {
  for (const url of state.assetUrls) URL.revokeObjectURL(url);
  state.assetUrls = [];
}

async function loadSelectedMaterial() {
  clearAssetUrls();
  const value = $('materialSelect').value;
  if (!value) return;

  if (value.startsWith('bundled:')) {
    const id = value.slice('bundled:'.length);
    const meta = state.bundled.find(m => m.id === id);
    if (!meta) return;
    const res = await fetch(meta.json);
    state.material = await res.json();
    state.materialSource = { type: 'bundled', base: meta.base };
  } else {
    const id = value.slice('imported:'.length);
    const record = state.imported.find(m => m.id === id);
    if (!record) return;
    state.material = record.json;
    state.materialSource = { type: 'imported', record };
  }

  state.itemIndex = 0;
  state.mode = 'chunk';
  state.variantLevel = 2;
  populateFilters();
  applyFilters();
  syncModeTabs();
}

function populateFilters() {
  const sections = [...new Set((state.material.items || []).map(i => i.section).filter(Boolean))];
  const section = $('sectionSelect');
  section.innerHTML = '<option value="All">All</option>';
  for (const s of sections) {
    const opt = document.createElement('option');
    opt.value = s; opt.textContent = s; section.appendChild(opt);
  }
  $('typeSelect').value = 'All';
}

function applyFilters() {
  if (!state.material) return;
  const section = $('sectionSelect').value;
  const type = $('typeSelect').value;
  const includeMastered = $('includeMastered').checked;
  let items = (state.material.items || []).filter(item => {
    if (section !== 'All' && item.section !== section) return false;
    if (type !== 'All' && item.type !== type) return false;
    if (!includeMastered && itemProgress(item.id).mastered) return false;
    return true;
  });

  if ($('randomOrder').checked) {
    items = [...items];
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
  }

  state.filtered = items;
  state.itemIndex = Math.min(state.itemIndex, Math.max(0, items.length - 1));
  renderCurrentItem();
}

function alignmentChunks(item) {
  if (Array.isArray(item.alignment_chunks) && item.alignment_chunks.length) return item.alignment_chunks;
  if (Array.isArray(item.chunks)) {
    return item.chunks.map((c, idx) => ({
      id: c.id || String.fromCharCode(65 + idx),
      ja: c.ja,
      en: c.en,
      ja_order: c.ja_order ?? idx + 1,
      en_order: c.en_order ?? idx + 1,
    }));
  }
  return [];
}

function sortedChunks(item, key) {
  return [...alignmentChunks(item)].sort((a, b) => (a[key] || 999) - (b[key] || 999));
}

function speak(text, rate = 0.90) {
  if (!('speechSynthesis' in window) || !text) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = rate;
  window.speechSynthesis.speak(u);
}

async function resolveImageUrl(imagePath) {
  if (!imagePath || !state.materialSource) return null;
  if (state.materialSource.type === 'bundled') {
    return `${state.materialSource.base}${imagePath}`;
  }
  const assets = state.materialSource.record.assets || {};
  const blob = assets[imagePath] || assets[imagePath.replace(/^\.\//, '')];
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  state.assetUrls.push(url);
  return url;
}

async function renderCurrentItem() {
  if (!state.material || state.filtered.length === 0) {
    $('trainer').classList.add('hidden');
    $('navBar').classList.add('hidden');
    $('emptyState').classList.remove('hidden');
    $('emptyState').querySelector('h2').textContent = state.material ? 'この条件の教材はありません' : '教材がありません';
    $('emptyState').querySelector('p').textContent = state.material ? 'Section / Type / 覚えた文の設定を変更してください。' : '教材ZIPを追加してください。';
    return;
  }

  $('emptyState').classList.add('hidden');
  $('trainer').classList.remove('hidden');
  $('navBar').classList.remove('hidden');
  const item = state.filtered[state.itemIndex];

  $('materialTitle').textContent = state.material.title || state.material.material_id || '';
  const ref = item.reference ? ` · ${item.reference}` : '';
  const page = item.source_page ? ` · p.${item.source_page}` : '';
  $('itemMeta').textContent = `${item.section || ''}${ref}${page}`;
  $('counter').textContent = `${state.itemIndex + 1} / ${state.filtered.length}`;
  $('jaSentence').textContent = item.ja_sentence || '';
  $('englishPattern').textContent = item.english_pattern || '—';
  $('patternJa').textContent = item.pattern_ja || '—';
  $('patternNote').textContent = item.pattern_note || '—';
  $('spokenText').textContent = item.spoken_text || '';
  $('paperText').textContent = item.paper_text || '';

  clearAssetUrls();
  const visual = $('visualCard');
  if (item.image) {
    const url = await resolveImageUrl(item.image);
    if (url) {
      $('itemImage').src = url;
      $('modalImage').src = url;
      visual.classList.remove('hidden');
    } else {
      visual.classList.add('hidden');
    }
  } else {
    visual.classList.add('hidden');
  }

  renderChunkMode(item);
  renderRecallMode(item, true);
  renderMixedMode(item);
  syncMasterButton(item);
}

function renderChunkMode(item) {
  const ja = sortedChunks(item, 'ja_order');
  const en = sortedChunks(item, 'en_order');
  $('jaChunks').innerHTML = ja.map(c => `
    <div class="chunk-card ja">
      <div class="chunk-id">${escapeHtml(c.id)}</div>
      <div class="chunk-text"><span class="chunk-order">JA ${escapeHtml(c.ja_order)}</span>${escapeHtml(c.ja)}</div>
    </div>`).join('');
  $('enChunks').innerHTML = en.map((c, idx) => `
    <div class="chunk-card en" data-en-index="${idx}">
      <div class="chunk-id">${escapeHtml(c.id)}</div>
      <div class="chunk-text"><span class="chunk-order">EN ${escapeHtml(c.en_order)}</span>${escapeHtml(c.en)}</div>
      <button class="speak-one" data-speak="${encodeURIComponent(c.en)}" type="button" aria-label="このチャンクを発音">🔊</button>
    </div>`).join('');

  $('enChunks').querySelectorAll('.speak-one').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      speak(decodeURIComponent(btn.dataset.speak || ''));
    });
  });
  $('enChunks').querySelectorAll('.chunk-card.en').forEach((card, idx) => {
    card.addEventListener('click', () => speak(en[idx]?.en || ''));
  });
  $('speakFullBtn').onclick = () => speak(item.spoken_text || '', 0.92);
}

function renderRecallMode(item, chooseNew = false) {
  const en = sortedChunks(item, 'en_order');
  if (en.length === 0) {
    $('recallChunks').innerHTML = '<div class="muted">チャンク情報がありません。</div>';
    return;
  }
  if (chooseNew || state.recallIndex >= en.length) {
    state.recallIndex = Math.floor(Math.random() * en.length);
    state.recallRevealed = false;
  }
  const target = en[state.recallIndex];
  $('recallChunks').innerHTML = en.map((c, idx) => {
    if (idx !== state.recallIndex) return `<div class="recall-chip">${escapeHtml(c.en)}</div>`;
    if (state.recallRevealed) return `<div class="recall-chip target revealed"><div class="chunk-order">${escapeHtml(c.ja)}</div><strong>${escapeHtml(c.en)}</strong> 🔊</div>`;
    return `<div class="recall-chip target"><div class="chunk-order">この部分を英語で</div>${escapeHtml(c.ja)}</div>`;
  }).join('');
  if (state.recallRevealed) {
    const chips = $('recallChunks').querySelectorAll('.recall-chip');
    chips[state.recallIndex]?.addEventListener('click', () => speak(target.en));
  }
  $('revealRecallBtn').textContent = state.recallRevealed ? '🔊 このチャンクを聞く' : 'このチャンクの英語を確認';
  $('revealRecallBtn').onclick = () => {
    if (!state.recallRevealed) {
      state.recallRevealed = true;
      renderRecallMode(item, false);
    } else {
      speak(target.en);
    }
  };
  $('newRecallBtn').onclick = () => renderRecallMode(item, true);
}

function renderMixedMode(item) {
  const variants = Array.isArray(item.variants) ? item.variants : [];
  $('variantButtons').innerHTML = variants.map(v => `
    <button type="button" class="${Number(v.level) === Number(state.variantLevel) ? 'active' : ''}" data-level="${escapeHtml(v.level)}">${escapeHtml(v.label || `Lv.${v.level}`)}</button>`).join('');
  const current = variants.find(v => Number(v.level) === Number(state.variantLevel)) || variants[0];
  $('mixedText').innerHTML = current ? markdownBoldToHtml(current.mixed_text) : escapeHtml(item.spoken_text || '');
  $('variantButtons').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      state.variantLevel = Number(btn.dataset.level || 1);
      renderMixedMode(item);
    });
  });
  $('speakMixedBtn').onclick = () => speak(item.spoken_text || '', 0.92);
}

function syncModeTabs() {
  document.querySelectorAll('.mode-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === state.mode));
  $('chunkMode').classList.toggle('hidden', state.mode !== 'chunk');
  $('recallMode').classList.toggle('hidden', state.mode !== 'recall');
  $('mixedMode').classList.toggle('hidden', state.mode !== 'mixed');
}

function syncMasterButton(item) {
  const mastered = !!itemProgress(item.id).mastered;
  $('masterBtn').classList.toggle('mastered', mastered);
  $('masterBtn').textContent = mastered ? '✓ 覚えた済み' : '✓ 覚えた';
}

function move(delta) {
  if (!state.filtered.length) return;
  const item = state.filtered[state.itemIndex];
  const prog = itemProgress(item.id);
  updateItemProgress(item.id, { seen: (prog.seen || 0) + 1 });
  state.itemIndex = (state.itemIndex + delta + state.filtered.length) % state.filtered.length;
  renderCurrentItem();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function importZipFiles(files) {
  if (!window.JSZip) throw new Error('ZIP読込ライブラリを読み込めません。アプリを再読込してください。');
  assertImport(files.length > 0 && files.length <= MAX_SELECTED_ZIPS, `一度に読み込めるZIPは${MAX_SELECTED_ZIPS}個までです。`);
  const selectedBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
  assertImport(selectedBytes <= MAX_SELECTED_ZIP_BYTES, '一度に選択するZIPの合計は100MB以下にしてください。');
  let importedCount = 0;

  for (const file of files) {
    assertImport(file instanceof File, '教材ZIPを選択してください。');
    assertImport(file.size > 0, `${file.name}: 空のZIPです。`);
    assertImport(file.size <= MAX_ZIP_BYTES, `${file.name}: ZIPは50MB以下にしてください。`);
    assertImport(/\.zip$/i.test(file.name), `${file.name}: .zip ファイルのみ読み込めます。`);

    const zip = await JSZip.loadAsync(file, { checkCRC32: true, createFolders: false });
    const entries = Object.entries(zip.files);
    assertImport(entries.length > 0 && entries.length <= MAX_ZIP_FILES, `${file.name}: ZIP内のファイル数は${MAX_ZIP_FILES}件以下にしてください。`);

    let declaredTotal = 0;
    for (const [name, entry] of entries) {
      ensureSafeZipPath(name);
      if (entry.dir) continue;
      const declared = declaredUncompressedSize(entry);
      if (declared != null) {
        assertImport(declared <= MAX_DECLARED_UNCOMPRESSED_BYTES, `${file.name}: 展開サイズが大きすぎるファイルがあります。`);
        declaredTotal += declared;
        assertImport(declaredTotal <= MAX_DECLARED_UNCOMPRESSED_BYTES, `${file.name}: 展開後の合計サイズは120MB以下にしてください。`);
      }
    }

    const materialEntries = entries
      .filter(([name, entry]) => /(^|\/)material_v08\.json$/i.test(name) && !entry.dir)
      .map(([name]) => name);
    assertImport(materialEntries.length > 0, `${file.name}: material_v08.json が見つかりません。`);
    assertImport(materialEntries.length <= MAX_MATERIALS_PER_ZIP, `${file.name}: 1つのZIPに含められる教材は${MAX_MATERIALS_PER_ZIP}件までです。`);

    for (const materialEntry of materialEntries) {
      const jsonEntry = zip.files[materialEntry];
      const declaredJson = declaredUncompressedSize(jsonEntry);
      if (declaredJson != null) assertImport(declaredJson <= MAX_JSON_BYTES, `${materialEntry}: JSONが大きすぎます。`);

      const jsonText = await jsonEntry.async('string');
      assertImport(utf8ByteLength(jsonText) <= MAX_JSON_BYTES, `${materialEntry}: JSONは2MB以下にしてください。`);

      let json;
      try {
        json = JSON.parse(jsonText);
      } catch {
        throw new Error(`${materialEntry}: JSON構文が不正です。`);
      }
      validateMaterialJson(json);

      const base = materialEntry.slice(0, materialEntry.length - 'material_v08.json'.length);
      const id = json.material_id;
      const assets = {};
      let extractedBytes = utf8ByteLength(jsonText);

      // Only import image files under the material's own assets/ directory.
      for (const [name, entry] of entries) {
        if (entry.dir || !name.startsWith(base)) continue;
        const rel = name.slice(base.length);
        if (!rel.startsWith('assets/')) continue;

        validateAssetPath(rel);
        const declared = declaredUncompressedSize(entry);
        if (declared != null) assertImport(declared <= MAX_ASSET_BYTES, `${rel}: 画像は1枚15MB以下にしてください。`);

        const blob = await entry.async('blob');
        assertImport(blob.size <= MAX_ASSET_BYTES, `${rel}: 画像は1枚15MB以下にしてください。`);
        await verifyImageSignature(blob, rel);
        extractedBytes += blob.size;
        assertImport(extractedBytes <= MAX_DECLARED_UNCOMPRESSED_BYTES, `${file.name}: 展開後の合計サイズは120MB以下にしてください。`);

        // Use a fixed MIME type derived from the extension rather than trusting ZIP metadata.
        const ext = fileExtension(rel);
        const mime = ext === '.png' ? 'image/png'
          : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
        assets[rel] = new Blob([blob], { type: mime });
      }

      // Every referenced image must actually exist in the imported material.
      for (const item of json.items) {
        if (!item.image) continue;
        const path = validateAssetPath(item.image);
        assertImport(assets[path] instanceof Blob, `${item.id}: 参照画像がZIP内にありません: ${path}`);
      }

      await idbPut({
        id,
        title: json.title || id,
        importedAt: new Date().toISOString(),
        json,
        assets,
      });
      importedCount += 1;
    }
  }
  return importedCount;
}

function renderManagedMaterials() {
  const host = $('managedMaterials');
  if (!state.imported.length) {
    host.innerHTML = '<p class="muted">端末に追加した教材はまだありません。Secure版では公開サーバーに教材を同梱しません。</p>';
    return;
  }
  host.innerHTML = state.imported.map(m => `
    <div class="managed-item">
      <div>
        <div class="managed-item-title">${escapeHtml(m.title || m.id)}</div>
        <div class="managed-item-meta">${escapeHtml(m.id)} · 端末内保存</div>
      </div>
      <button class="delete-btn" data-delete-id="${escapeHtml(m.id)}" type="button">削除</button>
    </div>`).join('');
  host.querySelectorAll('[data-delete-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.deleteId;
      if (!confirm(`教材「${id}」をこの端末から削除しますか？`)) return;
      await idbDelete(id);
      localStorage.removeItem(progressKey(id));
      await refreshMaterialList();
      renderManagedMaterials();
    });
  });
}

function registerEvents() {
  $('materialSelect').addEventListener('change', loadSelectedMaterial);
  $('sectionSelect').addEventListener('change', () => { state.itemIndex = 0; applyFilters(); });
  $('typeSelect').addEventListener('change', () => { state.itemIndex = 0; applyFilters(); });
  $('includeMastered').addEventListener('change', () => { state.itemIndex = 0; applyFilters(); });
  $('randomOrder').addEventListener('change', () => { state.itemIndex = 0; applyFilters(); });

  document.querySelectorAll('.mode-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      syncModeTabs();
    });
  });

  $('prevBtn').addEventListener('click', () => move(-1));
  $('nextBtn').addEventListener('click', () => move(1));
  $('masterBtn').addEventListener('click', () => {
    const item = state.filtered[state.itemIndex];
    if (!item) return;
    const mastered = !!itemProgress(item.id).mastered;
    updateItemProgress(item.id, { mastered: !mastered });
    syncMasterButton(item);
    if (!$('includeMastered').checked && !mastered) {
      applyFilters();
    }
  });

  $('importZipBtn').addEventListener('click', () => $('zipInput').click());
  $('zipInput').addEventListener('change', async () => {
    const files = [...$('zipInput').files];
    if (!files.length) return;
    $('importStatus').textContent = '教材ZIPを読み込んでいます…';
    try {
      const count = await importZipFiles(files);
      $('importStatus').textContent = `${count}教材を端末へ保存しました。`;
      await refreshMaterialList();
    } catch (err) {
      console.error(err);
      $('importStatus').textContent = `読込エラー: ${err.message}`;
    } finally {
      $('zipInput').value = '';
    }
  });

  $('imageExpandBtn').addEventListener('click', () => $('imageModal').classList.remove('hidden'));
  $('imageCloseBtn').addEventListener('click', () => $('imageModal').classList.add('hidden'));
  $('imageModal').addEventListener('click', e => { if (e.target === $('imageModal')) $('imageModal').classList.add('hidden'); });

  $('manageBtn').addEventListener('click', () => { renderManagedMaterials(); $('manageModal').classList.remove('hidden'); });
  $('manageCloseBtn').addEventListener('click', () => $('manageModal').classList.add('hidden'));
  $('manageModal').addEventListener('click', e => { if (e.target === $('manageModal')) $('manageModal').classList.add('hidden'); });

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    $('installBtn').classList.remove('hidden');
  });
  $('installBtn').addEventListener('click', async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    $('installBtn').classList.add('hidden');
  });
}

async function init() {
  registerEvents();
  try {
    state.db = await openDb();
    state.bundled = await loadBundledIndex();
    await refreshMaterialList();
  } catch (err) {
    console.error(err);
    $('importStatus').textContent = `初期化エラー: ${err.message}`;
  }

  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (err) { console.warn('Service Worker registration failed', err); }
  }
}

document.addEventListener('DOMContentLoaded', init);
