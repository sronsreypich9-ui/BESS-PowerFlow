"use strict";

const XLSX = typeof window !== 'undefined' ? window.XLSX : null;
const fflate = typeof window !== 'undefined' ? window.fflate : null;

// ---------- Constants ----------
const TYPE = {
  POC_FVSOC:   { id: 'POC_FVSOC',   label: 'POC: F-Voltage-SOC', headerRow: 0, dataStart: 4, contextCols: 0, hasDeviceCol: false },
  POC_PQ:      { id: 'POC_PQ',      label: 'POC: P_Q',           headerRow: 0, dataStart: 4, contextCols: 0, hasDeviceCol: false },
  POC_REMOTEP: { id: 'POC_REMOTEP', label: 'POC: Remote_Active_Power', headerRow: 0, dataStart: 4, contextCols: 0, hasDeviceCol: false },
  POC_PVSMOOTH:{ id: 'POC_PVSMOOTH',label: 'POC: PV_Smoothing',       headerRow: 0, dataStart: 4, contextCols: 0, hasDeviceCol: false },
  // contextCols=3 strips Plant Name / Management Domain / Device Name from the mapping UI
  // but keeps "Start Time" so the user can map it to `time`. Device Name is harvested
  // automatically into a reserved `device_name` cell field by the conversion pass.
  ESS:         { id: 'ESS',         label: 'ESS (battery)',        headerRow: 3, dataStart: 4, contextCols: 3, hasDeviceCol: true },
  SmartLogger: { id: 'SmartLogger', label: 'SmartLogger',          headerRow: 3, dataStart: 4, contextCols: 3, hasDeviceCol: true },
  PCS:         { id: 'PCS',         label: 'PCS',                  headerRow: 3, dataStart: 4, contextCols: 3, hasDeviceCol: true },
};
const TYPE_ORDER = ['POC_FVSOC','POC_PQ','POC_REMOTEP','POC_PVSMOOTH','ESS','SmartLogger','PCS'];
const POC_TYPES = new Set(['POC_FVSOC','POC_PQ','POC_REMOTEP','POC_PVSMOOTH']);
const POC_SUBKEY = { POC_FVSOC: 'f_voltage_soc', POC_PQ: 'p_q', POC_REMOTEP: 'remote_p', POC_PVSMOOTH: 'pv_smoothing' };

// ---------- DOM ----------
const dummyEl = { style: {}, classList: { add: ()=>{}, remove: ()=>{}, toggle: ()=>{} }, addEventListener: ()=>{}, appendChild: ()=>{}, querySelector: ()=>dummyEl, querySelectorAll: ()=>[], click: ()=>{}, firstElementChild: {style:{}}, checked: true, dataset: {} };
const $ = (id) => document.getElementById(id) || dummyEl;
const logEl = $('log'), mappingArea = $('mapping-area');

// State (shared across the page; mappings populated when files arrive in the Health Check tab)
let fileEntries = [];           // [{file, path, plantId, type, headers, deviceName}]
let mappingByType = {};         // type -> { header -> targetName }
let groupedByType = {};         // type -> [entries...]
let optSkipSummary = true;

function log(msg, cls) {
  // Convert-tab style log; kept for API compatibility but routed to the Health Check log too
  logEl.style.display = 'block';
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = msg;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

// Window-level handlers prevent the browser's default "open file" behavior when the user
// drops a file outside any drop zone (otherwise the file replaces the page content).
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop',     e => e.preventDefault());

const ARCHIVE_RE = /\.(zip|rar|7z)$/i;
const XLSX_OR_ARCHIVE_RE = /\.(xlsx?|zip|rar|7z)$/i;

async function collectEntry(entry, parentPath, out) {
  const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  if (entry.isFile) {
    if (XLSX_OR_ARCHIVE_RE.test(entry.name)) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path });
    }
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    while (true) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await collectEntry(e, path, out);
    }
  }
}

// ---------- Archive expansion (zip / rar / 7z) ----------
// Each decoder returns a flat list of { name, bytes } (Uint8Array) entries.
// The caller filters to xlsx and recurses on nested archives.

function detectArchiveKind(name) {
  const m = /\.(zip|rar|7z)$/i.exec(name);
  return m ? m[1].toLowerCase() : null;
}

// --- ZIP via fflate (fast, sync-or-worker) ---
async function decodeZipBytes(buf) {
  if (typeof fflate === 'undefined') throw new Error('fflate library not loaded');
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const tree = await new Promise((res, rej) => {
    try {
      if (typeof fflate.unzip === 'function') fflate.unzip(u8, (err, d) => err ? rej(err) : res(d));
      else res(fflate.unzipSync(u8));
    } catch (err) { rej(err); }
  });
  const out = [];
  for (const [path, data] of Object.entries(tree)) {
    if (!data || data.length === 0) continue;
    if (path.endsWith('/')) continue;
    out.push({ name: path, bytes: data });
  }
  return out;
}

// --- RAR via node-unrar-js (WASM, RAR5 capable) ---
let _unrarWasmPromise = null;
function _ensureUnrar() {
  if (_unrarWasmPromise) return _unrarWasmPromise;
  _unrarWasmPromise = (async () => {
    if (!window.__UnrarCreate) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('node-unrar-js load timed out')), 15000);
        window.addEventListener('unrar-loaded', () => { clearTimeout(t); resolve(); }, { once: true });
        if (window.__UnrarCreate) { clearTimeout(t); resolve(); }
      });
    }
    const wasmUrl = 'https://cdn.jsdelivr.net/npm/node-unrar-js@2.0.2/esm/js/unrar.wasm';
    const resp = await fetch(wasmUrl);
    if (!resp.ok) throw new Error('unrar.wasm fetch failed: HTTP ' + resp.status);
    return await resp.arrayBuffer();
  })();
  return _unrarWasmPromise;
}
async function decodeRarBytes(buf) {
  const wasmBinary = await _ensureUnrar();
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const extractor = await window.__UnrarCreate({ wasmBinary, data });
  const extracted = extractor.extract();
  const out = [];
  for (const f of extracted.files) {
    const hdr = f.fileHeader || {};
    if (hdr.flags && hdr.flags.directory) continue;
    if (!f.extraction) continue;
    const u8 = f.extraction;
    out.push({ name: hdr.name, bytes: new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength).slice() });
  }
  return out;
}

// --- 7z (and other libarchive-supported formats) via libarchive.js ---
let _libarchiveInitPromise = null;
function _ensureLibarchive() {
  if (_libarchiveInitPromise) return _libarchiveInitPromise;
  _libarchiveInitPromise = (async () => {
    if (!window.__LibArchive) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('libarchive.js load timed out')), 15000);
        window.addEventListener('libarchive-loaded', () => { clearTimeout(t); resolve(); }, { once: true });
        if (window.__LibArchive) { clearTimeout(t); resolve(); }
      });
    }
    // CDN cross-origin Workers fail in many setups → fetch and run from a same-origin Blob URL
    const workerSrc = 'https://cdn.jsdelivr.net/npm/libarchive.js@2.0.2/dist/worker-bundle.js';
    const resp = await fetch(workerSrc);
    if (!resp.ok) throw new Error('worker-bundle.js fetch failed: HTTP ' + resp.status);
    const code = await resp.text();
    const blob = new Blob([code], { type: 'application/javascript' });
    window.__LibArchive.init({ workerUrl: URL.createObjectURL(blob) });
  })();
  return _libarchiveInitPromise;
}
async function decode7zBytes(buf, fileName) {
  await _ensureLibarchive();
  const file = new File([buf], fileName || 'archive.7z');
  let Archive = window.__LibArchive; if (!Archive) { const mod = await import('https://cdn.jsdelivr.net/npm/libarchive.js@2.0.2/dist/libarchive.js'); Archive = mod.Archive; window.__LibArchive = Archive; } const archive = await Archive.open(file);
  const tree = await archive.extractFiles();
  const out = [];
  async function walk(node, prefix) {
    for (const [key, val] of Object.entries(node)) {
      const path = prefix ? prefix + '/' + key : key;
      if (val && typeof val.arrayBuffer === 'function' && typeof val.size === 'number') {
        const ab = await val.arrayBuffer();
        out.push({ name: path, bytes: new Uint8Array(ab) });
      } else if (val && typeof val === 'object') {
        await walk(val, path);
      }
    }
  }
  await walk(tree, '');
  try { if (typeof archive.close === 'function') await archive.close(); } catch (_) {}
  return out;
}

// Generic archive expander — returns wrapped File entries for xlsx contents only.
// Recurses into nested archives (zip-in-rar, rar-in-zip, etc.) without limit (sane archives only).
async function expandArchive(archiveFile, parentPath) {
  const kind = detectArchiveKind(archiveFile.name);
  if (!kind) throw new Error('Not an archive: ' + archiveFile.name);
  const buf = await archiveFile.arrayBuffer();
  let entries;
  if      (kind === 'zip') entries = await decodeZipBytes(buf);
  else if (kind === 'rar') entries = await decodeRarBytes(buf);
  else if (kind === '7z')  entries = await decode7zBytes(buf, archiveFile.name);
  else throw new Error('Unsupported archive kind: ' + kind);

  const out = [];
  let nestedCount = 0;
  for (const e of entries) {
    const innerName = e.name.split('/').pop();
    if (/\.xlsx?$/i.test(innerName)) {
      out.push({ file: new File([e.bytes], innerName), path: `${parentPath}/${e.name}` });
    } else if (ARCHIVE_RE.test(innerName)) {
      try {
        const inner = await expandArchive(new File([e.bytes], innerName), `${parentPath}/${e.name}`);
        out.push(...inner);
        nestedCount++;
      } catch (err) {
        log(`  ✗ nested ${e.name}: ${err.message}`, 'err');
      }
    }
  }
  if (nestedCount) log(`  Also expanded ${nestedCount} nested archive(s) inside ${archiveFile.name}`, 'info');
  return out;
}

// Backwards-compatible alias — call sites used `expandZip(...)` for any archive type
const expandZip = expandArchive;

// ---------- File classification ----------
function classifyFile(name, firstRow) {
  const fn = name.toLowerCase();
  if (fn.startsWith('ess_'))         return 'ESS';
  if (fn.startsWith('smartlogger_')) return 'SmartLogger';
  if (fn.startsWith('pcs_'))         return 'PCS';
  
  // POC Classification by filename (mimicking ess20-engine.ts)
  if (fn.includes('pv') && fn.includes('smoothing')) return 'POC_PVSMOOTH';
  if (fn.includes('voltage') && fn.includes('soc') && fn.includes('poc') && fn.includes('point')) return 'POC_FVSOC';
  if (fn.includes('soc') && fn.includes('poc') && fn.includes('point')) return 'POC_FVSOC';
  if (fn.includes('p_q') || fn.includes('p-q') || fn.includes('pq')) return 'POC_PQ';
  if (fn.includes('remote') && fn.includes('active') && fn.includes('power')) return 'POC_REMOTEP';
  if (fn.includes('remote_active_power') || fn.includes('remotep')) return 'POC_REMOTEP';

  // Fallback to header inspection
  const a1 = firstRow && firstRow[0] != null ? String(firstRow[0]).trim() : '';
  if (/^(time|datetime)$/i.test(a1) || a1 === 'Time') {
    const hdrs = firstRow.map(h => h == null ? '' : String(h));
    if (hdrs.some(h => /Remote dispatch/i.test(h))) return 'POC_REMOTEP';
    if (hdrs.some(h => /SOC|Vab|Vbc|Vca|Freq/i.test(h))) return 'POC_FVSOC';
    if (hdrs.some(h => /[PQ][\(（]\s*k(W|var)|active\s*power|reactive\s*power/i.test(h))) return 'POC_PQ';
  }
  // 5-minute layout: filename prefix takes precedence; fall back to ESS as default
  if (a1 === 'Time range:') {
    if (/smartlogger/i.test(fn)) return 'SmartLogger';
    if (/^pcs/i.test(fn))        return 'PCS';
    return 'ESS';
  }
  return null;
}
function extractPlantId(path, file) {
  if (typeof HC_PROJECTS !== 'undefined') {
    const proj = HC_PROJECTS.find(p => p.id === hcActiveProject);
    if (proj) return proj.label;
  }
  if (hcActiveProject === 'SNTB30MWH' || hcActiveProject === 'SNTB') return 'SNTB 30MWH';
  if (hcActiveProject === 'SNTV12MWH' || hcActiveProject === 'SNTV') return 'SNTV 12MWH';
  if (hcActiveProject === 'SNTD_DMF18MWH' || hcActiveProject === 'SNTD_DMF') return 'SNTD-DMF 18MWH';
  if (hcActiveProject === 'SNTZ3MWH' || hcActiveProject === 'SNTZ') return 'SNTZ 3MWH';
  if (hcActiveProject === 'MSGP14MWH' || hcActiveProject === 'MSGP') return 'MSGP 14MWH';
  return 'Plant_01';
}

// Extract a YYYY-MM-DD date from a path/filename. Recognises:
//   YYYY-MM-DD          (e.g. ..._2026-05-01.xlsx)
//   YYYYMMDDHHMMSS      (e.g. ..._20260501000000_...)
//   DD-Mon-YYYY         (e.g. .../PLANT#01_01-May-2026/...)
// Returns "YYYY-MM-DD" or null.
const _MON = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
function _validDate(y, mo, d) { return y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31; }
function _fmt(y, mo, d) { return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }
function extractDataDate(path, fileName) {
  for (const s of [fileName, path]) {
    let m = s.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
    if (m && _validDate(+m[1], +m[2], +m[3])) return _fmt(+m[1], +m[2], +m[3]);
    m = s.match(/(\d{1,2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(20\d{2})/i);
    if (m) {
      const mo = _MON[m[2].toLowerCase()];
      if (mo && _validDate(+m[3], mo, +m[1])) return _fmt(+m[3], mo, +m[1]);
    }
    m = s.match(/(?:^|[_\W])(20\d{2})(\d{2})(\d{2})\d{6}(?:[_\W]|$)/);
    if (m && _validDate(+m[1], +m[2], +m[3])) return _fmt(+m[1], +m[2], +m[3]);
  }
  return null;
}

// ---------- xlsx reading ----------
async function readWorkbookHeaderProbe(file) {
  // Read just enough to classify and get headers + a peek at the device name (row 4)
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true, sheetRows: 6 });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws['!ref']) throw new Error('Sheet is empty');
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  return { wb: null, aoa };
}

// (Convert tab's standalone ingestFiles / renderStats removed — Health Check feeds the
// mapping panels directly via hcSyncToConvertTab.)

// ---------- Mapping panels ----------
// MATLAB allows identifiers up to 63 bytes (since R2009b). Match that limit so
// names like "Suction_superheat_degree_of_refrigerant_system_1" survive intact
// (truncating to 31 was producing duplicates that collided in the same struct).
const MAX_IDENT = 63;
function sanitize(name) {
  let s = String(name).replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) s = 'x';
  if (/^\d/.test(s)) s = 'x' + s;
  return s.slice(0, MAX_IDENT);
}
function isTimeHeader(h) {
  return /^\s*(time|start\s*time|时间|时刻|タイム|時刻)\s*$/i.test(h);
}
function isValidIdent(s) { return new RegExp(`^[A-Za-z][A-Za-z0-9_]{0,${MAX_IDENT-1}}$`).test(s); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function unionHeadersForType(t) {
  const list = groupedByType[t] || [];
  const seen = new Set();
  const out = [];
  for (const e of list) for (const h of e.headers) {
    if (h && !seen.has(h)) { seen.add(h); out.push(h); }
  }
  return out;
}

function renderMappingPanels() {
  mappingArea.innerHTML = '';
  for (const t of TYPE_ORDER) {
    const list = groupedByType[t] || [];
    if (!list.length) continue;
    const headers = unionHeadersForType(t);
    mappingByType[t] = mappingByType[t] || {};

    // Default: time → 'time', others → empty (user fills with auto-fill or manually)
    for (const h of headers) {
      if (isTimeHeader(h) && !mappingByType[t][h]) mappingByType[t][h] = 'time';
    }

    const panel = document.createElement('div');
    panel.className = 'panel';
    const cfg = TYPE[t];
    panel.innerHTML = `
      <h2>
        <span>${cfg.label}</span>
        <span class="badge">${list.length} files</span>
        <span class="badge">${headers.length} columns</span>
        <span class="badge mapped" data-type="${t}">0 mapped</span>
        <span class="badge dup dup-badge" style="display:none">0 duplicate</span>
        <span class="badge err err-badge" style="display:none">0 invalid</span>
        <span class="toggle">▼</span>
      </h2>
      <div class="body">
        <div class="toolbar">
          <button data-act="auto" data-type="${t}">Auto-fill</button>
          <button data-act="clear" data-type="${t}">Clear</button>
          <span class="meta" style="font-size:11px;color:var(--gray-500);margin-left:auto">
            ${cfg.hasDeviceCol ? '⚙ Device name is saved automatically as <code>device_name</code>' : ''}
          </span>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th style="width:55%">Excel header</th>
              <th style="width:22px"></th>
              <th>MAT variable name</th>
              <th style="width:60px">Type</th>
            </tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    `;
    const tbody = panel.querySelector('tbody');
    const frag = document.createDocumentFragment();
    for (const h of headers) {
      const isTime = isTimeHeader(h);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="header-cell">${escapeHtml(h)}</td>
        <td class="arrow">→</td>
        <td><input type="text" class="target" placeholder="(empty to skip)"></td>
        <td class="tag ${isTime ? 'time' : ''}">${isTime ? 'datetime' : 'numeric'}</td>
      `;
      const inp = tr.querySelector('input.target');
      inp.value = mappingByType[t][h] || '';
      inp.addEventListener('input', () => {
        mappingByType[t][h] = inp.value.trim();
        refreshPanelStatus(t, panel);
        refreshConvertEnabled();
      });
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    mappingArea.appendChild(panel);

    panel.querySelector('h2').addEventListener('click', () => panel.classList.toggle('collapsed'));
    panel.querySelector('[data-act="auto"]').addEventListener('click', (e) => {
      e.stopPropagation();
      autoFillMapping(t);
      renderMappingPanels();
    });
    panel.querySelector('[data-act="clear"]').addEventListener('click', (e) => {
      e.stopPropagation();
      mappingByType[t] = {};
      renderMappingPanels();
    });
    refreshPanelStatus(t, panel);
  }
  refreshConvertEnabled();
}

// Re-evaluate per-panel status: count mapped, flag invalid + duplicate target names.
// Updates each input's CSS classes and the panel header badges in place.
function refreshPanelStatus(t, panel) {
  const m = mappingByType[t] || {};
  const headers = unionHeadersForType(t);
  // Count occurrences of each (non-empty) target name
  const counts = new Map();
  for (const h of headers) {
    const v = (m[h] || '').trim();
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  // Update each input element
  let mapped = 0, dup = 0, invalid = 0;
  panel.querySelectorAll('tbody tr').forEach((tr, i) => {
    const h = headers[i];
    const inp = tr.querySelector('input.target');
    const v = (m[h] || '').trim();
    const bad = !!v && !isValidIdent(v);
    const isDup = !!v && counts.get(v) > 1;
    inp.classList.toggle('invalid', bad);
    inp.classList.toggle('dup', !bad && isDup);
    inp.title = bad ? `Invalid name (must start with a letter; alphanumeric/underscore; up to ${MAX_IDENT} chars)`
                    : (isDup ? `Duplicate of another row: "${v}"` : '');
    if (v) {
      if (bad) invalid++;
      else if (isDup) dup++;
      else mapped++;
    }
  });
  const mappedBadge  = panel.querySelector('.badge.mapped');
  const dupBadge     = panel.querySelector('.badge.dup-badge');
  const invalidBadge = panel.querySelector('.badge.err-badge');
  if (mappedBadge) {
    mappedBadge.textContent = `${mapped} mapped`;
    mappedBadge.classList.toggle('ok', mapped > 0);
  }
  if (dupBadge)     dupBadge.style.display     = dup     ? '' : 'none';
  if (dupBadge)     dupBadge.textContent       = `${dup} duplicate`;
  if (invalidBadge) invalidBadge.style.display = invalid ? '' : 'none';
  if (invalidBadge) invalidBadge.textContent   = `${invalid} invalid`;
}

function refreshConvertEnabled() {
  let totalMapped = 0, hasDup = false, hasInvalid = false;
  for (const t of TYPE_ORDER) {
    const m = mappingByType[t] || {};
    const counts = new Map();
    for (const v of Object.values(m)) {
      const tv = (v || '').trim();
      if (!tv) continue;
      if (!isValidIdent(tv)) hasInvalid = true;
      counts.set(tv, (counts.get(tv) || 0) + 1);
      totalMapped++;
    }
    for (const c of counts.values()) if (c > 1) hasDup = true;
  }
  // The standalone Convert button is gone — gate the Health Check download button instead
  // when the user has the "also generate .mat" option enabled.
  const wantMat = $('hc-include-mat') && $('hc-include-mat').checked;
  for (const btn of [hcDownloadDiscordBtn, hcDownloadSynohqBtn]) {
    if (!btn) continue;
    if (wantMat && (hasDup || hasInvalid)) {
      btn.disabled = true;
      btn.title = hasDup ? 'Duplicate variable names in mapping — fix the yellow rows'
                         : 'Invalid variable names in mapping — fix the red rows';
    }
  }
  if ((!wantMat || (!hasDup && !hasInvalid)) && typeof hcUpdateSummary === 'function') {
    hcUpdateSummary();
  }
}

function autoFillMapping(t) {
  const headers = unionHeadersForType(t);
  const used = new Set();
  const next = {};
  for (const h of headers) {
    const base = isTimeHeader(h) ? 'time' : sanitize(h);
    let n = base, i = 1;
    while (used.has(n)) n = `${base}_${++i}`;
    used.add(n);
    next[h] = n;
  }
  mappingByType[t] = next;
}

// Auto-fill any *new* headers that don't have a mapping yet (preserves user edits).
function autoFillNewHeaders(t) {
  const m = mappingByType[t] = mappingByType[t] || {};
  const used = new Set(Object.values(m).filter(Boolean));
  for (const h of unionHeadersForType(t)) {
    if (h in m) continue;  // already set (mapped or explicitly skipped via '')
    const base = isTimeHeader(h) ? 'time' : sanitize(h);
    let n = base, i = 1;
    while (used.has(n)) n = `${base}_${++i}`;
    used.add(n);
    m[h] = n;
  }
}

$('opt-skip-summary').addEventListener('change', (e) => { optSkipSummary = e.target.checked; });

// ---------- MAT v5 writer (supports nested struct, double, cellstr) ----------
const MI_INT8=1, MI_INT32=5, MI_UINT32=6, MI_DOUBLE=9, MI_MATRIX=14, MI_UTF16=17;
const MX_CELL=1, MX_STRUCT=2, MX_CHAR=4, MX_DOUBLE=6;

function pad8(len) { return (8 - (len % 8)) % 8; }
function buildElement(type, dataBytes) {
  const len = dataBytes.byteLength;
  const out = new Uint8Array(8 + len + pad8(len));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, type, true);
  dv.setUint32(4, len, true);
  out.set(dataBytes, 8);
  return out;
}
function concatU8(parts) {
  let total = 0; for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0; for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out;
}
function buildArrayFlags(klass) {
  const data = new Uint8Array(8); data[0] = klass;
  return buildElement(MI_UINT32, data);
}
function buildDimensions(dims) {
  const data = new Uint8Array(4 * dims.length);
  const dv = new DataView(data.buffer);
  dims.forEach((d, i) => dv.setInt32(i * 4, d, true));
  return buildElement(MI_INT32, data);
}
function buildArrayName(name) { return buildElement(MI_INT8, new TextEncoder().encode(name)); }
function buildDoubleData(arr) {
  const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  return buildElement(MI_DOUBLE, u8);
}
function buildDoubleMatrix(name, arr, dims) {
  return buildElement(MI_MATRIX, concatU8([
    buildArrayFlags(MX_DOUBLE), buildDimensions(dims), buildArrayName(name), buildDoubleData(arr),
  ]));
}
function buildCharMatrix1xL(str) {
  const u16 = new Uint16Array(str.length);
  for (let i = 0; i < str.length; i++) u16[i] = str.charCodeAt(i);
  return buildElement(MI_MATRIX, concatU8([
    buildArrayFlags(MX_CHAR), buildDimensions([1, str.length]), buildArrayName(''),
    buildElement(MI_UTF16, new Uint8Array(u16.buffer)),
  ]));
}
function buildCellOfStringsCol(name, strings) {
  const parts = [
    buildArrayFlags(MX_CELL), buildDimensions([strings.length, 1]), buildArrayName(name),
  ];
  for (const s of strings) parts.push(buildCharMatrix1xL(String(s)));
  return buildElement(MI_MATRIX, concatU8(parts));
}
function buildField(f) {
  if (f.kind === 'cellstr') return buildCellOfStringsCol('', f.values);
  if (f.kind === 'struct')  return buildStruct('', f.fields);
  return buildDoubleMatrix('', f.arr, f.dims);
}
function buildFieldNames(names, fnLen) {
  const data = new Uint8Array(fnLen * names.length);
  const enc = new TextEncoder();
  names.forEach((n, i) => {
    const bytes = enc.encode(n);
    if (bytes.length >= fnLen) throw new Error(`Variable name too long: ${n}`);
    data.set(bytes, i * fnLen);
  });
  return buildElement(MI_INT8, data);
}
function buildStruct(name, fields) {
  const fnLen = 64;   // 63-byte names + null; matches MATLAB's modern identifier limit
  const fnLenData = new Uint8Array(4);
  new DataView(fnLenData.buffer).setInt32(0, fnLen, true);
  const parts = [
    buildArrayFlags(MX_STRUCT), buildDimensions([1, 1]), buildArrayName(name),
    buildElement(MI_INT32, fnLenData), buildFieldNames(fields.map(f => f.name), fnLen),
  ];
  for (const f of fields) parts.push(buildField(f));
  return buildElement(MI_MATRIX, concatU8(parts));
}
function writeMatV5(structName, fields) {
  const header = new Uint8Array(128);
  const desc = `MATLAB 5.0 MAT-file, written by Huawei EMS HTML tool, ${new Date().toISOString()}`;
  const descBytes = new TextEncoder().encode(desc);
  for (let i = 0; i < 116; i++) header[i] = i < descBytes.length ? descBytes[i] : 0x20;
  for (let i = 116; i < 124; i++) header[i] = 0x20;
  header[124] = 0x00; header[125] = 0x01;
  header[126] = 0x49; header[127] = 0x4D;
  return concatU8([header, buildStruct(structName, fields)]);
}

// ---------- Time / value parsing ----------
function pad2(n) { return String(n).padStart(2, '0'); }
function formatTimestamp(v) {
  if (v == null) return '';
  if (v instanceof Date) {
    return `${v.getUTCFullYear()}-${pad2(v.getUTCMonth()+1)}-${pad2(v.getUTCDate())} ` +
           `${pad2(v.getUTCHours())}:${pad2(v.getUTCMinutes())}:${pad2(v.getUTCSeconds())}`;
  }
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400000));
    return formatTimestamp(d);
  }
  const s = String(v).trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2}(?:\.\d+)?)/);
  if (m) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])} ${pad2(+m[4])}:${pad2(+m[5])}:${pad2(parseFloat(m[6])|0)}`;
  return s;
}
const MISSING = new Set(['--','','N/A','NA','NaN','nan','null','NULL','-']);
function toFloat(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = String(v).trim();
  if (MISSING.has(s)) return NaN;
  const n = parseFloat(s);
  return Number.isFinite(n) || isNaN(n) ? n : NaN;
}

// ---------- Read xlsx data block ----------
async function readDataBlock(entry) {
  // Returns { headers, rows } where rows are aligned with headers
  const buf = await entry.file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true, raw: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws['!ref']) throw new Error('Sheet is empty');
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const cfg = TYPE[entry.type];
  const headerRow = aoa[cfg.headerRow] || [];
  const headers = headerRow.map(h => h == null ? '' : String(h));

  let dataStart = cfg.dataStart;
  if (POC_TYPES.has(entry.type) && optSkipSummary) {
    const SUM = /^(Average|Max|Min|Avg|Mean|平均|最大|最小)$/i;
    while (dataStart < aoa.length && dataStart < cfg.headerRow + 6) {
      const f = aoa[dataStart] && aoa[dataStart][0];
      if (f != null && SUM.test(String(f).trim())) dataStart++;
      else break;
    }
  }
  return { headers, rows: aoa.slice(dataStart) };
}

// (Convert tab's standalone convertAll removed — Health Check builds the .mat directly via
// hcExportZip → hcBuildMatBytes → hcConcatFieldsForType, honouring the same mappingByType state.)

// Helper: incremental Float64 accumulator (avoids array→typed copy overhead at the end)
class _DoubleAccum {
  constructor() { this._chunks = []; this._cur = new Float64Array(4096); this._idx = 0; this.length = 0; }
  push(v) {
    if (this._idx >= this._cur.length) {
      this._chunks.push(this._cur.subarray(0, this._idx));
      this._cur = new Float64Array(Math.min(this._cur.length * 2, 1 << 20));
      this._idx = 0;
    }
    this._cur[this._idx++] = v;
    this.length++;
  }
  toFloat64Array() {
    const total = this.length;
    const out = new Float64Array(total);
    let off = 0;
    for (const c of this._chunks) { out.set(c, off); off += c.length; }
    out.set(this._cur.subarray(0, this._idx), off);
    return out;
  }
}

function bucketToFields(bucket) {
  const fields = [];
  // time first (if present)
  if (bucket.time) {
    fields.push({ name: 'time', kind: 'cellstr', values: bucket.time });
  }
  if (bucket.device_name) {
    fields.push({ name: 'device_name', kind: 'cellstr', values: bucket.device_name });
  }
  for (const [k, v] of Object.entries(bucket)) {
    if (k === '_meta' || k === 'time' || k === 'device_name') continue;
    if (v instanceof _DoubleAccum) {
      const arr = v.toFloat64Array();
      fields.push({ name: k, kind: 'double', arr, dims: [arr.length, 1] });
    } else if (Array.isArray(v)) {
      // Fallback: cell of strings
      fields.push({ name: k, kind: 'cellstr', values: v });
    }
  }
  return fields;
}

function buildFinalizeMScript() {
  return `function finalize_huawei_mat(filepath)
%FINALIZE_HUAWEI_MAT  Convert all timestamp cell-of-string fields to datetime in-place.
%   finalize_huawei_mat(FILEPATH) loads FILEPATH, walks the Data struct,
%   converts any cell-of-string field whose values parse as
%   "yyyy-MM-dd HH:mm:ss" into a datetime array, and saves back.
%   Run once after downloading the .mat from the HTML tool. Idempotent.
%
%   Example:
%       finalize_huawei_mat('HuaweiEMS_data.mat');
%       s = load('HuaweiEMS_data.mat');
%       s.Data.Plant_01.POC.p_q.time   % is now a datetime array
    if nargin < 1
        [f, p] = uigetfile('*.mat', 'Select .mat to finalize');
        if isequal(f, 0), return; end
        filepath = fullfile(p, f);
    end
    s = load(filepath);
    if ~isfield(s, 'Data')
        error('finalize_huawei_mat:NoDataField', 'No top-level "Data" field in %s', filepath);
    end
    s.Data = local_walk(s.Data);
    Data = s.Data; %#ok<NASGU>
    save(filepath, 'Data', '-v7');
    fprintf('finalized: %s\\n', filepath);
end

function v = local_walk(v)
    if isstruct(v) && isscalar(v)
        flds = fieldnames(v);
        for i = 1:length(flds)
            f = flds{i};
            val = v.(f);
            if iscell(val) && ~isempty(val) && all(cellfun(@(x) ischar(x) || isstring(x), val(:)))
                if local_looks_like_timestamp(val)
                    try
                        v.(f) = datetime(val(:), 'InputFormat', 'yyyy-MM-dd HH:mm:ss');
                    catch
                        % leave as cell
                    end
                end
            else
                v.(f) = local_walk(val);
            end
        end
    end
end

function tf = local_looks_like_timestamp(c)
    tf = false;
    for k = 1:min(numel(c), 5)
        s = char(c{k});
        if isempty(s), continue; end
        if ~isempty(regexp(s, '^\\d{4}-\\d{1,2}-\\d{1,2}[ T]\\d{1,2}:\\d{1,2}:\\d{1,2}', 'once'))
            tf = true; return;
        end
    end
end
`;
}

function triggerDownload(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 200);
}

// (Tab switching removed — Convert is now embedded inline in the Health Check view.)

// =================================================================
// Signal mapping save / load (JSON)
// =================================================================
$('hc-save-mapping').addEventListener('click', () => {
  const obj = {};
  for (const t of TYPE_ORDER) {
    const m = mappingByType[t];
    if (m && Object.keys(m).length) obj[t] = m;
  }
  if (!Object.keys(obj).length) { hcLog('No mappings to save yet — drop some files first', 'warn'); return; }
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const today = new Date();
  const tag = String(today.getDate()).padStart(2,'0') + String(today.getMonth()+1).padStart(2,'0') + today.getFullYear();
  const fname = `huawei_mapping_${tag}.json`;
  triggerDownload(blob, fname);
  const total = Object.values(obj).reduce((s, m) => s + Object.keys(m).length, 0);
  hcLog(`💾 Saved ${total} mappings across ${Object.keys(obj).length} type(s) → ${fname}`, 'ok');
});

$('hc-load-mapping').addEventListener('click', () => $('hc-mapping-file').click());
$('hc-mapping-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  e.target.value = '';
  try {
    const obj = JSON.parse(await f.text());
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error('JSON must be an object: { "<type>": { "<header>": "<target>", ... }, ... }');
    }
    let totalLoaded = 0, typesLoaded = 0, autoFilled = 0;
    const touchedTypes = [];
    for (const t of Object.keys(obj)) {
      if (!TYPE_ORDER.includes(t)) {
        hcLog(`  Skipping unknown type "${t}" in JSON`, 'warn');
        continue;
      }
      const m = obj[t];
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        hcLog(`  Skipping "${t}": value is not an object`, 'warn');
        continue;
      }
      // Replace this type's mapping wholesale, then fill in any gap headers (those
      // present in the currently-loaded files but missing from the JSON) with auto-fill.
      // Explicit empty strings ("") in the JSON are preserved as user-skipped entries.
      mappingByType[t] = { ...m };
      const beforeCount = Object.keys(mappingByType[t]).length;
      autoFillNewHeaders(t);
      const afterCount = Object.keys(mappingByType[t]).length;
      autoFilled += (afterCount - beforeCount);
      totalLoaded += Object.keys(m).length;
      typesLoaded++;
      touchedTypes.push(t);
    }
    renderMappingPanels();
    let msg = `📂 Loaded ${totalLoaded} mappings across ${typesLoaded} type(s) from ${f.name}`;
    if (autoFilled) msg += ` (+ ${autoFilled} gap header(s) auto-filled)`;
    hcLog(msg, 'ok');
  } catch (err) {
    hcLog(`Mapping load failed: ${err.message}`, 'err');
  }
});

const hcLogEl = $('hc-log'), hcPlantsEl = $('hc-plants');
const hcSummaryInline = $('hc-summary-inline');
const hcDownloadDiscordBtn = $('hc-download-discord');
const hcDownloadSynohqBtn  = $('hc-download-synohq');
const hcProgressBar = $('hc-progress').firstElementChild;

// Capture every log line so the user can export them in chronological order.
const hcLogHistory = [];
function hcLog(msg, cls) { if(typeof reactUpdateCb === 'function') reactUpdateCb('log');
  hcLogHistory.push({ ts: new Date(), msg: String(msg), cls: cls || '' });
  hcLogEl.style.display = 'block';
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = msg;
  hcLogEl.appendChild(div);
  hcLogEl.scrollTop = hcLogEl.scrollHeight;
}
function hcSetProgress(pct, active, customLabel) { if(typeof reactUpdateCb === 'function') reactUpdateCb('progress', pct, active, customLabel);
  const wrap = $('hc-progress');
  wrap.classList.toggle('active', !!active);
  hcProgressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

const HC_CATS = [
  { key: 'POC',         label: 'POC',           accepts: ['POC_FVSOC','POC_PQ','POC_REMOTEP','POC_PVSMOOTH'], image: 'photo/poc_file_image.png', examples: ['POC_*.xlsx', 'Plant_*.xlsx'] },
  { key: 'ESS',         label: 'ESS (battery)', accepts: ['ESS'],         image: 'photo/ess_file_image.png', examples: ['ess_*.xlsx'] },
  { key: 'SmartLogger', label: 'SmartLogger',   accepts: ['SmartLogger'], image: 'photo/smartlogger_file_image.png', examples: ['smartlogger_*.xlsx'] },
  { key: 'PCS',         label: 'PCS',           accepts: ['PCS'],         image: 'photo/pcs_file_image.png', examples: ['pcs_*.xlsx'] },
];
const HC_TYPE_TO_CAT = (() => {
  const m = {};
  for (const c of HC_CATS) for (const t of c.accepts) m[t] = c.key;
  return m;
})();

const HC_PROJECTS = [
  { id: 'SNTB30MWH', label: 'SNTB 30MWH', defaultPlants: [
    { name: 'SNTB 30MWH', expected: { POC: 2, ESS: 15, SmartLogger: 5, PCS: 150 } },
  ]},
  { id: 'SNTV12MWH', label: 'SNTV 12MWH', defaultPlants: [
    { name: 'SNTV 12MWH', expected: { POC: 3, ESS: 6, SmartLogger: 2, PCS: 60 } },
  ]},
  { id: 'SNTD_DMF18MWH', label: 'SNTD-DMF 18MWH', defaultPlants: [
    { name: 'SNTD-DMF 18MWH', expected: { POC: 48, ESS: 9, SmartLogger: 4, PCS: 104 } },
  ]},
  { id: 'SNTZ3MWH', label: 'SNTZ 3MWH', defaultPlants: [
    { name: 'SNTZ 3MWH', expected: { POC: 3, ESS: 2, SmartLogger: 1, PCS: 14 } },
  ]},
  { id: 'MSGP14MWH', label: 'MSGP 14MWH', defaultPlants: [
    { name: 'MSGP 14MWH', expected: { POC: 3, ESS: 2, SmartLogger: 1, PCS: 2 } },
  ]},
];
const hcByProject = {};   // projectId -> [plant, plant, ...]
let hcActiveProject = HC_PROJECTS[0].id;
let hcPlantSeq = 0;

function hcMakePlant(name, expected) {
  return {
    id: 'p' + (++hcPlantSeq),
    name,
    expected: expected || {},   // { POC: 3, ESS: 50, ... } per category, undefined = no warning
    files: { POC: [], ESS: [], SmartLogger: [], PCS: [] }
  };
}
function hcCurrentPlants() { return hcByProject[hcActiveProject] || []; }

function hcInitProjects() {
  for (const proj of HC_PROJECTS) {
    hcByProject[proj.id] = proj.defaultPlants.map(p => hcMakePlant(p.name, p.expected));
  }
  hcRenderProjectTabs();
  hcRenderAllPlants();
}

function hcRenderProjectTabs() {
  const wrap = $('hc-project-tabs');
  wrap.innerHTML = '';
  for (const proj of HC_PROJECTS) {
    const total = (hcByProject[proj.id] || []).reduce(
      (s, p) => s + HC_CATS.reduce((ss, c) => ss + p.files[c.key].length, 0), 0);
    const btn = document.createElement('button');
    btn.className = 'sub-tab' + (proj.id === hcActiveProject ? ' active' : '');
    btn.dataset.project = proj.id;
    btn.innerHTML = `${escapeHtml(proj.label)}${total ? `<span class="ct">${total}</span>` : ''}`;
    btn.addEventListener('click', () => {
      hcActiveProject = proj.id;
      hcRenderProjectTabs();
      hcRenderAllPlants();
      if (typeof hcUpdateBulkTarget === 'function') hcUpdateBulkTarget();
    });
    wrap.appendChild(btn);
  }
}

function hcAddPlant(autoName) {
  const arr = hcByProject[hcActiveProject];
  const n = arr.length + 1;
  const name = autoName || `Plant_${String(n).padStart(2, '0')}`;
  const plant = hcMakePlant(name);
  arr.push(plant);
  hcRenderAllPlants();
  return plant;
}
function hcDeletePlant(id) {
  const arr = hcByProject[hcActiveProject];
  const p = arr.find(x => x.id === id);
  if (!p) return;
  const total = HC_CATS.reduce((s, c) => s + p.files[c.key].length, 0);
  if (total > 0 && !confirm(`Delete "${p.name}"? ${total} files will be removed.`)) return;
  hcByProject[hcActiveProject] = arr.filter(x => x.id !== id);
  hcRenderAllPlants();
}

function hcRenderAllPlants() { if(typeof reactUpdateCb === 'function') reactUpdateCb('plants');
  hcPlantsEl.innerHTML = '';
  for (const plant of hcCurrentPlants()) hcPlantsEl.appendChild(hcRenderPlantCard(plant));
  hcUpdateSummary();
  hcRenderProjectTabs();   // refresh per-tab counts
}

function hcRenderPlantCard(plant) {
  const card = document.createElement('div');
  card.className = 'hc-plant-card';
  card.dataset.plantId = plant.id;
  const total = HC_CATS.reduce((s, c) => s + plant.files[c.key].length, 0);
  card.innerHTML = `
    <div class="hc-plant-head">
      <input class="hc-plant-name" value="${escapeHtml(plant.name)}" spellcheck="false">
      <span class="hc-plant-count">${total} files</span>
      <button class="hc-plant-delete">Delete</button>
    </div>
    <div class="hc-cats"></div>
  `;
  const nameInp = card.querySelector('.hc-plant-name');
  nameInp.addEventListener('change', () => {
    const v = nameInp.value.trim();
    if (!v) { nameInp.value = plant.name; return; }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(v)) {
      hcLog(`Invalid plant name "${v}" — use letters/digits/underscore (letter-prefixed)`, 'err');
      nameInp.value = plant.name;
      return;
    }
    plant.name = v;
    hcUpdateSummary();
  });
  card.querySelector('.hc-plant-delete').addEventListener('click', () => hcDeletePlant(plant.id));

  const catsEl = card.querySelector('.hc-cats');
  for (const cat of HC_CATS) catsEl.appendChild(hcRenderCatBox(plant, cat));
  return card;
}

function hcRenderCatBox(plant, cat) {
  const box = document.createElement('div');
  box.className = 'hc-cat';
  const list = plant.files[cat.key];
  const okC = list.filter(r => r.report && r.report.status === 'ok').length;
  const wC  = list.filter(r => r.report && r.report.status === 'warning').length;
  const cC  = list.filter(r => r.report && r.report.status === 'critical').length;
  // Expected vs actual file count (per-plant)
  const expected = plant.expected ? plant.expected[cat.key] : null;
  let countBadge;
  if (expected == null) {
    countBadge = `<span class="badge">${list.length} files</span>`;
  } else if (list.length < expected) {
    const short = expected - list.length;
    countBadge = `<span class="badge critical" title="Need ${short} more file(s) to reach the expected ${expected}">${list.length} / ${expected} files · short ${short}</span>`;
  } else if (list.length > expected) {
    countBadge = `<span class="badge warning" title="${list.length - expected} more files than expected (${expected})">${list.length} / ${expected} files · +${list.length - expected}</span>`;
  } else {
    countBadge = `<span class="badge ok" title="All ${expected} expected files present">${list.length} / ${expected} files ✓</span>`;
  }
  box.innerHTML = `
    <div class="hc-cat-title">
      <span>${cat.label}</span>
      ${countBadge}
      ${okC ? `<span class="badge ok">✓ ${okC}</span>` : ''}
      ${wC  ? `<span class="badge warning">⚠ ${wC}</span>`  : ''}
      ${cC  ? `<span class="badge critical">✗ ${cC}</span>` : ''}
    </div>
    <div class="hc-cat-row">
      <label class="hc-cat-drop">
        Drop ${cat.label} xlsx (or click)
        <input type="file" multiple accept=".xlsx,.xls">
      </label>
      <div class="hc-cat-ref">
        <span class="label">filename example</span>
        <div class="img-wrap" style="font-size: 10px; color: var(--gray-700); text-align: left; padding: 4px; overflow: hidden; background: var(--gray-50); border-radius: 4px; display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100%;">
          ${cat.image ? `<img src="${cat.image}" alt="${escapeHtml(cat.label)} filename examples" loading="lazy" data-zoom="1" onerror="this.style.display='none'; this.parentElement.querySelector('.text-fallback').style.display='block';" style="max-width: 100%; max-height: 100%; object-fit: contain;">` : ''}
          <div class="text-fallback" style="${cat.image ? 'display:none;' : 'display:block;'} font-family: ui-monospace, monospace; text-align: center; width: 100%;">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" style="display: inline-block; margin-bottom: 4px;">
              <rect x="10" y="4" width="16" height="24" rx="2" fill="#fff" stroke="#9ca3af" stroke-width="1.5"/>
              <rect x="4" y="10" width="12" height="12" rx="1" fill="#107c41"/>
              <path d="M7.5 13.5 L12.5 18.5 M12.5 13.5 L7.5 18.5" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>
              <line x1="18" y1="13" x2="23" y2="13" stroke="#107c41" stroke-width="1.5" stroke-linecap="round"/>
              <line x1="18" y1="16" x2="23" y2="16" stroke="#107c41" stroke-width="1.5" stroke-linecap="round"/>
              <line x1="18" y1="19" x2="21" y2="19" stroke="#107c41" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            ${cat.examples ? cat.examples.map(ex => `<div style="padding: 2px 0;">${escapeHtml(ex)}</div>`).join('') : 'No examples'}
          </div>
        </div>
      </div>
    </div>
    <div class="hc-files-list">
      ${list.length ? '' : '<div class="hc-empty">no files yet</div>'}
    </div>
  `;
  const dropEl = box.querySelector('.hc-cat-drop');
  const inputEl = dropEl.querySelector('input');
  const listEl = box.querySelector('.hc-files-list');

  // Render existing files
  for (const item of list) listEl.appendChild(hcRenderFileRow(item));

  inputEl.addEventListener('change', async (e) => {
    const files = [...e.target.files].map(f => ({ file: f, path: f.webkitRelativePath || f.name }));
    e.target.value = '';
    await hcAcceptFiles(plant, cat, files);
  });
  ['dragenter','dragover'].forEach(ev => dropEl.addEventListener(ev, (e) => {
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; dropEl.classList.add('dragover');
  }));
  dropEl.addEventListener('dragleave', () => dropEl.classList.remove('dragover'));
  dropEl.addEventListener('drop', async (e) => {
    e.preventDefault(); dropEl.classList.remove('dragover');
    const dt = e.dataTransfer;
    const files = [];
    if (dt.items && typeof dt.items[0]?.webkitGetAsEntry === 'function') {
      for (const item of dt.items) {
        const entry = item.webkitGetAsEntry();
        if (entry) await collectEntry(entry, '', files);
        else if (item.kind === 'file') { const f = item.getAsFile(); if (f) files.push({ file: f, path: f.name }); }
      }
    } else for (const f of dt.files) files.push({ file: f, path: f.name });
    await hcAcceptFiles(plant, cat, files);
  });
  return box;
}

function hcRenderFileRow(item) {
  const row = document.createElement('div');
  const status = item.report ? item.report.status : 'pending';
  row.className = 'hc-file-row ' + status;
  const icon = status === 'ok' ? '✓' : status === 'warning' ? '⚠' : status === 'critical' ? '✗' : '…';
  let meta = '';
  if (item.report && item.report.N != null) {
    const r = item.report;
    const parts = [`${(r.N||0).toLocaleString()} rows`];
    if (r.durSec) parts.push(`${(r.durSec/3600).toFixed(1)}h`);
    if (r.median) parts.push(`Δt ${r.median.toFixed(1)}s`);
    if (r.gaps)   parts.push(`<span class="gap-warn">${r.gaps} gaps</span>`);
    if (r.missingPct > 0.001) parts.push(`<span class="${r.missingPct>0.05?'miss-warn':''}">${(r.missingPct*100).toFixed(1)}% miss</span>`);
    meta = parts.join(' | ');
  } else if (item.report && item.report.statusReason) {
    meta = item.report.statusReason.join('; ');
  } else {
    meta = 'analyzing...';
  }
  row.innerHTML = `
    <span class="hc-status">${icon}</span>
    <span class="hc-file-name" title="${escapeHtml(item.path || '')}">${escapeHtml(item.file.name)}</span>
    <span class="hc-file-meta">${meta}</span>
  `;
  return row;
}

async function hcAcceptFiles(plant, cat, rawList) {
  // Auto-expand any archives (zip / rar / 7z)
  const archives = rawList.filter(o => ARCHIVE_RE.test(o.file.name));
  if (archives.length) {
    hcLog(`📦 Extracting ${archives.length} archive(s) into ${plant.name}/${cat.key}...`, 'info');
    const expanded = [];
    for (const o of rawList) {
      if (ARCHIVE_RE.test(o.file.name)) {
        try { expanded.push(...await expandArchive(o.file, o.path)); }
        catch (err) { hcLog(`  ✗ ${o.file.name}: ${err.message}`, 'err'); }
      } else expanded.push(o);
    }
    rawList = expanded;
  }
  rawList = rawList.filter(o => /\.xlsx?$/i.test(o.file.name));
  if (!rawList.length) return;

  hcSetProgress(0, true);
  const total = rawList.length;
  for (let i = 0; i < total; i++) {
    const o = rawList[i];
    const item = { file: o.file, path: o.path, report: null };
    plant.files[cat.key].push(item);
    try {
      const report = await hcCheckFile(o);
      // Reroute if the file actually belongs to a different category
      const actualCat = HC_TYPE_TO_CAT[report.entry.type];
      if (actualCat && actualCat !== cat.key) {
        plant.files[cat.key] = plant.files[cat.key].filter(x => x !== item);
        plant.files[actualCat].push(item);
        item.report = report;
        hcLog(`  ↳ ${o.file.name} → moved to ${plant.name}/${actualCat} (filename suggests ${report.entry.type})`, 'warn');
      } else if (!actualCat) {
        item.report = { status: 'critical', statusReason: [`unclassified (${report.entry.type || 'unknown'})`], reasons: [`unclassified (${report.entry.type || 'unknown'})`], N: 0 };
      } else {
        item.report = report;
      }
    } catch (err) {
      item.report = { status: 'critical', statusReason: [`error: ${err.message}`], reasons: [`error: ${err.message}`], N: 0 };
      console.error(err);
    }
    hcSetProgress(((i + 1) / total) * 100, true);
    if (i % 3 === 0) await new Promise(r => setTimeout(r, 0));
  }
  hcSetProgress(100, false);
  hcRenderAllPlants();
  hcSyncToConvertTab();   // mirror to Convert tab so the user can edit signal mappings there
}

// Push HC files into the Convert tab's collections so the same mapping UI / mappings apply.
// Dedup by absolute path so re-dropping doesn't duplicate. Auto-fills new headers without
// touching existing user edits, then re-renders the Convert tab's mapping panels.
function hcSyncToConvertTab() {
  const seenPaths = new Set(fileEntries.map(fe => fe.path));
  const touchedTypes = new Set();
  for (const proj of HC_PROJECTS) {
    for (const plant of (hcByProject[proj.id] || [])) {
      for (const cat of HC_CATS) {
        for (const item of plant.files[cat.key]) {
          const r = item.report;
          if (!r || !r.entry || !r.entry.type) continue;
          if (seenPaths.has(item.path)) continue;
          seenPaths.add(item.path);
          // Reuse the same entry shape that ingestFiles produces in the Convert tab
          const entry = {
            file: item.file, path: item.path,
            plantId: plant.name, type: r.entry.type,
            headers: r.entry.headers || [],
            deviceName: r.entry.deviceName || r.deviceName || '',
          };
          fileEntries.push(entry);
          (groupedByType[entry.type] ||= []).push(entry);
          touchedTypes.add(entry.type);
        }
      }
    }
  }
  if (!touchedTypes.size) return;
  for (const t of touchedTypes) autoFillNewHeaders(t);
  renderMappingPanels();
}

function hcUpdateSummary() {
  let totFiles = 0, ok = 0, w = 0, c = 0;
  let totalExpected = 0, missing = 0;
  for (const p of hcCurrentPlants()) {
    for (const cat of HC_CATS) {
      const exp = p.expected ? p.expected[cat.key] : null;
      const have = p.files[cat.key].length;
      if (exp != null) {
        totalExpected += exp;
        if (have < exp) missing += (exp - have);
      }
      for (const item of p.files[cat.key]) {
        totFiles++;
        const s = item.report ? item.report.status : null;
        if (s === 'ok') ok++;
        else if (s === 'warning') w++;
        else if (s === 'critical') c++;
      }
    }
  }
  const shortPart = missing > 0
    ? ` · <span style="color:var(--red)">missing <strong>${missing}</strong> / ${totalExpected.toLocaleString()}</span>`
    : (totalExpected ? ` · <span style="color:var(--green)">all ${totalExpected.toLocaleString()} files present</span>` : '');
  hcSummaryInline.innerHTML = totFiles
    ? `<strong>${escapeHtml(hcActiveProject)}</strong> · <span class="v">${totFiles}</span> files · <span style="color:var(--green)">✓ ${ok}</span> · <span style="color:var(--amber)">⚠ ${w}</span> · <span style="color:var(--red)">✗ ${c}</span>${shortPart}`
    : `<strong>${escapeHtml(hcActiveProject)}</strong> · drop xlsx files into the plant zones below${shortPart}`;
  const matSuffix = $('hc-include-mat') && $('hc-include-mat').checked ? ' + .mat' : '';
  if (hcDownloadDiscordBtn) {
    hcDownloadDiscordBtn.disabled = totFiles === 0;
    hcDownloadDiscordBtn.textContent = `⇩ Download for Discord (${hcActiveProject}, ≤10 MB parts${matSuffix})`;
  }
  if (hcDownloadSynohqBtn) {
    hcDownloadSynohqBtn.disabled = totFiles === 0;
    hcDownloadSynohqBtn.textContent = `⇩ Download for Synohq (${hcActiveProject}, single .zip${matSuffix})`;
  }
}
// Global busy lock prevents overlapping bulk imports / downloads (avoids state corruption).
let hcBusy = false;
function hcSetBusy(on, label) {
  hcBusy = !!on;
  for (const id of ['hc-download-discord','hc-download-synohq','hc-add-plant','hc-reset','hc-clear-mappings','hc-bulk-drop','hc-save-mapping','hc-load-mapping']) {
    const el = document.getElementById(id); if (!el) continue;
    if (on) { el.dataset._wasDisabled = el.disabled ? '1' : ''; el.disabled = true; }
    else    { el.disabled = el.dataset._wasDisabled === '1'; delete el.dataset._wasDisabled; }
  }
  if (!on) hcUpdateSummary();   // restore proper enabled/disabled state on the download buttons
  if (typeof reactUpdateCb === 'function') reactUpdateCb('busy');
}
async function hcRunExport(split) {
  if (hcBusy) { hcLog('Busy — wait for the current operation to finish', 'warn'); return; }
  hcSetBusy(true, 'export');
  try { await hcExportZip({ split }); }
  catch (err) { hcLog(`Export failed: ${err.message}`, 'err'); console.error(err); hcSetProgress(0, false); }
  finally { hcSetBusy(false); }
}
$('hc-download-discord').addEventListener('click', () => hcRunExport(true));
$('hc-download-synohq').addEventListener('click',  () => hcRunExport(false));

// ----- Export the health check report + operation log as a .txt -----
$('hc-export-log').addEventListener('click', () => {
  if (hcBusy) { hcLog('Busy — wait for the current operation to finish', 'warn'); return; }
  hcExportTextLog();
});

function hcExportTextLog() {
  const today = new Date();
  const tag = String(today.getDate()).padStart(2,'0') + String(today.getMonth()+1).padStart(2,'0') + today.getFullYear();
  const lines = [];
  const status = (s) => s === 'ok' ? '✓' : s === 'warning' ? '⚠' : s === 'critical' ? '✗' : '?';

  const fmtLocal = (d) =>
    `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const fmtLocalTime = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return 'local'; } })();

  // Header
  lines.push('=== Huawei EMS Health Check Report ===');
  lines.push(`Project   : ${hcActiveProject}`);
  lines.push(`Generated : ${fmtLocal(today)} (${tz})`);

  const plants = hcCurrentPlants();
  let totFiles = 0, totOk = 0, totW = 0, totC = 0, totalExpected = 0, missingCnt = 0;
  for (const p of plants) {
    for (const cat of HC_CATS) {
      const items = p.files[cat.key];
      const exp = p.expected ? p.expected[cat.key] : null;
      if (exp != null) { totalExpected += exp; if (items.length < exp) missingCnt += (exp - items.length); }
      for (const it of items) {
        totFiles++;
        const s = it.report ? it.report.status : null;
        if (s === 'ok') totOk++; else if (s === 'warning') totW++; else if (s === 'critical') totC++;
      }
    }
  }
  lines.push(`Plants    : ${plants.map(p => p.name).join(', ') || '(none)'}`);
  lines.push(`Total xlsx: ${totFiles}` + (totalExpected ? ` / ${totalExpected} expected` : ''));
  lines.push(`Status    : ✓ ${totOk}   ⚠ ${totW}   ✗ ${totC}` + (missingCnt ? `   missing ${missingCnt}` : ''));
  lines.push('');

  // Per-plant breakdown
  for (const plant of plants) {
    const plantTotal = HC_CATS.reduce((s, c) => s + plant.files[c.key].length, 0);
    lines.push(`--- ${plant.name} (${plantTotal} files) ---`);
    for (const cat of HC_CATS) {
      const items = plant.files[cat.key];
      const exp = plant.expected ? plant.expected[cat.key] : null;
      if (!items.length) {
        if (exp) lines.push(`  ${cat.label}: 0 / ${exp} files  ✗ MISSING`);
        else     lines.push(`  ${cat.label}: 0 files`);
        continue;
      }
      const okC = items.filter(i => i.report && i.report.status === 'ok').length;
      const wC  = items.filter(i => i.report && i.report.status === 'warning').length;
      const cC  = items.filter(i => i.report && i.report.status === 'critical').length;
      const expStr = exp != null ? ` / ${exp}` : '';
      const shortStr = (exp != null && items.length < exp) ? `  short ${exp - items.length}` : '';
      lines.push(`  ${cat.label}: ${items.length}${expStr} files  (✓${okC} ⚠${wC} ✗${cC})${shortStr}`);
      const sorted = [...items].sort((a, b) => {
        const ord = { critical: 0, warning: 1, ok: 2 };
        const da = (a.report && ord[a.report.status]) ?? 3;
        const db = (b.report && ord[b.report.status]) ?? 3;
        if (da !== db) return da - db;
        return a.file.name.localeCompare(b.file.name);
      });
      for (const it of sorted) {
        const r = it.report || {};
        lines.push(`    ${status(r.status)} ${it.file.name}`);
        if (r.deviceName) lines.push(`        device : ${r.deviceName}`);
        const meta = [];
        if (r.N) meta.push(`${r.N.toLocaleString()} rows`);
        if (r.startTime && r.endTime) meta.push(`${tsToISO(r.startTime)} → ${tsToISO(r.endTime)}`);
        if (r.durSec) meta.push(`${(r.durSec/3600).toFixed(2)}h`);
        if (r.median) meta.push(`Δt=${r.median.toFixed(2)}s`);
        if (r.gaps) meta.push(`${r.gaps} gaps`);
        if (r.missingPct != null && r.missingPct > 0.001) meta.push(`${(r.missingPct*100).toFixed(2)}% missing`);
        if (meta.length) lines.push(`        metrics: ${meta.join(' | ')}`);
        if (r.statusReason && r.statusReason.length) {
          lines.push(`        notes  : ${r.statusReason.join('; ')}`);
        }
      }
    }
    lines.push('');
  }

  // Signal mappings (reflecting current state)
  const mappingTypes = TYPE_ORDER.filter(t => mappingByType[t] && Object.keys(mappingByType[t]).length);
  if (mappingTypes.length) {
    lines.push('=== Signal mappings ===');
    for (const t of mappingTypes) {
      const m = mappingByType[t];
      const entries = Object.entries(m);
      lines.push(`-- ${TYPE[t] ? TYPE[t].label : t} (${entries.length}) --`);
      for (const [h, v] of entries) {
        lines.push(`  ${h}  →  ${v || '(skip)'}`);
      }
    }
    lines.push('');
  }

  // Operation log
  lines.push('=== Operation log ===');
  for (const entry of hcLogHistory) {
    const t = fmtLocalTime(entry.ts);
    const cls = entry.cls ? ` [${entry.cls.toUpperCase()}]` : '';
    lines.push(`[${t}]${cls} ${entry.msg}`);
  }
  lines.push('');
  lines.push(`--- End of report (${lines.length} lines) ---`);

  // Use \r\n for cross-platform editor friendliness (Windows Notepad happy)
  const text = lines.join('\r\n');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const fname = `${hcActiveProject}_log_${tag}.txt`;
  triggerDownload(blob, fname);
  hcLog(`📄 Exported report → ${fname} (${(text.length/1024).toFixed(1)} KB)`, 'ok');
}

// Reset the active project's plant cards back to defaults (mappings preserved)
function hcResetActiveProject() {
  const proj = HC_PROJECTS.find(p => p.id === hcActiveProject);
  const arr = hcByProject[hcActiveProject] || [];
  const total = arr.reduce((s, p) => s + HC_CATS.reduce((ss, c) => ss + p.files[c.key].length, 0), 0);
  hcByProject[hcActiveProject] = proj
    ? proj.defaultPlants.map(p => hcMakePlant(p.name, p.expected))
    : [];
  hcRebuildSharedConvertState();
  return total;
}
$('hc-reset').addEventListener('click', () => {
  if (hcBusy) return;
  const arr = hcByProject[hcActiveProject] || [];
  const total = arr.reduce((s, p) => s + HC_CATS.reduce((ss, c) => ss + p.files[c.key].length, 0), 0);
  if (total === 0 && arr.length === (HC_PROJECTS.find(p => p.id === hcActiveProject)?.defaultPlants?.length || 0)) {
    hcLog(`${hcActiveProject} is already at default state`, 'info'); return;
  }
  if (total > 0 && !confirm(`Reset ${hcActiveProject}? ${total} loaded file(s) will be removed (mappings preserved).`)) return;
  const cleared = hcResetActiveProject();
  hcRenderAllPlants();
  hcLog(`✓ Reset ${hcActiveProject}` + (cleared ? ` (${cleared} files cleared)` : ''), 'ok');
});

// Wipe all signal mappings (will auto-fill again on next file arrival)
$('hc-clear-mappings').addEventListener('click', () => {
  if (hcBusy) return;
  const total = Object.values(mappingByType).reduce((s, m) => s + Object.keys(m || {}).length, 0);
  if (total === 0) { hcLog('No mappings to clear', 'info'); return; }
  if (!confirm(`Clear ${total} signal mapping(s) across all types?`)) return;
  mappingByType = {};
  // Re-auto-fill from current files so the user isn't left empty
  for (const t of TYPE_ORDER) {
    if (groupedByType[t] && groupedByType[t].length) autoFillNewHeaders(t);
  }
  renderMappingPanels();
  hcLog(`🧹 Cleared mappings (re-auto-filled from current files)`, 'ok');
});

// Rebuild the Convert-side state (fileEntries / groupedByType) from the current Health Check
// state. Used after Reset, so stale entries from removed plants don't linger in mapping panels.
function hcRebuildSharedConvertState() {
  fileEntries = [];
  groupedByType = {};
  for (const proj of HC_PROJECTS) {
    for (const plant of (hcByProject[proj.id] || [])) {
      for (const cat of HC_CATS) {
        for (const item of plant.files[cat.key]) {
          const r = item.report;
          if (!r || !r.entry || !r.entry.type) continue;
          const entry = {
            file: item.file, path: item.path,
            plantId: plant.name, type: r.entry.type,
            headers: r.entry.headers || [],
            deviceName: r.entry.deviceName || r.deviceName || '',
          };
          fileEntries.push(entry);
          (groupedByType[entry.type] ||= []).push(entry);
        }
      }
    }
  }
  renderMappingPanels();
}

// ----- Bulk import: one folder → auto-classify per Plant × Category -----
const hcBulkDrop = $('hc-bulk-drop'), hcBulkPick = $('hc-bulk-filepick'), hcBulkTarget = $('hc-bulk-target');
function hcUpdateBulkTarget() { hcBulkTarget.textContent = hcActiveProject; }

hcBulkDrop.addEventListener('click', () => hcBulkPick.click());
hcBulkDrop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') hcBulkPick.click(); });
['dragenter','dragover'].forEach(ev => hcBulkDrop.addEventListener(ev, e => {
  e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; hcBulkDrop.classList.add('dragover');
}));
hcBulkDrop.addEventListener('dragleave', e => { if (e.target === hcBulkDrop) hcBulkDrop.classList.remove('dragover'); });
hcBulkDrop.addEventListener('drop', async (e) => {
  e.preventDefault(); hcBulkDrop.classList.remove('dragover');
  const dt = e.dataTransfer;
  const files = [];
  try {
    if (dt.items && typeof dt.items[0]?.webkitGetAsEntry === 'function') {
      for (const item of dt.items) {
        const entry = item.webkitGetAsEntry();
        if (entry) await collectEntry(entry, '', files);
        else if (item.kind === 'file') { const f = item.getAsFile(); if (f) files.push({ file: f, path: f.name }); }
      }
    } else if (dt.files) {
      for (const f of dt.files) files.push({ file: f, path: f.webkitRelativePath || f.name });
    }
  } catch (err) { hcLog(`Bulk drop error: ${err.message}`, 'err'); console.error(err); return; }
  await hcBulkImport(files);
});
hcBulkPick.addEventListener('change', async (e) => {
  const files = [...e.target.files].map(f => ({ file: f, path: f.webkitRelativePath || f.name }));
  e.target.value = '';
  await hcBulkImport(files);
});

// Auto-classify a single file probe (filename → category, then header fallback). Mirrors
// the classifier used by hcCheckFile / collectEntry but separates the probe so we can
// route before running the full health check.
async function hcAutoClassify(o) {
  const probe = await readWorkbookHeaderProbe(o.file);
  const aoa = probe.aoa;
  const firstRow = aoa[0] || [];
  let type = classifyFile(o.file.name, firstRow);
  if (!type) {
    const r3 = aoa[3] || [];
    if (r3[0] === 'Plant Name' && r3[3] === 'Start Time') {
      type = /smartlogger/i.test(o.file.name) ? 'SmartLogger'
           : /^pcs/i.test(o.file.name)        ? 'PCS'
           :                                    'ESS';
    }
  }
  return type;
}

async function hcBulkImport(rawList) {
  if (hcBusy) { hcLog('Busy — wait for the current operation to finish', 'warn'); return; }
  hcSetBusy(true, 'bulk');
  // Trigger progress bar immediately with a clear loading message
  hcSetProgress(0, true, 'Initializing file pipeline...');
  try { 
    await hcBulkImportInner(rawList); 
  } catch (err) {
    hcSetProgress(0, false);
    throw err;
  } finally { 
    hcSetBusy(false); 
  }
}
async function hcBulkImportInner(rawList) {
  // Expand any archives (zip / rar / 7z) first
  const archives = rawList.filter(o => ARCHIVE_RE.test(o.file.name));
  if (archives.length) {
    hcLog(`📦 Bulk: extracting ${archives.length} archive(s)...`, 'info');
    const expanded = [];
    for (let idx = 0; idx < rawList.length; idx++) {
      const o = rawList[idx];
      if (ARCHIVE_RE.test(o.file.name)) {
        hcSetProgress(
          (idx / rawList.length) * 100, 
          true, 
          `Unzipping ${o.file.name}...`
        );
        try {
          const inner = await expandArchive(o.file, o.path);
          expanded.push(...inner);
          hcLog(`  📦 ${o.file.name} → ${inner.length} xlsx file(s)`, 'ok');
        } catch (err) { 
          hcLog(`  ✗ ${o.file.name}: ${err.message}`, 'err'); 
          console.error(err); 
        }
      } else {
        expanded.push(o);
      }
    }
    rawList = expanded;
  }
  rawList = rawList.filter(o => /\.xlsx?$/i.test(o.file.name));
  if (!rawList.length) { 
    hcLog('No xlsx files in the bulk drop — keeping previous data', 'warn'); 
    hcSetProgress(0, false);
    return; 
  }

  // Auto-reset the active project before importing so this batch starts clean (no
  // chance of accidental contamination from a previous run). Mappings are preserved.
  const cleared = hcResetActiveProject();
  if (cleared > 0) hcLog(`  ↺ Reset ${hcActiveProject}: cleared ${cleared} previously-loaded file(s)`, 'info');
  hcRenderAllPlants();   // reflect the reset visually before progress starts

  // Path-based dedup (within this batch — existingPaths starts empty after reset)
  const existingPaths = new Set();

  hcLog(`📂 Bulk import → ${hcActiveProject}: ${rawList.length} xlsx file(s)`, 'info');
  hcSetProgress(0, true, `Starting health check audit for ${rawList.length} spreadsheets...`);

  let routed = 0, duped = 0, unclassified = 0;
  const createdPlants = new Set();
  const total = rawList.length;
  for (let i = 0; i < total; i++) {
    const o = rawList[i];
    hcSetProgress(
      (i / total) * 100, 
      true, 
      `Auditing spreadsheet ${i + 1} of ${total}: ${o.file.name}...`
    );
    if (existingPaths.has(o.path)) { duped++; continue; }
    try {
      const type = await hcAutoClassify(o);
      const catKey = type ? HC_TYPE_TO_CAT[type] : null;
      if (!catKey) { unclassified++; continue; }

      // Find or create the plant card matching the file's plant ID
      const plantId = extractPlantId(o.path, o.file);
      let plant = hcCurrentPlants().find(p => p.name === plantId);
      if (!plant) {
        plant = hcMakePlant(plantId);
        hcByProject[hcActiveProject].push(plant);
        createdPlants.add(plantId);
      }

      // Add and run health check (route to actual category in case classify hint differs)
      const item = { file: o.file, path: o.path, report: null };
      plant.files[catKey].push(item);
      existingPaths.add(o.path);
      const report = await hcCheckFile(o);
      const actualCat = HC_TYPE_TO_CAT[report.entry.type];
      if (actualCat && actualCat !== catKey) {
        plant.files[catKey] = plant.files[catKey].filter(x => x !== item);
        plant.files[actualCat].push(item);
      }
      item.report = report;
      routed++;
    } catch (err) {
      hcLog(`  ✗ ${o.path}: ${err.message}`, 'err');
    }
    hcSetProgress(((i + 1) / total) * 100, true, `Audited ${i + 1} of ${total} files...`);
    if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
  }
  hcSetProgress(100, false);

  const parts = [`${routed} routed`];
  if (duped)        parts.push(`${duped} dedup'd`);
  if (unclassified) parts.push(`${unclassified} unclassified`);
  hcLog(`✓ Bulk import done: ${parts.join(', ')}`, 'ok');
  if (createdPlants.size) hcLog(`  + Created plant card(s): ${[...createdPlants].sort().join(', ')}`, 'info');
  hcRenderAllPlants();
  hcSyncToConvertTab();
}

// Click any reference image to enlarge in a modal overlay
const hcImgModal = $('hc-img-modal'), hcImgModalImg = $('hc-img-modal-img');
document.addEventListener('click', (e) => {
  const img = e.target;
  if (img && img.tagName === 'IMG' && img.dataset.zoom === '1') {
    hcImgModalImg.src = img.src;
    hcImgModal.classList.add('active');
  } else if (e.target === hcImgModal) {
    hcImgModal.classList.remove('active');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hcImgModal.classList.remove('active');
});

// Bootstrap projects with their default Plant_XX cards
hcInitProjects();
hcUpdateBulkTarget();

// ===== ZIP writer (store-only, restored from earlier so we can bundle the organized folder) =====
const _CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
function hcCrc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = _CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function _hcDosTimeDate(d) {
  const t = ((d.getHours()&0x1F)<<11) | ((d.getMinutes()&0x3F)<<5) | ((d.getSeconds()>>>1)&0x1F);
  const dt = (((d.getFullYear()-1980)&0x7F)<<9) | (((d.getMonth()+1)&0x0F)<<5) | (d.getDate()&0x1F);
  return { time: t & 0xFFFF, date: dt & 0xFFFF };
}
function hcBuildZip(files) {
  const enc = new TextEncoder();
  const { time: dT, date: dD } = _hcDosTimeDate(new Date());
  const entries = files.map(f => ({ nameBytes: enc.encode(f.name), data: f.data, crc: hcCrc32(f.data) }));
  let local = 0; for (const e of entries) local += 30 + e.nameBytes.length + e.data.length;
  let cd = 0;    for (const e of entries) cd    += 46 + e.nameBytes.length;
  const out = new Uint8Array(local + cd + 22);
  const dv = new DataView(out.buffer);
  let p = 0;
  for (const e of entries) {
    e.offset = p;
    dv.setUint32(p,    0x04034b50, true); dv.setUint16(p+4,  20, true); dv.setUint16(p+6,  0, true);
    dv.setUint16(p+8,  0, true); dv.setUint16(p+10, dT, true); dv.setUint16(p+12, dD, true);
    dv.setUint32(p+14, e.crc, true); dv.setUint32(p+18, e.data.length, true); dv.setUint32(p+22, e.data.length, true);
    dv.setUint16(p+26, e.nameBytes.length, true); dv.setUint16(p+28, 0, true);
    p += 30; out.set(e.nameBytes, p); p += e.nameBytes.length;
    out.set(e.data, p); p += e.data.length;
  }
  const central = p;
  for (const e of entries) {
    dv.setUint32(p,    0x02014b50, true); dv.setUint16(p+4,  20, true); dv.setUint16(p+6,  20, true);
    dv.setUint16(p+8,  0, true); dv.setUint16(p+10, 0, true);
    dv.setUint16(p+12, dT, true); dv.setUint16(p+14, dD, true);
    dv.setUint32(p+16, e.crc, true); dv.setUint32(p+20, e.data.length, true); dv.setUint32(p+24, e.data.length, true);
    dv.setUint16(p+28, e.nameBytes.length, true);
    dv.setUint16(p+30, 0, true); dv.setUint16(p+32, 0, true); dv.setUint16(p+34, 0, true);
    dv.setUint16(p+36, 0, true); dv.setUint32(p+38, 0, true); dv.setUint32(p+42, e.offset, true);
    p += 46; out.set(e.nameBytes, p); p += e.nameBytes.length;
  }
  dv.setUint32(p,    0x06054b50, true); dv.setUint16(p+4,  0, true); dv.setUint16(p+6,  0, true);
  dv.setUint16(p+8,  entries.length, true); dv.setUint16(p+10, entries.length, true);
  dv.setUint32(p+12, cd, true); dv.setUint32(p+16, central, true); dv.setUint16(p+20, 0, true);
  return out;
}

// Cap each split chunk under Discord's 10 MB upload limit (leave overhead for ZIP headers + safety margin)
const HC_SPLIT_BYTES = 9_500_000;

function formatFolderDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = d.getDate();
  const month = months[d.getMonth()];
  const year = d.getFullYear();
  return `${day}. ${day}-${month}-${year}`;
}

async function hcExportZip(opts) {
  const split = opts && opts.split === true;

  // Find the date of the telemetry from the uploaded spreadsheets
  let dataDate = null;
  for (const plant of hcCurrentPlants()) {
    for (const cat of HC_CATS) {
      for (const item of plant.files[cat.key]) {
        const d = extractDataDate(item.path, item.file.name);
        if (d) {
          dataDate = d;
          break;
        }
      }
      if (dataDate) break;
    }
    if (dataDate) break;
  }

  let datePrefix = "";
  if (dataDate) {
    const formatted = formatFolderDate(dataDate);
    if (formatted) datePrefix = `${formatted}/`;
  }

  // Group files by category — keeps each chunk single-category, so naming stays meaningful
  const byCategory = {};   // catKey → [{ zipPath, file }]
  let totalFiles = 0;
  for (const plant of hcCurrentPlants()) {
    for (const cat of HC_CATS) {
      const list = byCategory[cat.key] = byCategory[cat.key] || [];
      for (const item of plant.files[cat.key]) {
        let zipPath;
        if (cat.key === 'POC') {
          zipPath = `${datePrefix}1. Historical_Data/${item.file.name}`;
        } else if (cat.key === 'ESS') {
          zipPath = `${datePrefix}1. Historical_Data/ESS/${item.file.name}`;
        } else if (cat.key === 'SmartLogger') {
          zipPath = `${datePrefix}1. Historical_Data/SmartLogger/${item.file.name}`;
        } else if (cat.key === 'PCS') {
          zipPath = `${datePrefix}1. Historical_Data/PCS/${item.file.name}`;
        } else {
          zipPath = `${datePrefix}1. Historical_Data/${cat.key}/${item.file.name}`;
        }
        list.push({ zipPath, file: item.file });
        totalFiles++;
      }
    }
  }
  if (!totalFiles) { hcLog(`No files to export for ${hcActiveProject}`, 'warn'); return; }

  const today = new Date();
  const tag = String(today.getDate()).padStart(2,'0') + String(today.getMonth()+1).padStart(2,'0') + today.getFullYear();

  if (split) {
    await hcExportZipChunked(byCategory, tag);
  } else {
    await hcExportZipMonolithic(byCategory, tag, totalFiles);
  }

  // Also generate .mat if the checkbox is on
  if ($('hc-include-mat').checked) {
    try {
      hcLog(`Building .mat for ${hcActiveProject} (using signal mappings below)...`, 'info');
      const matBytes = await hcBuildMatBytes();
      if (matBytes) {
        const matName = `${hcActiveProject}_${tag}.mat`;
        triggerDownload(new Blob([matBytes], { type: 'application/octet-stream' }), matName);
        hcLog(`✓ ${matName} (${(matBytes.byteLength/1024/1024).toFixed(1)} MB) downloaded`, 'ok');
        // Optional finalize_huawei_mat.m helper
        if ($('opt-include-helper') && $('opt-include-helper').checked) {
          triggerDownload(new Blob([buildFinalizeMScript()], { type: 'text/plain' }), 'finalize_huawei_mat.m');
          hcLog(`  + finalize_huawei_mat.m — run once in MATLAB to convert time cells to datetime`, 'ok');
        }
      }
    } catch (err) {
      hcLog(`✗ .mat build failed: ${err.message}`, 'err'); console.error(err);
    }
  }
}

// Single-zip mode (Discord-OFF): pack everything into one .zip file.
async function hcExportZipMonolithic(byCategory, tag, totalFiles) {
  const zipEntries = [];
  let count = 0;
  hcSetProgress(0, true);
  for (const cat of HC_CATS) {
    for (const f of (byCategory[cat.key] || [])) {
      const data = new Uint8Array(await f.file.arrayBuffer());
      zipEntries.push({ name: f.zipPath, data });
      count++;
      if ((count & 7) === 0) {
        hcSetProgress((count / totalFiles) * 100, true);
        await new Promise(r => setTimeout(r, 0));
      }
    }
  }
  hcSetProgress(100, false);
  hcLog(`Bundling ${zipEntries.length} files for ${hcActiveProject}...`, 'info');
  const bytes = hcBuildZip(zipEntries);
  for (const e of zipEntries) e.data = null;
  const zipName = `${hcActiveProject}_organized_${tag}.zip`;
  triggerDownload(new Blob([bytes], { type: 'application/zip' }), zipName);
  hcLog(`✓ ${zipName} (${(bytes.byteLength/1024/1024).toFixed(1)} MB) downloaded`, 'ok');
}

// Split mode (Discord-friendly): bin-pack each category's files into ≤ HC_SPLIT_BYTES chunks.
// Each chunk stays single-category so naming is meaningful (e.g. `SNTB30MWH_PCS_2of3_DDMMYYYY.zip`).
async function hcExportZipChunked(byCategory, tag) {
  // Plan chunks first so we know how many parts each category needs (for the "X of N" suffix)
  const chunks = [];   // { label, entries }
  for (const cat of HC_CATS) {
    const list = byCategory[cat.key] || [];
    if (!list.length) continue;
    // Greedy bin-pack
    const catChunks = [];
    let cur = { entries: [], size: 0 };
    for (const f of list) {
      const fSize = (f.file.size || 0) + f.zipPath.length + 100;   // overhead estimate per entry
      if (cur.size + fSize > HC_SPLIT_BYTES && cur.entries.length) {
        catChunks.push(cur);
        cur = { entries: [], size: 0 };
      }
      cur.entries.push(f);
      cur.size += fSize;
    }
    if (cur.entries.length) catChunks.push(cur);
    catChunks.forEach((c, i) => {
      const suffix = catChunks.length > 1 ? `_${i+1}of${catChunks.length}` : '';
      chunks.push({ label: `${cat.key}${suffix}`, entries: c.entries });
    });
  }
  hcLog(`Splitting into ${chunks.length} ZIP part(s) for ${hcActiveProject} (≤${(HC_SPLIT_BYTES/1024/1024).toFixed(1)} MB each)`, 'info');
  hcSetProgress(0, true);
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const zipFiles = [];
    for (const f of chunk.entries) {
      const data = new Uint8Array(await f.file.arrayBuffer());
      zipFiles.push({ name: f.zipPath, data });
      // intra-chunk yield is rarely needed (chunk capped at 9.5 MB), but guard for many small files
      if ((zipFiles.length & 31) === 0) await new Promise(r => setTimeout(r, 0));
    }
    const bytes = hcBuildZip(zipFiles);
    for (const e of zipFiles) e.data = null;
    const zipName = `${hcActiveProject}_${chunk.label}_${tag}.zip`;
    triggerDownload(new Blob([bytes], { type: 'application/zip' }), zipName);
    hcLog(`  ✓ [${ci+1}/${chunks.length}] ${zipName} (${(bytes.byteLength/1024/1024).toFixed(2)} MB · ${chunk.entries.length} files)`, 'ok');
    hcSetProgress(((ci+1) / chunks.length) * 100, true);
    // Slight delay between consecutive downloads — some browsers throttle / prompt otherwise
    await new Promise(r => setTimeout(r, 350));
  }
  hcSetProgress(100, false);
}

// Build a .mat (Data.Plant_XX.<cat>.<signal>) from the active project's collected files,
// using auto-filled (sanitized) variable names. Returns Uint8Array of the .mat or null if empty.
async function hcBuildMatBytes() {
  const POC_SUBKEY_LOCAL = { POC_FVSOC: 'f_voltage_soc', POC_PQ: 'p_q', POC_REMOTEP: 'remote_p', POC_PVSMOOTH: 'pv_smoothing' };
  const dataFields = [];
  for (const plant of hcCurrentPlants()) {
    const plantFields = [];
    const pocFields = [];
    for (const cat of HC_CATS) {
      const items = plant.files[cat.key];
      if (!items.length) continue;
      if (cat.key === 'POC') {
        // Split POC by sub-type detected by health check
        const sub = { POC_FVSOC: [], POC_PQ: [], POC_REMOTEP: [] };
        for (const it of items) {
          const t = it.report && it.report.entry && it.report.entry.type;
          if (sub[t]) sub[t].push(it);
        }
        for (const subType of Object.keys(sub)) {
          if (!sub[subType].length) continue;
          const fields = await hcConcatFieldsForType(subType, sub[subType]);
          if (fields && fields.length) pocFields.push({ name: POC_SUBKEY_LOCAL[subType], kind: 'struct', fields });
        }
      } else {
        const fields = await hcConcatFieldsForType(cat.key, items);
        if (fields && fields.length) plantFields.push({ name: cat.key, kind: 'struct', fields });
      }
    }
    if (pocFields.length) plantFields.unshift({ name: 'POC', kind: 'struct', fields: pocFields });
    if (plantFields.length) dataFields.push({ name: plant.name, kind: 'struct', fields: plantFields });
  }
  if (!dataFields.length) { hcLog('Nothing to convert (no files)', 'warn'); return null; }
  return writeMatV5('Data', dataFields);
}

// Read all files of a single (typeKey) bucket, concat across files, return field list
// suitable for buildStruct. Streams (one file at a time) to keep peak memory bounded —
// otherwise a 1000+ file project would balloon to GB during the build phase.
async function hcConcatFieldsForType(typeKey, items) {
  const cfg = TYPE[typeKey];
  if (!cfg) return null;

  // Pass 1: header probe only (reads first 6 rows / file, ~bytes each)
  const allHeaders = [];
  const seenH = new Set();
  for (let i = 0; i < items.length; i++) {
    try {
      const probe = await readWorkbookHeaderProbe(items[i].file);
      const headerRow = (probe.aoa[cfg.headerRow]) || [];
      const headers = headerRow.map(h => h == null ? '' : String(h));
      for (let c = cfg.contextCols; c < headers.length; c++) {
        const h = headers[c];
        if (h && !seenH.has(h)) { seenH.add(h); allHeaders.push(h); }
      }
    } catch (err) {
      console.warn('hcConcat header probe failed:', items[i].path, err);
    }
    if ((i & 15) === 0) await new Promise(r => setTimeout(r, 0));
  }

  // Build the mapping. Priority for each header:
  //   (a) user mapping in mappingByType[type] if it's a valid identifier
  //   (b) explicit '' in mappingByType[type] → skip this header
  //   (c) fallback: 'time' for time headers, sanitize(header) otherwise
  const userMap = mappingByType[typeKey] || {};
  const mapping = {};         // header → final target name
  let timeTarget = null;
  let userMappedN = 0, autoFilledN = 0, skippedN = 0;
  const usedTargets = new Set();
  for (const h of allHeaders) {
    const u = userMap[h];
    if (u !== undefined && String(u).trim() === '') { skippedN++; continue; }
    let base;
    if (u && isValidIdent(String(u).trim())) { base = String(u).trim(); userMappedN++; }
    else { base = isTimeHeader(h) ? 'time' : sanitize(h); autoFilledN++; }
    let n = base, i = 1;
    while (usedTargets.has(n)) n = `${base}_${++i}`;
    usedTargets.add(n);
    mapping[h] = n;
    if (isTimeHeader(h)) timeTarget = n;
  }

  // Avoid colliding with the auto 'device_name' field
  if (cfg.hasDeviceCol) {
    for (const h of Object.keys(mapping)) {
      if (mapping[h] === 'device_name') {
        let n = 'device_name_h', i = 1;
        while (usedTargets.has(n)) n = `device_name_h_${++i}`;
        usedTargets.add(n);
        mapping[h] = n;
      }
    }
  }
  hcLog(`  ${typeKey}: ${userMappedN} from mapping panel · ${autoFilledN} auto-filled · ${skippedN} skipped`, 'info');

  // Pass 2: stream-read each file, accumulate, drop the row block immediately
  const numAccs = {};         // target → _DoubleAccum
  const timeVals = [];
  const devVals  = [];
  const isTimeMap = {};
  for (const h of Object.keys(mapping)) isTimeMap[mapping[h]] = isTimeHeader(h);

  for (let fi = 0; fi < items.length; fi++) {
    const item = items[fi];
    let headers, rows;
    try {
      const blk = await readDataBlock({ file: item.file, path: item.path, type: typeKey });
      headers = blk.headers;
      rows    = blk.rows;
    } catch (err) {
      console.warn('hcConcat read failed:', item.path, err);
      continue;
    }
    const N = rows.length;
    const colIdx = {};
    for (const h of Object.keys(mapping)) colIdx[mapping[h]] = headers.indexOf(h);
    const devIdx = cfg.hasDeviceCol ? 2 : -1;

    for (const target of Object.keys(colIdx)) {
      const idx = colIdx[target];
      if (isTimeMap[target]) {
        if (idx < 0) { for (let i = 0; i < N; i++) timeVals.push(''); }
        else         { for (let i = 0; i < N; i++) timeVals.push(formatTimestamp(rows[i][idx])); }
      } else {
        const acc = (numAccs[target] ||= new _DoubleAccum());
        if (idx < 0) { for (let i = 0; i < N; i++) acc.push(NaN); }
        else         { for (let i = 0; i < N; i++) acc.push(toFloat(rows[i][idx])); }
      }
    }
    if (cfg.hasDeviceCol) {
      for (let i = 0; i < N; i++) {
        const v = rows[i][devIdx];
        devVals.push(v == null || String(v).trim() === '' ? '' : String(v).trim());
      }
    }
    // Help the GC release the rows block before the next file
    rows = null;
    headers = null;
    if ((fi & 7) === 0) await new Promise(r => setTimeout(r, 0));
  }

  // Build the field list (time first, then device_name, then numeric signals)
  const out = [];
  if (timeTarget && timeVals.length) out.push({ name: timeTarget, kind: 'cellstr', values: timeVals });
  if (cfg.hasDeviceCol && devVals.length) out.push({ name: 'device_name', kind: 'cellstr', values: devVals });
  for (const target of Object.keys(numAccs)) {
    const arr = numAccs[target].toFloat64Array();
    out.push({ name: target, kind: 'double', arr, dims: [arr.length, 1] });
  }
  return out;
}

// Parse "yyyy-MM-dd HH:mm:ss" or a JS Date or Excel serial → ms epoch (or NaN).
function tsMs(v) {
  if (v == null) return NaN;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return Math.round((v - 25569) * 86400000);
  const raw = String(v).trim();
  if (!raw || /^(average|max|min|total)$/i.test(raw)) return NaN;
  
  // Try YYYY-MM-DD HH:mm:ss
  const normalized = raw.replace(/\//g, "-");
  let match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (match) {
    const [, y, mo, d, h, mi, s] = match;
    return new Date(+y, +mo - 1, +d, +h, +mi, s ? +s : 0).getTime();
  }
  
  // Try DD-Mon-YYYY HH:mm:ss
  match = normalized.match(/^(\d{1,2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{4})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/i);
  if (match) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const mo = months.indexOf(match[2].toLowerCase().slice(0, 3));
    const h = match[4] ? +match[4] : 0;
    const mi = match[5] ? +match[5] : 0;
    const s = match[6] ? +match[6] : 0;
    return new Date(+match[3], mo, +match[1], h, mi, s).getTime();
  }
  
  const fallback = new Date(raw);
  const t = fallback.getTime();
  return Number.isNaN(t) ? NaN : t;
}
function tsToISO(ms) {
  if (!isFinite(ms)) return '-';
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// Run health check on one xlsx entry. Returns a report object.
async function hcCheckFile(o) {
  // Probe to classify
  let type = null, plantId = 'Plant_unknown', deviceName = '';
  try {
    const probe = await readWorkbookHeaderProbe(o.file);
    const aoa = probe.aoa;
    const firstRow = aoa[0] || [];
    type = classifyFile(o.file.name, firstRow);
    if (!type) {
      const r3 = aoa[3] || [];
      if (r3[0] === 'Plant Name' && r3[3] === 'Start Time') {
        type = /smartlogger/i.test(o.file.name) ? 'SmartLogger' : (/^pcs/i.test(o.file.name) ? 'PCS' : 'ESS');
      }
    }
    if (!type) return { entry: { ...o, type: null, plantId, deviceName }, status: 'critical', statusReason: ['unclassified'], reasons: ['unclassified'], N: 0 };
    plantId = extractPlantId(o.path, o.file);
    if (TYPE[type].hasDeviceCol) {
      const r = aoa[TYPE[type].dataStart];
      if (r && r[2] != null) deviceName = String(r[2]).trim();
    }
  } catch (err) {
    return { entry: { file: o.file, path: o.path, type: null, plantId, deviceName }, status: 'critical', statusReason: [`probe failed: ${err.message}`], reasons: [`probe failed: ${err.message}`], N: 0 };
  }

  const entry = { file: o.file, path: o.path, type, plantId, deviceName, headers: [] };
  const cfg = TYPE[type];
  const { headers, rows } = await readDataBlock(entry);
  // Populate signal headers (excluding context cols) so the entry can be reused by the Convert tab
  entry.headers = headers.slice(cfg.contextCols);
  const N = rows.length;

  // Time column: ESS/SL/PCS → 'Start Time' (idx 3); POC → idx 0
  const timeCol = cfg.hasDeviceCol ? Math.max(headers.indexOf('Start Time'), 3) : 0;
  const times = [];
  let nullTimes = 0;
  for (const r of rows) {
    const t = tsMs(r[timeCol]);
    if (isNaN(t)) nullTimes++; else times.push(t);
  }
  times.sort((a, b) => a - b);

  const startTime = times.length ? times[0] : null;
  const endTime   = times.length ? times[times.length - 1] : null;
  const durSec    = startTime != null ? (endTime - startTime) / 1000 : 0;

  const intervals = [];
  for (let i = 1; i < times.length; i++) intervals.push((times[i] - times[i-1]) / 1000);
  const sortedIv = [...intervals].sort((a, b) => a - b);
  const median = sortedIv.length ? sortedIv[Math.floor(sortedIv.length / 2)] : 0;
  const gapThreshold = Math.max(median * 3, median + 60);
  let gaps = 0, totalGapSec = 0;
  for (const dt of intervals) if (dt > gapThreshold) { gaps++; totalGapSec += dt; }

  // Missing-value tally over signal columns
  const sigStart = cfg.contextCols;
  let totalCells = 0, missingCells = 0;
  for (let c = sigStart; c < headers.length; c++) {
    if (c === timeCol) continue;
    if (cfg.hasDeviceCol && c === 2) continue;
    for (const r of rows) {
      totalCells++;
      const val = r[c];
      if (isNaN(toFloat(val))) {
        const s = val != null ? String(val).trim() : '';
        // Robust exclusion rules:
        // 1. Exclude hyphens/placeholders: '-', '--'
        if (s === '-' || s === '--') {
          continue;
        }
        // 2. Exclude descriptive string statuses: e.g., 'Grid connected', 'Boundary derating'
        // If it contains letters and is NOT in the MISSING set, it's a valid status string!
        if (/[A-Za-z]/.test(s) && !MISSING.has(s)) {
          continue;
        }
        missingCells++;
      }
    }
  }
  const missingPct = totalCells ? missingCells / totalCells : 0;

  // Status
  let status = 'ok';
  const reasons = [];
  const downgrade = (cur, to) => (cur === 'critical' || to === 'critical') ? 'critical' : (cur === 'warning' || to === 'warning') ? 'warning' : 'ok';
  if (N === 0) { status = 'critical'; reasons.push('no data rows'); }
  if (nullTimes > 0) { status = downgrade(status, 'critical'); reasons.push(`${nullTimes} unparseable timestamps`); }
  if (gaps > 0) { status = downgrade(status, gaps > 5 ? 'critical' : 'warning'); reasons.push(`${gaps} time gap${gaps>1?'s':''}`); }
  if (missingPct > 0.20) { status = downgrade(status, 'critical'); reasons.push(`${(missingPct*100).toFixed(1)}% missing`); }
  else if (missingPct > 0.05) { status = downgrade(status, 'warning'); reasons.push(`${(missingPct*100).toFixed(1)}% missing`); }
  if (durSec > 0 && durSec < 1 * 3600 && N > 50) { status = downgrade(status, 'warning'); reasons.push(`coverage only ${(durSec/3600).toFixed(1)}h`); }

  return { entry, N, deviceName, startTime, endTime, durSec, median, gaps, totalGapSec, missingPct, nullTimes, status, statusReason: reasons, reasons: reasons };
}



// --- REACT INTEGRATION EXPORTS ---
export {
  hcInitProjects,
  hcBulkImport, hcAcceptFiles, hcRunExport,
  hcAddPlant,
  hcDeletePlant,
  hcResetActiveProject,
  hcByProject,
  HC_PROJECTS,
  HC_CATS,
  hcLogHistory,
  TYPE,
  fileEntries,
  mappingByType,
  groupedByType,
  expandZip,
  extractDataDate
};

export function hcForceStop() {
  hcBusy = false;
  hcSetProgress(0, false);
}

var reactUpdateCb = null;
export function setReactUpdateCb(cb) { reactUpdateCb = cb; }

export function getHcActiveProject() { return hcActiveProject; }
export function setHcActiveProject(val) { hcActiveProject = val; if(reactUpdateCb) reactUpdateCb('plants'); }

export function getHcBusy() { return typeof hcBusy !== 'undefined' ? hcBusy : false; }
