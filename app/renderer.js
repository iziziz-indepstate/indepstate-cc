// renderer.js — crypto & equities cards, stable UI state, safe layout
const {ipcRenderer} = require('electron');
const path = require('path');
const loadConfig = require('./config/load');
const settingsRuntime = require('./services/settings');
const servicesApi = require('./services/servicesApi');
const tradeRules = servicesApi.tradeRules || require('./services/tradeRules');
const {detectInstrumentType} = require("./services/instruments");
const {findTickSizeOverride, getDefaultTickSize} = require('./services/instrumentInfo/points');
const orderCalc = servicesApi.orderCalculator || require('./services/orderCalculator');
const { createInstrumentInfoRenderer } = require('./services/instrumentInfo/renderer');
const { createPositionsRenderer } = require('./services/positions/renderer');
const { createSettingsRenderer } = require('./services/settings/renderer');
const { createPendingOrdersRenderer } = require('./services/pendingOrders/renderer');
const { createCardRuntime } = require('./infrastructure/renderer/cardRuntime');
const { isDebugPositionEventsEnabled, debugPositionEvents, positionDebugSummary } = require('./debugPositionEvents');

debugPositionEvents('renderer.boot:start');

function registerRendererDebugErrorForwarding() {
  if (!isDebugPositionEventsEnabled() || typeof window === 'undefined') return;
  window.addEventListener('error', (event) => {
    debugPositionEvents('renderer.error', {
      message: event.message || event.error?.message || '',
      filename: event.filename || '',
      lineno: event.lineno || 0,
      colno: event.colno || 0,
      stack: event.error?.stack || ''
    }, 'warn');
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    debugPositionEvents('renderer.unhandledrejection', {
      message: reason?.message || String(reason || ''),
      stack: reason?.stack || ''
    }, 'warn');
  });
}

registerRendererDebugErrorForwarding();

const defaultInstrumentDisplayPolicy = {
  getInstrumentRefreshMs: () => 1000,
  shouldShowBidAsk: () => false,
  shouldShowSpread: () => false
};
const testingExtensions = {};
let state;
let uiState;
let cardStateApi;
let cardRuntime;

const $wrap = document.getElementById('wrap');
const $grid = document.getElementById('grid');
const $filter = document.getElementById('filter');
const $cmdline = document.getElementById('cmdline');
const $settingsBtn = document.getElementById('settings-btn');
const $settingsPanel = document.getElementById('settings-panel');
const $settingsSections = document.getElementById('settings-sections');
const $settingsFields = document.getElementById('settings-fields');
const $settingsClose = document.getElementById('settings-close');
const $settingsRestart = document.getElementById('settings-restart-required');

state = { filter: '', autoscroll: true };
uiState = new Map();
cardRuntime = createCardRuntime({ state, uiState });
cardStateApi = cardRuntime.stateApi;
const rendererOrderStateFacades = cardRuntime.stateFacades;

ipcRenderer.invoke('settings:get', 'ui').then((res) => {
  if (res && typeof res.autoscroll === 'boolean') {
    state.autoscroll = res.autoscroll;
  } else if (res?.config && typeof res.config.autoscroll === 'boolean') {
    state.autoscroll = res.config.autoscroll;
  }
}).catch(() => {});

const settingsRenderer = createSettingsRenderer({
  ipcRenderer,
  settingsRuntime,
  loadConfig,
  path,
  baseDir: __dirname,
  document,
  elements: {
    settingsBtn: $settingsBtn,
    settingsPanel: $settingsPanel,
    settingsSections: $settingsSections,
    settingsFields: $settingsFields,
    settingsClose: $settingsClose,
    settingsRestart: $settingsRestart
  },
  toast,
  render
});
const settingsForms = settingsRenderer.settingsForms;
let rendererServiceManifests = null;
const rendererHandlerDiagnostics = {
  serviceList: null,
  manifests: [],
  handlers: [],
  legacyOrderCardsRegistered: false
};

loadRendererHooks();
debugPositionEvents('renderer.boot:after-hooks');

settingsRuntime.onApply('ui', ({ config }) => {
  if (typeof config.autoscroll === 'boolean') state.autoscroll = config.autoscroll;
});
settingsRuntime.onApply('order-calculator', () => render());

function loadRendererServiceManifests() {
  if (rendererServiceManifests) return rendererServiceManifests;
  let dirs = [];
  try {
    dirs = loadConfig('../services/settings/config/services.json');
  } catch (err) {
    debugPositionEvents('renderer.manifest:service-list-load-failed', {
      error: err?.message || String(err),
      stack: err?.stack || '',
      configRoots: Array.isArray(loadConfig.CONFIG_ROOTS) ? loadConfig.CONFIG_ROOTS.slice() : []
    }, 'warn');
    dirs = [];
  }
  rendererHandlerDiagnostics.serviceList = {
    dirs: Array.isArray(dirs) ? dirs.slice() : [],
    configRoots: Array.isArray(loadConfig.CONFIG_ROOTS) ? loadConfig.CONFIG_ROOTS.slice() : [],
    appRoot: loadConfig.APP_ROOT,
    userRoot: loadConfig.USER_ROOT
  };
  debugPositionEvents('renderer.manifest:service-list', rendererHandlerDiagnostics.serviceList);
  rendererServiceManifests = [];
  if (!Array.isArray(dirs)) return rendererServiceManifests;
  for (const dir of dirs) {
    try {
      const manifest = require(path.join(__dirname, dir, 'manifest.js'));
      rendererServiceManifests.push({ dir, manifest });
      rendererHandlerDiagnostics.manifests.push({
        dir,
        rendererHandlers: Array.isArray(manifest?.rendererHandlers) ? manifest.rendererHandlers.length : 0,
        rendererPositionHandlers: Array.isArray(manifest?.rendererPositionHandlers) ? manifest.rendererPositionHandlers.length : 0
      });
    } catch (err) {
      const failure = {
        dir,
        failed: true,
        error: err?.message || String(err),
        stack: err?.stack || ''
      };
      rendererHandlerDiagnostics.manifests.push(failure);
      console.error('[rendererServiceLoader] Failed to load', dir, err.message);
      debugPositionEvents('renderer.manifest:load-failed', failure, 'warn');
    }
  }
  return rendererServiceManifests;
}

function loadRendererHooks() {
  for (const { manifest } of loadRendererServiceManifests()) {
    if (typeof manifest?.hookRenderer === 'function') {
      manifest.hookRenderer(ipcRenderer);
    }
  }
}

function loadRendererHandlers(context = {}) {
  for (const { dir, manifest } of loadRendererServiceManifests()) {
    const handlerGroups = [
      ['rendererHandlers', Array.isArray(manifest?.rendererHandlers) ? manifest.rendererHandlers : []],
      ['rendererPositionHandlers', Array.isArray(manifest?.rendererPositionHandlers) ? manifest.rendererPositionHandlers : []]
    ];
    for (const [group, handlers] of handlerGroups) {
      for (const handler of handlers) {
        const handlerInfo = {
          dir,
          group,
          cardType: handler?.cardType || handler?.type || null,
          registered: false
        };
        rendererHandlerDiagnostics.handlers.push(handlerInfo);
        if (typeof handler?.register !== 'function') {
          handlerInfo.skipped = 'missing register';
          debugPositionEvents('renderer.handlers:skip', handlerInfo, 'warn');
          continue;
        }
        try {
          debugPositionEvents('renderer.handlers:before-register', handlerInfo);
          handler.register(context);
          handlerInfo.registered = true;
          debugPositionEvents('renderer.handlers:after-register', handlerInfo);
        } catch (err) {
          handlerInfo.error = err?.message || String(err);
          console.error('[rendererServiceLoader] Failed to register renderer handler', {
            dir,
            group,
            cardType: handlerInfo.cardType,
            error: handlerInfo.error,
            stack: err?.stack || ''
          });
          debugPositionEvents('renderer.handlers:error', handlerInfo, 'warn');
        }
      }
    }
  }
}

// ======= Utils =======
function findKeyByTicker(ticker) {
  const row = rendererRows().find(r => r.ticker === ticker);
  return row ? rowKey(row) : null;
}

function rowKey(row) {
  return `${row.ticker}|${row.event}|${row.time}|${row.price}`;
}

function positionMatchesLegacyRow(position = {}, row = {}) {
  const source = position.source || {};
  const data = position.card?.data || {};
  const positionTicker = source.ticker || source.symbol || data.ticker || data.symbol || position.ticker || position.symbol;
  const rowTicker = row.ticker || row.symbol;
  if (!positionTicker || !rowTicker || String(positionTicker) !== String(rowTicker)) return false;

  const positionCardType = source.cardType || position.card?.type;
  if (positionCardType && row.cardType && String(positionCardType) !== String(row.cardType)) return false;

  if (source.event != null || source.time != null || source.price != null) {
    return rowKey({
      ticker: source.ticker || source.symbol || positionTicker,
      event: source.event,
      time: source.time,
      price: source.price
    }) === rowKey({
      ticker: row.ticker || row.symbol,
      event: row.event,
      time: row.time,
      price: row.price
    });
  }

  return String(positionCardType || '') === String(row.cardType || '');
}

function regularCardType(value) {
  return String(value || 'regular') === 'regular';
}

function isRegularPositionSnapshot(position = {}) {
  return regularCardType(position.card?.type || position.source?.cardType || 'regular');
}

function isPositionRenderedByLegacyRow(position = {}) {
  if (isRegularPositionSnapshot(position)) return false;
  return rendererRows().some(row => positionMatchesLegacyRow(position, row));
}

function registerRendererExtension(kind, extension) {
  return cardRuntime.registerRendererExtension(kind, extension);
}

function registerInstrumentDisplayPolicy(policy) {
  return cardRuntime.registerInstrumentDisplayPolicy(policy);
}

function registerCardStateHook(hook) {
  return cardRuntime.registerCardStateHook(hook);
}

function registerRendererLayer(layer) {
  return cardRuntime.registerRendererLayer(layer);
}

function registerRendererRowProvider(provider) {
  return cardRuntime.registerRendererRowProvider(provider);
}

function rendererRows() {
  return cardRuntime.rendererRows();
}

function registerPositionSnapshotHook(hook) {
  return cardRuntime.registerPositionSnapshotHook(hook);
}

function registerPositionRemovedHook(hook) {
  return cardRuntime.registerPositionRemovedHook(hook);
}

function registerTestingExtension(name, value) {
  const key = String(name || '').trim();
  if (!key) return false;
  testingExtensions[key] = value;
  return () => {
    if (testingExtensions[key] === value) delete testingExtensions[key];
  };
}

function notifyPositionSnapshot(position = {}) {
  for (const hook of cardRuntime.positionSnapshotHooks) {
    try {
      hook(position);
    } catch (err) {
      console.error('[rendererExtension] position snapshot hook failed', err?.message || err);
    }
  }
}

function notifyPositionRemoved(positionOrEvent = {}) {
  let removed = false;
  try {
    removed = cardRuntime.cleanupPositionCard(positionOrEvent) === true || removed;
  } catch (err) {
    console.error('[cardRuntime] position cleanup failed', err?.message || err);
  }
  for (const hook of cardRuntime.positionRemovedHooks) {
    try {
      removed = hook(positionOrEvent) === true || removed;
    } catch (err) {
      console.error('[rendererExtension] position removed hook failed', err?.message || err);
    }
  }
  return removed;
}

function instrumentDisplayPolicyValue(method) {
  const policies = cardRuntime.rendererExtensions.instrumentDisplayPolicy || [];
  for (let index = policies.length - 1; index >= 0; index -= 1) {
    const policy = policies[index];
    if (typeof policy?.[method] !== 'function') continue;
    const value = policy[method]();
    if (value !== undefined) return value;
  }
  return defaultInstrumentDisplayPolicy[method]();
}

function getInstrumentRefreshMs() {
  const value = Number(instrumentDisplayPolicyValue('getInstrumentRefreshMs'));
  return Number.isFinite(value) && value > 0 ? value : defaultInstrumentDisplayPolicy.getInstrumentRefreshMs();
}

function shouldShowBidAsk() {
  return !!instrumentDisplayPolicyValue('shouldShowBidAsk');
}

function shouldShowSpread() {
  return !!instrumentDisplayPolicyValue('shouldShowSpread');
}

function notifyCardRestored(args = {}) {
  const hooks = cardRuntime.rendererExtensions.cardStateHook || [];
  for (const hook of hooks) {
    try {
      hook(args);
    } catch (err) {
      console.error('[rendererExtension] cardStateHook failed', err?.message || err);
    }
  }
}

function positionKey(position = {}) {
  return `position|${position.id}`;
}

function _normNum(val) {
  if (val == null) return null;
  const s = String(val).trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function isPos(n) {
  return typeof n === 'number' && isFinite(n) && n > 0;
}

function isSL(n) {
  return typeof n === 'number' && isFinite(n) && n > 0;
}

function priceToPoints(inp, price, row, commit = false) {
  const raw = String(inp?.value ?? '').trim();
  if (!raw || !raw.includes('.')) return _normNum(raw);
  const pr = _normNum(price);
  if (!isPos(pr)) return _normNum(raw);
  const val = _normNum(raw);
  if (val == null) return val;
  const tick = tickSize(row);
  if (!Number.isFinite(tick) || tick <= 0) return undefined;
  const pts = Math.abs(pr - val) / tick
  if (Number.isFinite(pts)) {
    const rounded = Math.round(pts);
    if (commit) inp.value = String(rounded);
    return rounded;
  }
  return val;
}


function el(tag, className, text, attrs) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

function inputNumber(ph, cls) {
  const i = document.createElement('input');
  i.type = 'number';
  i.placeholder = ph;
  i.inputMode = 'decimal';
  i.step = 'any';
  i.className = cls ? `num ${cls}` : 'num';
  return i;
}

function btn(text, className, onClick) {
  const b = document.createElement('button');
  b.className = `btn ${className}`;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function cssEsc(s) {
  try {
    return CSS.escape(s);
  } catch {
    return String(s).replace(/"/g, '\\"');
  }
}

function cardByKey(key) {
  return $grid.querySelector(`.card[data-rowkey="${cssEsc(key)}"]`);
}

function shakeCard(key) {
  const card = cardByKey(key);
  if (!card) return;
  card.classList.add('card--shake');
  setTimeout(() => card.classList.remove('card--shake'), 600);
}

function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    Object.assign(t.style, {
      position: 'fixed', right: '12px', bottom: '12px',
      padding: '10px 12px', background: 'rgba(0,0,0,.8)', color: '#fff',
      fontSize: '12px', borderRadius: '8px', zIndex: 9999, maxWidth: '60ch'
    });
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._h);
  t._h = setTimeout(() => {
    t.style.opacity = '0';
  }, 2500);
}

window.toast = toast;

function setCardState(key, state) {
  if (state) {
    cardStateApi.setCardState(key, state);
  } else {
    cardStateApi.clearCardState(key);
  }

  const card = cardByKey(key);
  if (!card) return;
  const status = card.querySelector('.card__status');
  const retryBtn = card.querySelector('.retry-btn');
  if (!status) return;

  const inputs = card.querySelectorAll('input');
  const buttons = card.querySelectorAll('button.btn');

  if (state) {
    status.style.display = 'inline-block';
    status.className = `card__status card__status--${state}`;
    if (state === 'pending-exec') {
      const lbl = cardStateApi.getPendingExecLabel(key);
      status.textContent = lbl ? `pe (${lbl})` : 'pe';
    } else {
      cardStateApi.clearPendingExecLabel(key);
      status.textContent = '';
    }
    card.classList.toggle('card--pending', state === 'pending' || state === 'pending-exec');
    inputs.forEach(inp => { inp.disabled = true; });
    buttons.forEach(btn => { btn.disabled = true; });

    if (state === 'pending-exec') {
      status.style.cursor = 'pointer';
      status.title = 'Cancel pe';
      status.onclick = () => {
        const reqId = card.dataset.reqId;
        const pendingId = card.dataset.pendingId || (reqId ? cardStateApi.getPendingId(reqId) : null);
        if (pendingId) ipcRenderer.invoke('pending:cancel', pendingId).catch(() => {});
        if (reqId) {
          cardStateApi.clearPendingRequest(reqId);
          delete card.dataset.reqId;
        }
        delete card.dataset.pendingId;
        setCardState(key, null);
        render();
      };
    } else {
      status.style.cursor = '';
      status.title = '';
      status.onclick = null;
      card.style.cursor = '';
      card.title = '';
      card.onclick = null;
    }

    if (retryBtn) {
      if (state === 'pending') {
        retryBtn.style.display = 'inline-block';
        const rid = card.dataset.reqId;
        const retryCount = rid ? cardStateApi.getRetryCount(rid) : undefined;
        if (retryCount != null) retryBtn.textContent = String(retryCount);
      } else {
        retryBtn.style.display = 'none';
      }
    }
    return;
  }

  status.style.display = 'none';
  status.textContent = '';
  cardStateApi.clearPendingExecLabel(key);
  status.style.cursor = '';
  status.title = '';
  status.onclick = null;
  card.style.cursor = '';
  card.title = '';
  card.onclick = null;
  card.classList.remove('card--pending');
  notifyCardRestored({ card, updateSpreadForTicker });
  inputs.forEach(inp => { inp.disabled = false; });
  buttons.forEach(btn => { btn.disabled = false; });
  if (retryBtn) retryBtn.style.display = 'none';
  cardStateApi.deletePlacedOrder(key);
}

// --- touched helpers ---
function markTouched(ticker) {
  cardStateApi.markTouched(ticker);
}

function isTouched(ticker) {
  return cardStateApi.isTouched(ticker);
}

// ======= Rendering =======
function render() {
  $grid.innerHTML = '';
  for (const layer of cardRuntime.rendererLayers) {
    try {
      layer({ grid: $grid });
    } catch (err) {
      console.error('[rendererExtension] render layer failed', err?.message || err);
    }
  }
  const debugPositions = isDebugPositionEventsEnabled();
  const positions = getPositionSnapshots();
  positions.sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0));
  let renderedPositionCount = 0;
  const skippedPositions = [];
  for (const position of positions) {
    if (shouldHidePositionSnapshot(position)) {
      if (debugPositions) skippedPositions.push({ reason: 'hidden', ...positionDebugSummary(position) });
      continue;
    }
    if (!shouldUseSnapshotInsteadOfLegacyRows(position) && isPositionRenderedByLegacyRow(position)) {
      if (debugPositions) skippedPositions.push({ reason: 'legacy-rendered', ...positionDebugSummary(position) });
      continue;
    }
    const key = positionKey(position);
    let card;
    if (debugPositions) {
      try {
        card = createPositionSnapshotCard(position);
      } catch (err) {
        skippedPositions.push({
          reason: 'renderer error',
          error: err?.message || String(err),
          ...positionDebugSummary(position)
        });
        debugPositionEvents('renderer.render:position-error', {
          error: err?.message || String(err),
          ...positionDebugSummary(position)
        }, 'warn');
        continue;
      }
    } else {
      card = createPositionSnapshotCard(position);
    }
    $grid.appendChild(card);
    renderedPositionCount += 1;
    const reqId = cardStateApi.findPendingRequestIdByKey(key);
    if (reqId) card.dataset.reqId = reqId;
    const st = cardStateApi.getCardState(key);
    if (st) setCardState(key, st);
  }
  debugPositionEvents('renderer.render:positions', {
    positionsByIdSize: positionsById.size,
    renderedPositionCount,
    skippedPositions
  });
  if (state.autoscroll) {
    try {
      $wrap.scrollTo({top: 0, behavior: 'smooth'});
    } catch {
    }
  }
}


function positionCardTitle(position = {}) {
  const data = position.card?.data || {};
  return data.ticker || data.symbol || position.ticker || position.symbol || position.id || 'Position';
}

function formatPositionValue(value) {
  if (value == null || value === '') return '-';
  if (typeof value === 'object') {
    if (value.status && value.value != null) return `${value.status}: ${value.value}`;
    if (value.status) return value.status;
    return JSON.stringify(value);
  }
  return String(value);
}

function appendPositionDataField(parent, key, label, value) {
  const item = el('div', 'position-card__field');
  item.dataset.field = key;
  item.appendChild(el('span', 'position-card__field-label', label));
  item.appendChild(el('span', 'position-card__field-value', formatPositionValue(value)));
  parent.appendChild(item);
}

function createPositionDataGrid(fields) {
  const grid = el('div', 'position-card__data');
  Object.assign(grid.style, {
    display: 'grid',
    gridTemplateColumns: 'repeat(2,minmax(0,1fr))',
    gap: '6px',
    fontSize: '11px'
  });
  for (const field of fields) appendPositionDataField(grid, field.key, field.label, field.value);
  return grid;
}

let positionsRenderer = null;
let positionsById = new Map();
const getPositionSnapshots = () => Array.from(positionsById.values());

function positionInstrumentRows() {
  return getPositionSnapshots().map(position => {
    const data = position.card?.data || {};
    const source = position.source || {};
    const ticker = data.ticker || data.symbol || position.ticker || position.symbol || source.ticker || source.symbol;
    return {
      ticker,
      symbol: data.symbol || position.symbol || ticker,
      provider: data.provider || position.provider || source.provider,
      instrumentType: data.instrumentType || position.instrumentType || source.instrumentType,
      cardType: position.card?.type
    };
  }).filter(row => row.ticker);
}

const instrumentInfoRenderer = createInstrumentInfoRenderer({
  ipcRenderer,
  state,
  getInstrumentRefreshMs,
  shouldShowBidAsk,
  shouldShowSpread,
  findTickSizeOverride,
  getDefaultTickSize,
  cardByKey,
  cssEsc,
  getGrid: () => $grid,
  render,
  getRows: () => rendererRows().concat(positionInstrumentRows()),
  findRowByTicker: (ticker) => rendererRows().find(r => r.ticker === ticker) || positionInstrumentRows().find(r => r.ticker === ticker),
  revalidateCard: (card) => {
    if (typeof card._validate !== 'function') return;
    try {
      card._validate(false);
    } catch (_) {
    }
  }
});
const instrumentInfo = instrumentInfoRenderer.instrumentInfo;
const instrumentInfoFor = (...args) => instrumentInfoRenderer.instrumentInfoFor(...args);
const ensureInstrument = (...args) => instrumentInfoRenderer.ensureInstrument(...args);
const forgetInstrument = (...args) => instrumentInfoRenderer.forgetInstrument(...args);
const tickSize = (...args) => instrumentInfoRenderer.tickSize(...args);
const formatBidAskText = (...args) => instrumentInfoRenderer.formatBidAskText(...args);
const formatSpreadTriple = (...args) => instrumentInfoRenderer.formatSpreadTriple(...args);
const updateSpreadForTicker = (...args) => instrumentInfoRenderer.updateSpreadForTicker(...args);
const revalidateCardsForTicker = (...args) => instrumentInfoRenderer.revalidateCardsForTicker(...args);
instrumentInfoRenderer.startPeriodicRefresh();

const positionActionHandlers = cardRuntime.positionActionHandlers;
const positionCardRenderers = cardRuntime.positionCardRenderers;
const positionRemovalHandlers = cardRuntime.positionRemovalHandlers;
const pendingOrdersRenderer = createPendingOrdersRenderer();

function registerRendererLegacyGuard(guard = {}) {
  return cardRuntime.registerRendererLegacyGuard(guard);
}

function shouldFilterLegacyRow(row = {}) {
  return cardRuntime.rendererLegacyGuards.some(guard => {
    if (guard.shouldFilterRow?.(row)) return true;
    const types = Array.isArray(guard.filteredRowTypes) ? guard.filteredRowTypes : [];
    return types.map(String).includes(String(row?.cardType || ''));
  });
}

function shouldIgnoreLegacyExecutionEvent(rec = {}) {
  return cardRuntime.rendererLegacyGuards.some(guard => guard.shouldIgnoreLegacyExecutionEvent?.(rec, legacyGuardContext()));
}

function shouldIgnoreLegacyPositionEvent(rec = {}) {
  return cardRuntime.rendererLegacyGuards.some(guard => guard.shouldIgnoreLegacyPositionEvent?.(rec, legacyGuardContext()));
}

function shouldHidePositionSnapshot(position = {}) {
  return cardRuntime.rendererLegacyGuards.some(guard => guard.shouldHidePositionSnapshot?.(position, legacyGuardContext()));
}

function shouldRemoveLegacyRowForPosition(position = {}, row = {}) {
  return cardRuntime.rendererLegacyGuards.some(guard => guard.shouldRemoveLegacyRowForPosition?.(position, row, legacyGuardContext()));
}

function shouldResetLegacyRowForPosition(position = {}, row = {}) {
  return cardRuntime.rendererLegacyGuards.some(guard => guard.shouldResetLegacyRowForPosition?.(position, row, legacyGuardContext()));
}

function shouldIgnoreLegacyRowForExistingPosition(row = {}) {
  const context = legacyGuardContext();
  return cardRuntime.rendererLegacyGuards.some(guard => guard.shouldIgnoreLegacyRowForExistingPosition?.(row, context));
}

function shouldRemovePositionSnapshotForLegacyRowRemoval(row = {}, position = {}) {
  const context = legacyGuardContext();
  return cardRuntime.rendererLegacyGuards.some(guard => guard.shouldRemovePositionSnapshotForLegacyRowRemoval?.(row, position, context));
}

function legacyGuardContext() {
  return {
    positions: getPositionSnapshots(),
    rows: rendererRows()
  };
}

function shouldUseSnapshotInsteadOfLegacyRows(position = {}) {
  if (isRegularPositionSnapshot(position)) return true;
  if (shouldFilterLegacyRow({ cardType: position.card?.type || position.source?.cardType })) return true;
  return rendererRows().some(row => shouldRemoveLegacyRowForPosition(position, row));
}

loadRendererHandlers({
  loadConfig,
  settingsRuntime,
  el,
  state,
  getGrid: () => $grid,
  rowKey,
  inputNumber,
  priceToPoints,
  normNum: _normNum,
  instrumentInfoFor,
  ensureInstrument,
  tickSize,
  isPos,
  isSL,
  markTouched,
  uiState,
  orderCalc,
  tradeRules,
  detectInstrumentType,
  createPositionDataGrid,
  ipcRenderer,
  trackInstrument: row => instrumentInfoRenderer.trackInstrument(row),
  untrackInstrument: row => instrumentInfoRenderer.untrackInstrument(row),
  pendingRequestLabels: rendererOrderStateFacades.pendingRequestLabels,
  placedOrderLookup: rendererOrderStateFacades.placedOrderLookup,
  cardVisualState: rendererOrderStateFacades.cardVisualState,
  ticketBinding: rendererOrderStateFacades.ticketBinding,
  setCardState,
  positionKey,
  positionCardTitle,
  cardByKey,
  toast,
  shakeCard,
  render,
  env: process.env,
  btn,
  pendingActionInfo: (kind) => pendingOrdersRenderer.actionInfo(kind),
  formatBidAskText,
  formatSpreadTriple,
  updateSpreadForTicker,
  notifyCardRestored,
  getRows: rendererRows,
  findKeyByTicker,
  cardStateOrder: {pending: 1, 'pending-exec': 2, placed: 3, executing: 4, closed: 5, profit: 6, loss: 7},
  isTerminalCardState: stateName => new Set(['closed', 'profit', 'loss']).has(stateName),
  positionRemovalHandlerFor: cardType => positionRemovalHandlers[cardType],
  positionMatchesLegacyRow,
  isRegularPositionSnapshot,
  shouldFilterLegacyRow,
  shouldIgnoreLegacyRowForExistingPosition,
  shouldIgnoreLegacyExecutionEvent,
  shouldIgnoreLegacyPositionEvent,
  shouldRemoveLegacyRowForPosition,
  shouldResetLegacyRowForPosition,
  removePositionSnapshotsForRow,
  forgetInstrument: (...args) => forgetInstrument(...args),
  dispatchPositionAction,
  requestRemovePosition,
  registerRendererExtension,
  registerInstrumentDisplayPolicy,
  registerCardStateHook,
  registerRendererLayer,
  registerRendererRowProvider,
  registerPositionSnapshotHook,
  registerPositionRemovedHook,
  registerTestingExtension,
  registerPositionCardRenderer(cardType, renderer) {
    cardRuntime.registerPositionCardRenderer(cardType, renderer);
  },
  registerPositionActionHandler(cardType, handler) {
    cardRuntime.registerPositionActionHandler(cardType, handler);
  },
  registerPositionRemovalHandler(cardType, handler) {
    cardRuntime.registerPositionRemovalHandler(cardType, handler);
  },
  registerCardType: (...args) => cardRuntime.registerCardType(...args),
  resolveCardType: (...args) => cardRuntime.resolveCardType(...args),
  registerCardView: (...args) => cardRuntime.registerCardView(...args),
  getCardView: (...args) => cardRuntime.getCardView(...args),
  registerCardControl: (...args) => cardRuntime.registerCardControl(...args),
  getCardControl: (...args) => cardRuntime.getCardControl(...args),
  registerCardShape: (...args) => cardRuntime.registerCardShape(...args),
  getCardShape: (...args) => cardRuntime.getCardShape(...args),
  cardRuntime,
  registerRendererLegacyGuard
});
debugPositionEvents('renderer.boot:after-handler-load');
debugPositionEvents('renderer.boot:after-legacy-runtime-check');

for (const { dir, manifest } of loadRendererServiceManifests()) {
  try {
    const guards = Array.isArray(manifest?.rendererLegacyGuards) ? manifest.rendererLegacyGuards : [];
    for (const guard of guards) registerRendererLegacyGuard(guard);
  } catch (err) {
    console.error('[rendererServiceLoader] Failed to load legacy guards', dir, err.message);
  }
}

positionsRenderer = createPositionsRenderer({
  ipcRenderer,
  el,
  createPositionDataGrid,
  createPositionActions,
  positionKey,
  positionCardTitle,
  render,
  positionCardRenderers,
  onPositionRemoved: removeLegacyRowsForPosition,
  onPositionSnapshot(position = {}) {
    notifyPositionSnapshot(position);
    if (!shouldUseSnapshotInsteadOfLegacyRows(position)) return;
    const key = positionKey(position);
    cardStateApi.clearCardState(key);
    cardStateApi.clearPendingExecLabel(key);
  }
});
if (!positionCardRenderers.regular) {
  positionCardRenderers.regular = position => positionsRenderer.renderRegularPositionCard(position);
}
positionsById = positionsRenderer.positionsById;
const setPositionSnapshot = (...args) => positionsRenderer.setPositionSnapshot(...args);
const removePositionSnapshot = (...args) => positionsRenderer.removePositionSnapshot(...args);

async function requestRemovePosition(position = {}) {
  const result = await ipcRenderer.invoke('positions:remove', {
    positionId: position.id,
    reason: 'renderer.remove-card'
  }).catch(err => ({ ok: false, reason: err?.message || String(err) }));
  if (!result || result.ok === false) {
    toast(`x ${positionCardTitle(position)}: ${result?.reason || 'Remove failed'}`);
    shakeCard(positionKey(position));
    return result;
  }
  const removed = (result.events || []).some(event => ['position.removed', 'position.archived'].includes(event.type))
    || ['archived', 'cancelled'].includes(result.position?.state);
  if (removed) {
    removePositionSnapshot(position.id);
    notifyPositionRemoved(position);
    render();
  }
  return result;
}

function legacyPayloadForPositionAction(position = {}, action = {}) {
  const data = position.card?.data || {};
  const payload = {
    ...(action.payload || {}),
    ticker: data.ticker || position.ticker || data.symbol || position.symbol,
    symbol: data.symbol || position.symbol || data.ticker || position.ticker,
    provider: data.provider || position.provider,
    instrumentType: position.instrumentType || data.instrumentType,
    action: action.id || action.label,
    positionId: position.id
  };
  return payload;
}

async function dispatchPositionAction(position = {}, action = {}, inputPayload = {}) {
  const id = String(action.id || action.label || '').toUpperCase();
  const base = {
    ...legacyPayloadForPositionAction(position, action),
    ...inputPayload
  };

  const serviceResult = positionActionHandlers[position.card?.type]?.(position, action, base);
  if (serviceResult !== undefined) return serviceResult;

  const command = action.command || '';
  if (command === 'position.open') {
    return ipcRenderer.invoke('queue-place-order', base);
  }
  if (command === 'position.openPending') {
    return ipcRenderer.invoke('queue-place-pending', base);
  }
  if (command === 'position.close') {
    return closeRegularPosition(position, base);
  }
  return { status: 'unsupported', reason: `Unsupported position action ${command || id}` };
}

function firstPositionTicket(position = {}) {
  const data = position.card?.data || {};
  if (position.primaryTicket) return String(position.primaryTicket);
  if (Array.isArray(position.tickets) && position.tickets[0]) return String(position.tickets[0]);
  if (data.primaryTicket) return String(data.primaryTicket);
  if (Array.isArray(data.tickets) && data.tickets[0]) return String(data.tickets[0]);
  if (data.ticket || data.providerOrderId) return String(data.ticket || data.providerOrderId);
  return '';
}

function closePayloadForPosition(position = {}, base = {}) {
  const data = position.card?.data || {};
  const ticket = firstPositionTicket(position);
  const provider = base.provider || data.provider || position.provider;
  const symbol = base.symbol || base.ticker || data.symbol || data.ticker || position.symbol || position.ticker;
  return {
    ...base,
    provider,
    ticket,
    symbol,
    side: position.side || data.side || base.side,
    snapshot: position
  };
}

async function closeRegularPosition(position = {}, base = {}) {
  const payload = closePayloadForPosition(position, base);
  if (!payload.provider || !payload.ticket || !payload.symbol) {
    return { status: 'unsupported', reason: 'provider, ticket and symbol required to close position' };
  }
  const hasOpenedAt = !!(position.timestamps?.openedAt || position.openedAt || position.card?.data?.timestamps?.openedAt);
  const rawState = String(position.state || position.card?.data?.state || '').toLowerCase();
  const state = hasOpenedAt && rawState === 'placed' ? 'active' : rawState;
  if (state === 'placed') {
    return ipcRenderer.invoke('execution:cancel-order', payload);
  }
  if (state === 'active') {
    return ipcRenderer.invoke('execution:close-position', payload);
  }
  return { status: 'unsupported', reason: `Unsupported close state ${state || 'unknown'}` };
}

function createPositionActions(position = {}) {
  const actions = Array.isArray(position.card?.actions) ? position.card.actions : [];
  const btns = el('div', 'btns position-card__actions');
  const cols = Math.max(1, actions.length);
  btns.style.gridTemplateColumns = `repeat(${cols},1fr)`;
  for (const action of actions) {
    const label = action.label || action.id;
    const kind = action.id || label;
    const b = btn(label, (action.style || kind || 'action').toLowerCase(), async () => {
      const res = await dispatchPositionAction(position, action).catch(err => ({ status: 'error', reason: err?.message || String(err) }));
      if (!res || res.status === 'error' || res.status === 'rejected' || res.status === 'unsupported') {
        toast(`x ${positionCardTitle(position)}: ${res?.reason || 'Action failed'}`);
        shakeCard(positionKey(position));
        return;
      }
      toast(`... ${positionCardTitle(position)}: ${label}`);
    });
    b.dataset.kind = kind;
    btns.appendChild(b);
  }
  return btns;
}

function createPositionSnapshotCard(position = {}) {
  const key = positionKey(position);
  const title = positionCardTitle(position);
  const runtimeCard = cardRuntime.createPositionCard(position, {
    key,
    title,
    el,
    btn,
    createPositionDataGrid,
    createActionButton: ({ label, kind, className, onClick }) => {
      const button = btn(label, className, onClick);
      button.dataset.kind = kind;
      return button;
    },
    dispatchPositionAction,
    requestRemove: requestRemovePosition,
    requestRemovePosition,
    rendererDependencies: {
      el,
      btn,
      createPositionDataGrid,
      positionKey,
      positionCardTitle
    }
  });
  return runtimeCard || positionsRenderer.createPositionSnapshotCard(position);
}

function removePositionSnapshotsForRow(row = {}) {
  const matches = Array.from(positionsById.values())
    .filter(position => shouldRemovePositionSnapshotForLegacyRowRemoval(row, position));
  for (const position of matches) {
    const key = positionKey(position);
    cardStateApi.clearCardState(key);
    cardStateApi.clearPendingExecLabel(key);
    removePositionSnapshot(position.id);
    notifyPositionRemoved(position);
    ipcRenderer.invoke('positions:remove', {
      positionId: position.id,
      reason: 'renderer.remove-extension-row'
    }).catch(() => {});
  }
  return matches.length > 0;
}

function removeLegacyRowsForPosition(position = {}) {
  return notifyPositionRemoved(position);
}

// ======= IPC wiring =======
debugPositionEvents('renderer.boot:before-positions-mount');
positionsRenderer.mount();
debugPositionEvents('renderer.boot:after-positions-mount');

// ======= UI events =======
$filter.addEventListener('input', () => {
  cardStateApi.setFilter($filter.value || '');
  render();
});
settingsRenderer.mount();
$wrap.addEventListener('wheel', () => {
  state.autoscroll = false;
});

// initial render
render();
debugPositionEvents('renderer.boot:ready');

// expose internals for tests
if (typeof module !== 'undefined') {
  module.exports.__testing = {
    ...testingExtensions,
    setCardState,
    rowKey,
    findKeyByTicker,
    cardByKey,
    state,
    cardRuntime,
    cardStateApi,
    pendingRequestLabels: testingExtensions.pendingRequestLabels || rendererOrderStateFacades.pendingRequestLabels,
    placedOrderLookup: testingExtensions.placedOrderLookup || rendererOrderStateFacades.placedOrderLookup,
    cardVisualState: testingExtensions.cardVisualState || rendererOrderStateFacades.cardVisualState,
    ticketBinding: testingExtensions.ticketBinding || rendererOrderStateFacades.ticketBinding,
    positionsById,
    positionCardRenderers,
    setPositionSnapshot,
    createPositionSnapshotCard,
    dispatchPositionAction,
    instrumentInfo,
    settingsForms,
    registerRendererExtension,
    registerInstrumentDisplayPolicy,
    registerCardStateHook,
    registerCardType: (...args) => cardRuntime.registerCardType(...args),
    resolveCardType: (...args) => cardRuntime.resolveCardType(...args),
    registerCardView: (...args) => cardRuntime.registerCardView(...args),
    getCardView: (...args) => cardRuntime.getCardView(...args),
    registerCardControl: (...args) => cardRuntime.registerCardControl(...args),
    getCardControl: (...args) => cardRuntime.getCardControl(...args),
    registerCardShape: (...args) => cardRuntime.registerCardShape(...args),
    getCardShape: (...args) => cardRuntime.getCardShape(...args),
    getInstrumentRefreshMs,
    shouldShowBidAsk,
    shouldShowSpread,
    migrateKey: (...args) => cardStateApi.migrateKey?.(...args),
    render
  };
}
