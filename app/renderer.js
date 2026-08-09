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
let orderCardsCfg = loadConfig('../services/orderCards/config/order-cards.json');

let SHOW_BID_ASK = !!(orderCardsCfg && orderCardsCfg.showBidAsk);
let SHOW_SPREAD = !!(orderCardsCfg && orderCardsCfg.showSpread);


const envInstrRefresh = Number(process.env.INSTRUMENT_REFRESH_MS);
let INSTRUMENT_REFRESH_MS = Number.isFinite(envInstrRefresh)
  ? envInstrRefresh
  : Number(orderCardsCfg?.instrumentRefreshMs) || 1000;

let BUTTON_ROWS = Number(orderCardsCfg?.buttonRows) || 1;

const DEFAULT_CARD_BUTTONS = [
  {label: 'BL', action: 'BL', style: 'bl'},
  {label: 'BC', action: 'BC', style: 'bc'},
  {label: 'BFB', action: 'BFB', style: 'bc'},
  {label: 'SL', action: 'SL', style: 'sl'},
  {label: 'SC', action: 'SC', style: 'sc'},
  {label: 'SFB', action: 'SFB', style: 'sc'}
];
let CARD_BUTTONS = Array.isArray(orderCardsCfg?.buttons) && orderCardsCfg.buttons.length
  ? orderCardsCfg.buttons.map((b) => Array.isArray(b) ? {label: b[0], action: b[1], style: b[2]} : b)
    .filter((b) => b && b.label && b.action)
  : DEFAULT_CARD_BUTTONS;

let legacyOrderListRuntime;
let state;
let appState;
let uiState;
let cardStates;
let pendingExecLabels;
let pendingByReqId;
let pendingIdByReqId;
let ticketToKey;
let placedOrderByKey;
let retryCounts;
let orderCardsApi;
let createLegacyOrderCard;

// Order for sorting cards by execution state
const cardStateOrder = {pending: 1, 'pending-exec': 2, placed: 3, executing: 4, closed: 5, profit: 6, loss: 7};
const terminalCardStates = new Set(['closed', 'profit', 'loss']);

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

state = { rows: [], filter: '', autoscroll: true };
appState = state;
uiState = new Map();
cardStates = new Map();
pendingExecLabels = new Map();
pendingByReqId = new Map();
pendingIdByReqId = new Map();
ticketToKey = new Map();
placedOrderByKey = new Map();
retryCounts = new Map();

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

loadRendererHooks();

function applyOrderCardsConfig(config = {}) {
  orderCardsCfg = config;
  SHOW_BID_ASK = !!config.showBidAsk;
  SHOW_SPREAD = !!config.showSpread;
  INSTRUMENT_REFRESH_MS = Number.isFinite(envInstrRefresh) ? envInstrRefresh : Number(config.instrumentRefreshMs) || 1000;
  legacyOrderListRuntime?.setClosedCardEventStrategy(config.closedCardEventStrategy || 'ignore');
  BUTTON_ROWS = Number(config.buttonRows) || 1;
  CARD_BUTTONS = Array.isArray(config.buttons) && config.buttons.length
    ? config.buttons.map(b => Array.isArray(b) ? { label: b[0], action: b[1], style: b[2] } : b)
      .filter(b => b && b.label && b.action)
    : DEFAULT_CARD_BUTTONS;
  render();
}

settingsRuntime.onApply('ui', ({ config }) => {
  if (typeof config.autoscroll === 'boolean') state.autoscroll = config.autoscroll;
});
settingsRuntime.onApply('order-cards', ({ config }) => applyOrderCardsConfig(config));
settingsRuntime.onApply('order-calculator', () => render());

function loadRendererServiceManifests() {
  if (rendererServiceManifests) return rendererServiceManifests;
  let dirs = [];
  try {
    dirs = loadConfig('../services/settings/config/services.json');
  } catch {
    dirs = [];
  }
  rendererServiceManifests = [];
  if (!Array.isArray(dirs)) return rendererServiceManifests;
  for (const dir of dirs) {
    try {
      const manifest = require(path.join(__dirname, dir, 'manifest.js'));
      rendererServiceManifests.push({ dir, manifest });
    } catch (err) {
      console.error('[rendererServiceLoader] Failed to load', dir, err.message);
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
    try {
      const handlers = []
        .concat(Array.isArray(manifest?.rendererHandlers) ? manifest.rendererHandlers : [])
        .concat(Array.isArray(manifest?.rendererPositionHandlers) ? manifest.rendererPositionHandlers : []);
      for (const handler of handlers) {
        if (typeof handler?.register === 'function') handler.register(context);
      }
    } catch (err) {
      console.error('[rendererServiceLoader] Failed to load renderer handlers', dir, err.message);
    }
  }
}

// ======= Utils =======
function findKeyByTicker(ticker) {
  const idx = state.rows.findIndex(r => r.ticker === ticker);
  return idx >= 0 ? rowKey(state.rows[idx]) : null;
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

function matchingRegularPositionSnapshot(row = {}) {
  if (!regularCardType(row.cardType || row.type || 'regular')) return null;
  return Array.from(positionsById.values()).find(position => (
    isRegularPositionSnapshot(position) && positionMatchesLegacyRow(position, row)
  )) || null;
}

function isPositionRenderedByLegacyRow(position = {}) {
  return state.rows.some(row => positionMatchesLegacyRow(position, row));
}

function positionKey(position = {}) {
  return `position|${position.id}`;
}

function isTerminalCardState(stateName) {
  return terminalCardStates.has(stateName);
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

// ======= Command line handling =======
function runCommand(str) {
  return ipcRenderer.invoke('cmdline:run', str);
}

function registerOrderCardInstrumentHandler(instrumentType, handler) {
  return orderCardsApi?.registerInstrumentHandler?.(instrumentType, handler) || false;
}

function registerOrderCardTypeHandler(cardType, handler) {
  return orderCardsApi?.registerCardTypeHandler?.(cardType, handler) || false;
}

function orderCardHandlerForRow(row = {}, instrumentType) {
  return orderCardsApi?.handlerFor?.(row, instrumentType) || null;
}

function orderCardHandlerForCard(card, key) {
  const row = state.rows.find(r => rowKey(r) === key) || {};
  return orderCardsApi?.handlerFor?.(row, card?.dataset?.instrumentType) || null;
}

function setCardState(key, state) {
  if (state) {
    cardStates.set(key, state);
  } else {
    cardStates.delete(key);
  }

  const card = cardByKey(key);
  if (!card) return;
  const cardHandler = orderCardHandlerForCard(card, key);
  const status = card.querySelector('.card__status');
  const close = card.querySelector('.card__close');
  const retryBtn = card.querySelector('.retry-btn');
  const spreadEl = card.querySelector('.card__spread');
  const btnsWrap = card.querySelector('.btns');
  if (!status) return;

  const inputs = card.querySelectorAll('input');
  const buttons = card.querySelectorAll('button.btn');

  if (state) {
    status.style.display = 'inline-block';
    status.className = `card__status card__status--${state}`;
    if (state === 'pending-exec') {
      const lbl = pendingExecLabels.get(key);
      status.textContent = lbl ? `pe (${lbl})` : 'pe';
    } else {
      pendingExecLabels.delete(key);
      status.textContent = '';
    }
    card.classList.toggle('card--pending', state === 'pending' || state === 'pending-exec');
    if (close) close.style.display = 'none';
    if (spreadEl) spreadEl.style.display = 'none';
    inputs.forEach(inp => {
      inp.disabled = true;
    });
    buttons.forEach(btn => {
      btn.disabled = true;
    });
    if (btnsWrap) btnsWrap.style.display = state === 'pending-exec' ? 'none' : '';

    const closePlacedOrder = async () => {
      const orderInfo = placedOrderByKey.get(key);
      const currentRow = (appState.rows || []).find(r => rowKey(r) === key);
      if (typeof cardHandler?.closePlacedOrder === 'function') {
        const handled = await cardHandler.closePlacedOrder({
          key,
          row: currentRow,
          orderInfo,
          placedOrderByKey,
          ticketToKey,
          setCardState,
          render,
          ipcRenderer,
          toast,
          shakeCard
        });
        if (handled) return;
      }
      let result = null;
      if (orderInfo && orderInfo.ticket && orderInfo.provider) {
        try {
          result = await ipcRenderer.invoke('execution:cancel-order', {
            provider: orderInfo.provider,
            ticket: orderInfo.ticket,
            symbol: orderInfo.symbol,
            name: orderInfo.name || currentRow?.name
          });
        } catch (err) {
          result = { status: 'error', reason: err?.message || String(err) };
        }
      }

      placedOrderByKey.delete(key);
      for (const [ticket, k] of ticketToKey.entries()) {
        if (k === key) ticketToKey.delete(ticket);
      }
      setCardState(key, null);
      render();
    };

    if (state === 'placed') {
      status.style.cursor = 'pointer';
      status.title = cardHandler?.placedStatusTitle || 'Return to ready to send';
      status.onclick = closePlacedOrder;
      if (cardHandler?.placedButton && btnsWrap) {
        const closeBtn = btnsWrap.querySelector('button.btn');
        if (closeBtn) {
          const replacement = closeBtn.cloneNode(true);
          replacement.textContent = cardHandler.placedButton.label || closeBtn.textContent;
          for (const cls of cardHandler.placedButton.removeClasses || []) replacement.classList.remove(cls);
          for (const cls of cardHandler.placedButton.addClasses || []) replacement.classList.add(cls);
          replacement.disabled = false;
          replacement.title = cardHandler.placedButton.title || status.title;
          replacement.addEventListener('click', closePlacedOrder);
          closeBtn.replaceWith(replacement);
        }
      }
    } else if (state === 'pending-exec') {
      status.style.cursor = 'pointer';
      status.title = 'Отменить pe';
      status.onclick = () => {
        const reqId = card.dataset.reqId;
        const pendingId = card.dataset.pendingId || (reqId ? pendingIdByReqId.get(reqId) : null);
        if (pendingId) ipcRenderer.invoke('pending:cancel', pendingId).catch(() => {
        });
        if (reqId) {
          pendingByReqId.delete(reqId);
          pendingIdByReqId.delete(reqId);
          retryCounts.delete(reqId);
          delete card.dataset.reqId;
        }
        delete card.dataset.pendingId;
        setCardState(key, null);
        render();
      };
    } else if (state === 'executing') {
      status.style.cursor = '';
      status.title = '';
      status.onclick = null;
      card.style.cursor = '';
      card.title = '';
      card.onclick = null;
    } else {
      status.style.cursor = '';
      status.title = '';
      status.onclick = null;
      card.style.cursor = '';
      card.title = '';
      card.onclick = null;
    }

    const keepFullCard = state === 'pending'
      || state === 'pending-exec'
      || !!cardHandler?.shouldKeepFullCardOnState?.({ state, key, card });
    if (keepFullCard) {
      // restore full card for pending states
      card.classList.remove('card--mini');
      if (card._removedParts) {
        for (const {node, next} of card._removedParts) {
          if (next && next.parentNode === card) {
            card.insertBefore(node, next);
          } else {
            card.appendChild(node);
          }
        }
        card._removedParts = null;
      }
      card.querySelectorAll('input').forEach(inp => inp.disabled = true);
      card.querySelectorAll('button.btn').forEach(btn => {
        btn.disabled = !cardHandler?.shouldEnableButtonOnState?.({ state, key, card });
      });
      if (btnsWrap && cardHandler?.shouldHideButtonsOnState?.({ state, key, card })) btnsWrap.style.display = 'none';
      if (retryBtn) {
        if (state === 'pending') {
          retryBtn.style.display = 'inline-block';
          const rid = card.dataset.reqId;
          if (rid && retryCounts.has(rid)) retryBtn.textContent = String(retryCounts.get(rid));
        } else {
          retryBtn.style.display = 'none';
        }
      }
    } else {
      // shrink card to ticker + status
      card.classList.add('card--mini');
      if (!card._removedParts) {
        card._removedParts = [];
        ['.meta', '.quad-line', '.extraRow', '.btns', '.card__note'].forEach(sel => {
          const n = card.querySelector(sel);
          if (n) {
            card._removedParts.push({node: n, next: n.nextSibling});
            n.remove();
          }
        });
      }
      if (retryBtn) retryBtn.style.display = 'none';
    }
  } else {
    card.classList.remove('card--mini');
    status.style.display = 'none';
    status.textContent = '';
    pendingExecLabels.delete(key);
    status.style.cursor = '';
    status.title = '';
    status.onclick = null;
    card.style.cursor = '';
    card.title = '';
    card.onclick = null;
    card.classList.remove('card--pending');
    if (spreadEl) {
      spreadEl.style.display = '';
      if (SHOW_SPREAD) updateSpreadForTicker(card.dataset.ticker);
    }
    if (close) close.style.display = '';
    inputs.forEach(inp => {
      inp.disabled = false;
    });
    buttons.forEach(btn => {
      btn.disabled = false;
    });
    if (btnsWrap) btnsWrap.style.display = '';
    if (cardHandler?.resetButtons && btnsWrap) {
      const openBtn = btnsWrap.querySelector('button.btn');
      if (openBtn) cardHandler.resetButtons(openBtn);
    }

    if (retryBtn) retryBtn.style.display = 'none';

    // restore removed sections
    if (card._removedParts) {
      for (const {node, next} of card._removedParts) {
        if (next && next.parentNode === card) {
          card.insertBefore(node, next);
        } else {
          card.appendChild(node);
        }
      }
      card._removedParts = null;
      // re-enable fields after restoration
      card.querySelectorAll('input').forEach(inp => inp.disabled = false);
      card.querySelectorAll('button.btn').forEach(btn => btn.disabled = false);
    }
    placedOrderByKey.delete(key);
  }
}

// --- touched helpers ---
function markTouched(ticker) {
  legacyOrderListRuntime.markTouched(ticker);
}

function isTouched(ticker) {
  return legacyOrderListRuntime.isTouched(ticker);
}

// ======= Rendering =======
function render() {
  $grid.innerHTML = '';
  legacyOrderListRuntime.renderLegacyCards((row, i) => {
    const card = createLegacyOrderCard(row, i);
    $grid.appendChild(card);
    return card;
  }, cardStateOrder);
  const positions = Array.from(positionsById.values());
  positions.sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0));
  for (const position of positions) {
    if (shouldHidePositionSnapshot(position)) continue;
    if (!shouldUseSnapshotInsteadOfLegacyRows(position) && isPositionRenderedByLegacyRow(position)) continue;
    const key = positionKey(position);
    const card = createPositionSnapshotCard(position);
    $grid.appendChild(card);
    for (const [rid, k] of pendingByReqId.entries()) {
      if (k === key) card.dataset.reqId = rid;
    }
    const st = cardStates.get(key);
    if (st) setCardState(key, st);
  }
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

function positionInstrumentRows() {
  return Array.from(positionsById.values()).map(position => {
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
  getInstrumentRefreshMs: () => INSTRUMENT_REFRESH_MS,
  shouldShowBidAsk: () => SHOW_BID_ASK,
  shouldShowSpread: () => SHOW_SPREAD,
  findTickSizeOverride,
  getDefaultTickSize,
  cardByKey,
  cssEsc,
  getGrid: () => $grid,
  render,
  getRows: () => state.rows.concat(positionInstrumentRows()),
  findRowByTicker: (ticker) => state.rows.find(r => r.ticker === ticker) || positionInstrumentRows().find(r => r.ticker === ticker),
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

const positionActionHandlers = {};
const positionCardRenderers = {};
const positionRemovalHandlers = {};
const rendererLegacyGuards = [];
const pendingOrdersRenderer = createPendingOrdersRenderer();

function registerLegacyOrderCardsRuntime(registration = {}, maybeCreateCard) {
  const runtime = registration.runtime || registration;
  const createCard = registration.createCard || maybeCreateCard;
  if (!runtime || typeof createCard !== 'function') return false;
  legacyOrderListRuntime = runtime;
  orderCardsApi = registration;
  createLegacyOrderCard = createCard;
  legacyOrderListRuntime.setClosedCardEventStrategy(orderCardsCfg?.closedCardEventStrategy || 'ignore');
  return () => {
    if (legacyOrderListRuntime === runtime) legacyOrderListRuntime = null;
    if (orderCardsApi === registration) orderCardsApi = null;
    if (createLegacyOrderCard === createCard) createLegacyOrderCard = null;
  };
}

const scheduleOrderCardInstantExecution = (...args) => orderCardsApi?.scheduleInstantExecution?.(...args);
const place = (...args) => orderCardsApi?.place?.(...args);

function registerRendererLegacyGuard(guard = {}) {
  if (!guard || typeof guard !== 'object') return false;
  rendererLegacyGuards.push(guard);
  return () => {
    const idx = rendererLegacyGuards.indexOf(guard);
    if (idx >= 0) rendererLegacyGuards.splice(idx, 1);
  };
}

function shouldFilterLegacyRow(row = {}) {
  return rendererLegacyGuards.some(guard => {
    if (guard.shouldFilterRow?.(row)) return true;
    const types = Array.isArray(guard.filteredRowTypes) ? guard.filteredRowTypes : [];
    return types.map(String).includes(String(row?.cardType || ''));
  });
}

function shouldIgnoreLegacyExecutionEvent(rec = {}) {
  return rendererLegacyGuards.some(guard => guard.shouldIgnoreLegacyExecutionEvent?.(rec, legacyGuardContext()));
}

function shouldIgnoreLegacyPositionEvent(rec = {}) {
  return rendererLegacyGuards.some(guard => guard.shouldIgnoreLegacyPositionEvent?.(rec, legacyGuardContext()));
}

function shouldHidePositionSnapshot(position = {}) {
  return rendererLegacyGuards.some(guard => guard.shouldHidePositionSnapshot?.(position, legacyGuardContext()));
}

function shouldRemoveLegacyRowForPosition(position = {}, row = {}) {
  return rendererLegacyGuards.some(guard => guard.shouldRemoveLegacyRowForPosition?.(position, row, legacyGuardContext()));
}

function shouldResetLegacyRowForPosition(position = {}, row = {}) {
  return rendererLegacyGuards.some(guard => guard.shouldResetLegacyRowForPosition?.(position, row, legacyGuardContext()));
}

function shouldIgnoreLegacyRowForExistingPosition(row = {}) {
  if (matchingRegularPositionSnapshot(row)) return true;
  const context = legacyGuardContext();
  return rendererLegacyGuards.some(guard => guard.shouldIgnoreLegacyRowForExistingPosition?.(row, context));
}

function shouldRemovePositionSnapshotForLegacyRowRemoval(row = {}, position = {}) {
  const context = legacyGuardContext();
  return rendererLegacyGuards.some(guard => guard.shouldRemovePositionSnapshotForLegacyRowRemoval?.(row, position, context));
}

function legacyGuardContext() {
  return {
    positions: Array.from(positionsById.values()),
    rows: state.rows
  };
}

function shouldUseSnapshotInsteadOfLegacyRows(position = {}) {
  if (isRegularPositionSnapshot(position)) return true;
  if (shouldFilterLegacyRow({ cardType: position.card?.type || position.source?.cardType })) return true;
  return state.rows.some(row => shouldRemoveLegacyRowForPosition(position, row));
}

loadRendererHandlers({
  loadConfig,
  settingsRuntime,
  el,
  state,
  rowKey,
  inputNumber,
  normNum: _normNum,
  instrumentInfoFor,
  tickSize,
  isPos,
  isSL,
  markTouched,
  uiState,
  orderCalc,
  detectInstrumentType,
  createPositionDataGrid,
  ipcRenderer,
  trackInstrument: row => instrumentInfoRenderer.trackInstrument(row),
  untrackInstrument: row => instrumentInfoRenderer.untrackInstrument(row),
  placedOrderByKey,
  cardStates,
  pendingByReqId,
  pendingIdByReqId,
  retryCounts,
  setCardState,
  ticketToKey,
  positionKey,
  positionCardTitle,
  pendingExecLabels,
  cardByKey,
  toast,
  shakeCard,
  render,
  btn,
  orderCardsDeps: {
    el,
    inputNumber,
    uiState,
    orderCalc,
    priceToPoints,
    normNum: _normNum,
    isPos,
    isSL,
    tickSize,
    ensureInstrument,
    instrumentInfoFor,
    tradeRules,
    markTouched,
    detectInstrumentType,
    rowKey,
    ipcRenderer,
    pendingByReqId,
    pendingIdByReqId,
    retryCounts,
    pendingExecLabels,
    cardByKey,
    setCardState,
    pendingActionInfo: (kind) => pendingOrdersRenderer.actionInfo(kind),
    toast,
    shakeCard,
    render,
    btn,
    removeRow,
    formatBidAskText,
    formatSpreadTriple,
    updateSpreadForTicker,
    shouldShowBidAsk: () => SHOW_BID_ASK,
    shouldShowSpread: () => SHOW_SPREAD,
    getCardButtons: () => CARD_BUTTONS,
    getButtonRows: () => BUTTON_ROWS,
    getRows: () => state.rows
  },
  legacyOrderListDeps: {
    ipcRenderer,
    state,
    legacyState: {
      uiState,
      cardStates,
      pendingExecLabels,
      pendingByReqId,
      pendingIdByReqId,
      ticketToKey,
      placedOrderByKey,
      retryCounts
    },
    rowKey,
    findKeyByTicker,
    isTerminalCardState,
    cardByKey,
    setCardState,
    removePositionSnapshotsForLegacyRow,
    positionRemovalHandlerFor: cardType => positionRemovalHandlers[cardType],
    positionMatchesLegacyRow,
    isRegularPositionSnapshot,
    shouldFilterLegacyRow,
    shouldIgnoreLegacyRowForExistingPosition,
    shouldIgnoreLegacyExecutionEvent,
    shouldIgnoreLegacyPositionEvent,
    shouldRemoveLegacyRowForPosition,
    shouldResetLegacyRowForPosition,
    forgetInstrument: (...args) => forgetInstrument(...args),
    toast,
    shakeCard,
    render
  },
  dispatchPositionAction,
  requestRemovePosition,
  registerLegacyOrderCardsRuntime,
  registerOrderCardInstrumentHandler,
  registerOrderCardTypeHandler,
  registerPositionCardRenderer(cardType, renderer) {
    if (cardType && typeof renderer === 'function') positionCardRenderers[cardType] = renderer;
  },
  registerPositionActionHandler(cardType, handler) {
    if (cardType && typeof handler === 'function') positionActionHandlers[cardType] = handler;
  },
  registerPositionRemovalHandler(cardType, handler) {
    if (cardType && typeof handler === 'function') positionRemovalHandlers[cardType] = handler;
  },
  registerRendererLegacyGuard
});

if (!legacyOrderListRuntime || !createLegacyOrderCard) {
  throw new Error('orderCards renderer runtime was not registered');
}

for (const { dir, manifest } of loadRendererServiceManifests()) {
  try {
    const guards = Array.isArray(manifest?.rendererLegacyGuards) ? manifest.rendererLegacyGuards : [];
    for (const guard of guards) registerRendererLegacyGuard(guard);
  } catch (err) {
    console.error('[rendererServiceLoader] Failed to load legacy guards', dir, err.message);
  }
}

const positionsRenderer = createPositionsRenderer({
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
    resetLegacyRowsForPosition(position);
    removeLegacyRowsForPosition(position);
    if (!shouldUseSnapshotInsteadOfLegacyRows(position)) return;
    const key = positionKey(position);
    cardStates.delete(key);
    pendingExecLabels.delete(key);
  }
});
const positionsById = positionsRenderer.positionsById;
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
  return positionsRenderer.createPositionSnapshotCard(position);
}

function removeRow(row) {
  return legacyOrderListRuntime.removeRow(row);
}

function removePositionSnapshotsForLegacyRow(row = {}) {
  const matches = Array.from(positionsById.values())
    .filter(position => shouldRemovePositionSnapshotForLegacyRowRemoval(row, position));
  for (const position of matches) {
    const key = positionKey(position);
    cardStates.delete(key);
    pendingExecLabels.delete(key);
    removePositionSnapshot(position.id);
    ipcRenderer.invoke('positions:remove', {
      positionId: position.id,
      reason: 'renderer.remove-legacy-row'
    }).catch(() => {});
  }
  return matches.length > 0;
}

function removeLegacyRowsForPosition(position = {}) {
  return legacyOrderListRuntime.removeLegacyRowsForPosition(position);
}

function resetLegacyRowsForPosition(position = {}) {
  return legacyOrderListRuntime.resetLegacyRowsForPosition(position);
}

function removeRowByKey(key) {
  return legacyOrderListRuntime.removeRowByKey(key);
}

function scheduleInstantExecution(row) {
  return legacyOrderListRuntime.scheduleInstantExecution(row, place);
}

// ======= IPC wiring =======
positionsRenderer.mount();
legacyOrderListRuntime.mount({ place });

// ======= UI events =======
$filter.addEventListener('input', () => {
  legacyOrderListRuntime.setFilter($filter.value || '');
  render();
});
settingsRenderer.mount();
$wrap.addEventListener('wheel', () => {
  state.autoscroll = false;
});
$cmdline.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const cmd = $cmdline.value.trim();
    if (cmd) {
      runCommand(cmd)
        .then((res) => {
          if (!res?.ok && res?.error) {
            toast(res.error);
          } else {
            $cmdline.value = '';
          }
        })
        .catch((err) => {
          toast(err.message || String(err));
        });
    }
  }
});

// initial render
render();

// expose internals for tests
if (typeof module !== 'undefined') {
  module.exports.__testing = {
    setCardState,
    rowKey,
    findKeyByTicker,
    cardByKey,
    state,
    pendingByReqId,
    pendingIdByReqId,
    ticketToKey,
    retryCounts,
    cardStates,
    pendingExecLabels,
    placedOrderByKey,
    positionsById,
    positionCardRenderers,
    setPositionSnapshot,
    createPositionSnapshotCard,
    dispatchPositionAction,
    instrumentInfo,
    settingsForms,
    migrateKey: legacyOrderListRuntime.migrateKey,
    orderCardInstrumentHandlers: orderCardsApi.instrumentTypeHandlers,
    orderCardTypeHandlers: orderCardsApi.cardTypeHandlers,
    render
  };
}
