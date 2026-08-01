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
const { createLevelOrderRenderer } = require('./services/levelOrder/infrastructure/renderer/renderer');
const { createInstrumentInfoRenderer } = require('./services/instrumentInfo/renderer');
const { createPositionsRenderer } = require('./services/positions/renderer');
const { createOptionStratRenderer } = require('./services/optionstrat/renderer');
const { createSettingsRenderer } = require('./services/settings/renderer');
const { createOrderCardsRenderer } = require('./services/orderCards/renderer');
const { createPendingOrdersRenderer } = require('./services/pendingOrders/renderer');
let orderCardsCfg = loadConfig('../services/orderCards/config/order-cards.json');
let levelOrderCfg = loadConfig('../services/levelOrder/config/level-order.json');

let SHOW_BID_ASK = !!(orderCardsCfg && orderCardsCfg.showBidAsk);
let SHOW_SPREAD = !!(orderCardsCfg && orderCardsCfg.showSpread);


const envInstrRefresh = Number(process.env.INSTRUMENT_REFRESH_MS);
let INSTRUMENT_REFRESH_MS = Number.isFinite(envInstrRefresh)
  ? envInstrRefresh
  : Number(orderCardsCfg?.instrumentRefreshMs) || 1000;
let optionStratValuationRefreshMs = 5000;

let CLOSED_CARD_EVENT_STRATEGY = orderCardsCfg?.closedCardEventStrategy || 'ignore';
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

const closedCardStrategies = {
  ignore: () => {
  },
  revive: ({row, idx, oldRow, oldKey}) => {
    userTouchedByTicker.delete(row.ticker);
    setCardState(oldKey, null);
    const newRow = {...oldRow, ...row};
    const newKey = rowKey(newRow);
    state.rows[idx] = newRow;
    migrateKey(oldKey, newKey, {
      preserveUi: false,
      nextUiPatch: (prevUi) => {
        const patch = {};
        if (row.qty != null) patch.qty = String(row.qty);
        if (row.price != null) patch.price = String(row.price);
        if (row.sl != null) patch.sl = String(row.sl);
        if (row.tp != null) patch.tp = String(row.tp);
        return patch;
      }
    });
    const updated = state.rows.splice(idx, 1)[0];
    state.rows.unshift(updated);
    if (state.rows.length > 500) state.rows.length = 500;
    render();
  }
};

let handleClosedCard = closedCardStrategies[CLOSED_CARD_EVENT_STRATEGY] || closedCardStrategies.ignore;

// ======= App state =======
const state = {rows: [], filter: '', autoscroll: true};
const appState = state;
// load UI settings
ipcRenderer.invoke('settings:get', 'ui').then((res) => {
  if (res && typeof res.autoscroll === 'boolean') {
    state.autoscroll = res.autoscroll;
  } else if (res?.config && typeof res.config.autoscroll === 'boolean') {
    state.autoscroll = res.config.autoscroll;
  }
}).catch(() => {
});

ipcRenderer.invoke('settings:get', 'optionstrat').then((res) => {
  const cfg = res?.config || res || {};
  const ms = Number(cfg.valuationRefreshMs);
  if (Number.isFinite(ms) && ms > 0) optionStratValuationRefreshMs = optionStratRenderer.setValuationRefreshMs(ms);
  optionStratRenderer.setDisplayFields(cfg.displayFields);
}).catch(() => {
});

// Per-card UI state (persist across renders)
// Crypto:    { qty, price, sl, tp, tpTouched }
// Equities:  { qty, price, sl, tp, risk, tpTouched }
const uiState = new Map();

// Per-card execution state (pending/placed/executing/closed/profit/loss)
const cardStates = new Map();
// Order for sorting cards by execution state
const cardStateOrder = {pending: 1, 'pending-exec': 2, placed: 3, executing: 4, closed: 5, profit: 6, loss: 7};
const terminalCardStates = new Set(['closed', 'profit', 'loss']);

// Short labels for pending execution orders
const pendingExecLabels = new Map(); // key -> label

// --- pending заявки по requestId ---
const pendingByReqId = new Map();
const pendingIdByReqId = new Map();
const ticketToKey = new Map(); // ticket -> rowKey
const placedOrderByKey = new Map(); // rowKey -> { provider, ticket, symbol }
const retryCounts = new Map(); // reqId -> retry count
const instantExecutedKeys = new Set();

// --- пользователь вручную менял поля карточки для этого тикера?
const userTouchedByTicker = new Map(); // ticker -> boolean

// котировки по тикерам
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
  CLOSED_CARD_EVENT_STRATEGY = config.closedCardEventStrategy || 'ignore';
  BUTTON_ROWS = Number(config.buttonRows) || 1;
  CARD_BUTTONS = Array.isArray(config.buttons) && config.buttons.length
    ? config.buttons.map(b => Array.isArray(b) ? { label: b[0], action: b[1], style: b[2] } : b)
      .filter(b => b && b.label && b.action)
    : DEFAULT_CARD_BUTTONS;
  handleClosedCard = closedCardStrategies[CLOSED_CARD_EVENT_STRATEGY] || closedCardStrategies.ignore;
  render();
}

settingsRuntime.onApply('ui', ({ config }) => {
  if (typeof config.autoscroll === 'boolean') state.autoscroll = config.autoscroll;
});
settingsRuntime.onApply('order-cards', ({ config }) => applyOrderCardsConfig(config));
settingsRuntime.onApply('order-calculator', () => render());
settingsRuntime.onApply('level-order', ({ config }) => {
  levelOrderCfg = config || {};
  render();
});
settingsRuntime.onApply('optionstrat', ({ config }) => {
  const ms = Number(config?.valuationRefreshMs);
  if (Number.isFinite(ms) && ms > 0) optionStratValuationRefreshMs = optionStratRenderer.setValuationRefreshMs(ms);
  optionStratRenderer.setDisplayFields(config?.displayFields);
  render();
});

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

function loadRendererPositionHandlers(context = {}) {
  for (const { dir, manifest } of loadRendererServiceManifests()) {
    try {
      const handlers = Array.isArray(manifest?.rendererPositionHandlers)
        ? manifest.rendererPositionHandlers
        : [];
      for (const handler of handlers) {
        if (typeof handler?.register === 'function') handler.register(context);
      }
    } catch (err) {
      console.error('[rendererServiceLoader] Failed to load position handlers', dir, err.message);
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

function isUpEvent(ev) {
  return /(up|long)/i.test(String(ev));
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

function setCardState(key, state) {
  if (state) {
    cardStates.set(key, state);
  } else {
    cardStates.delete(key);
  }

  const card = cardByKey(key);
  if (!card) return;
  const isOptionCard = card.dataset.instrumentType === 'OPT';
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
      const hedgeRow = currentRow || (isOptionCard && orderInfo ? {
        ...orderInfo,
        ticker: orderInfo.symbol,
        instrumentType: 'OPT'
      } : null);
      if (isOptionCard && hedgeRow) {
        emitOptionStratButtonEvent('close', hedgeRow);
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

      if (isOptionCard) {
        if (result && result.status !== 'ok') {
          toast(`âœ– ${orderInfo?.symbol || ''}: ${result.reason || 'Close failed'}`);
          shakeCard(key);
          return;
        }
        const finalValuation = result?.valuation || result?.raw?.valuation;
        if (finalValuation) {
          const current = currentRow;
          if (current) current.valuation = finalValuation;
          if (orderInfo) orderInfo.valuation = finalValuation;
        }
        markRowClosed(key);
        placedOrderByKey.delete(key);
        pendingOptionValuations.delete(key);
        for (const [ticket, k] of ticketToKey.entries()) {
          if (k === key) ticketToKey.delete(ticket);
        }
        setCardState(key, 'profit');
        render();
        return;
      }

      placedOrderByKey.delete(key);
      pendingOptionValuations.delete(key);
      for (const [ticket, k] of ticketToKey.entries()) {
        if (k === key) ticketToKey.delete(ticket);
      }
      setCardState(key, null);
      render();
    };

    if (state === 'placed') {
      status.style.cursor = 'pointer';
      status.title = isOptionCard ? 'Close OptionStrat position' : 'Return to ready to send';
      status.onclick = closePlacedOrder;
      if (isOptionCard && btnsWrap) {
        const closeBtn = btnsWrap.querySelector('button.btn');
        if (closeBtn) {
          const replacement = closeBtn.cloneNode(true);
          replacement.textContent = 'CLOSE';
          replacement.classList.remove('bl');
          replacement.classList.add('sl');
          replacement.disabled = false;
          replacement.title = 'Close OptionStrat position';
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

    if (state === 'pending' || state === 'pending-exec' || ((state === 'placed' || state === 'profit') && isOptionCard)) {
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
        btn.disabled = !(state === 'placed' && isOptionCard);
      });
      if (btnsWrap) btnsWrap.style.display = state === 'profit' && isOptionCard ? 'none' : '';
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
    if (isOptionCard && btnsWrap) {
      const openBtn = btnsWrap.querySelector('button.btn');
      if (openBtn) {
        openBtn.textContent = 'OPEN';
        openBtn.classList.remove('sl');
        openBtn.classList.add('bl');
        openBtn.title = '';
      }
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
  if (ticker) userTouchedByTicker.set(ticker, true);
}

function isTouched(ticker) {
  return !!userTouchedByTicker.get(ticker);
}

// Миграция ключей (rowKey зависит от полей row)
function migrateKey(oldKey, newKey, {preserveUi = false, nextUiPatch = null} = {}) {
  if (oldKey === newKey) return;

  // uiState
  if (uiState.has(oldKey)) {
    const prev = uiState.get(oldKey);
    const next = preserveUi ? prev : {...(prev || {})};
    if (typeof nextUiPatch === 'function') Object.assign(next, nextUiPatch(prev));
    uiState.set(newKey, next);
    uiState.delete(oldKey);
  }

  // pendingByReqId
  for (const [rid, key] of pendingByReqId.entries()) {
    if (key === oldKey) pendingByReqId.set(rid, newKey);
  }

  // cardStates
  if (cardStates.has(oldKey)) {
    cardStates.set(newKey, cardStates.get(oldKey));
    cardStates.delete(oldKey);
  }

  // pendingExecLabels
  if (pendingExecLabels.has(oldKey)) {
    pendingExecLabels.set(newKey, pendingExecLabels.get(oldKey));
    pendingExecLabels.delete(oldKey);
  }

  if (placedOrderByKey.has(oldKey)) {
    placedOrderByKey.set(newKey, placedOrderByKey.get(oldKey));
    placedOrderByKey.delete(oldKey);
  }

  for (const [ticket, key] of ticketToKey.entries()) {
    if (key === oldKey) ticketToKey.set(ticket, newKey);
  }
}

// ======= Rendering =======
function render() {
  const f = (state.filter || '').trim().toLowerCase();
  let list = state.rows;
  if (f) {
    list = list.filter(r => (r.ticker || '').toLowerCase().startsWith(f));
  } else {
    list = list.slice();
  }

  list.sort((a, b) => {
    const stateA = cardStates.get(rowKey(a));
    const stateB = cardStates.get(rowKey(b));
    const orderA = stateA ? (cardStateOrder[stateA] ?? 6) : 0;
    const orderB = stateB ? (cardStateOrder[stateB] ?? 6) : 0;
    if (orderA !== orderB) return orderA - orderB;
    return 0; // stable sort keeps original order within groups
  });

  $grid.innerHTML = '';
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    const key = rowKey(row);
    const card = createCard(row, i);
    $grid.appendChild(card);
    // restore reqId if order is pending
    for (const [rid, k] of pendingByReqId.entries()) {
      if (k === key) card.dataset.reqId = rid;
    }
    const st = cardStates.get(key);
    if (st) setCardState(key, st);
  }
  const positions = Array.from(positionsById.values());
  positions.sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0));
  for (const position of positions) {
    if (levelOrderRenderer.isLevelOrderChildPosition(position)) continue;
    if (position.card?.type !== 'levelOrder' && isPositionRenderedByLegacyRow(position)) continue;
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

function createCard(row, index) {
  const key = rowKey(row);
  const instrumentType = row.instrumentType || detectInstrumentType(row.ticker); // fallback to EQ if not set

  // ensure we have a quote for this symbol ASAP
  ensureInstrument(row.ticker, row.provider);
  if (instrumentType === 'OPT') ensureOptionPayoff(row);

  const card = el('div', 'card');
  card.setAttribute('data-rowkey', key);
  card.setAttribute('data-ticker', row.ticker);
  card.setAttribute('data-instrument-type', instrumentType);

  // head
  const head = el('div', 'row');

  // Левая часть: тикер (+ bid/ask при наявності)
  const left = el('div', null, null, {style: 'display:flex;align-items:center;gap:6px'});
  left.appendChild(el('div', null, instrumentType === 'OPT' ? (row.name || row.ticker) : row.ticker, {style: 'font-weight:600;font-size:13px'}));
  if (SHOW_BID_ASK) {
    const $bidask = el('span', 'card__bidask');
    $bidask.title = 'Bid / Ask';
    $bidask.style.fontSize = '11px';
    $bidask.style.color = '#6b7280';
    $bidask.textContent = formatBidAskText(instrumentInfoFor(row.ticker, row), row) || '';
    left.appendChild($bidask);
  }
  head.appendChild(left);

  // Правая часть: статус + кнопка удаления
  const right = el('div', null, null, {style: 'display:flex;align-items:center;gap:6px'});
  const $status = el('span', 'card__status');
  $status.style.display = 'none';
  right.appendChild($status);

  if (SHOW_SPREAD) {
    const $spread = el('span', 'card__spread');
    $spread.title = 'Spread pts: current / avg10 / avg100';
    $spread.style.fontSize = '11px';
    $spread.style.color = '#6b7280';
    $spread.textContent = formatSpreadTriple(row.ticker, row) || '';
    right.appendChild($spread);
  }

  const $retry = document.createElement('button');
  $retry.type = 'button';
  $retry.className = 'retry-btn';
  $retry.textContent = '0';
  $retry.title = 'Stop retries';
  $retry.style.display = 'none';
  $retry.addEventListener('click', (e) => {
    e.stopPropagation();
    const cardEl = e.currentTarget.closest('.card');
    const reqId = cardEl?.dataset.reqId;
    if (reqId) ipcRenderer.invoke('execution:stop-retry', reqId);
  });
  right.appendChild($retry);

  const $close = document.createElement('button');
  $close.type = 'button';
  $close.textContent = '×';
  $close.className = 'card__close';
  Object.assign($close.style, {
    border: 'none',
    background: 'transparent',
    width: '22px',
    height: '22px',
    lineHeight: '22px',
    textAlign: 'center',
    fontSize: '16px',
    cursor: 'pointer',
    borderRadius: '4px',
    color: isUpEvent(row.event) ? '#2e7d32' : '#c62828',
    marginLeft: '8px'
  });
  $close.title = 'Удалить карточку';
  $close.addEventListener('click', (e) => {
    e.stopPropagation();
    removeRow(row);
  });
  right.appendChild($close);
  head.appendChild(right);

  // meta
  const meta = el('div', 'meta');

  // body
  let body;
  switch (instrumentType) {
    case 'EQ':
      body = createEquitiesBody(row, key);
      break;
    case 'FX':
      body = createFxBody(row, key);
      break;
    case 'CX':
      body = createCryptoBody(row, key);
      break;
    case 'OPT':
      body = createOptionBody(row, key);
      break;
    default:
      body = createEquitiesBody(row, key); // fallback
      break;
  }


  // buttons
  const btns = el('div', 'btns');
  const mk = (label, cls, kind) => {
    const b = btn(label, cls, async () => {
      const v = body.validate();
      if (!v.valid) return;
      await place(kind, row, v, instrumentType, label);
    });
    b.setAttribute('data-kind', kind);
    return b;
  };
  const cardButtons = instrumentType === 'OPT'
    ? [{ label: 'OPEN', action: 'OPEN', style: 'bl' }]
    : CARD_BUTTONS;
  const cols = Math.ceil(cardButtons.length / BUTTON_ROWS);
  btns.style.gridTemplateColumns = `repeat(${cols},1fr)`;
  for (const {label, action, style} of cardButtons) {
    btns.appendChild(mk(label, (style || action).toLowerCase(), action));
  }

  // assemble
  card.appendChild(head);
  card.appendChild(meta);
  card.appendChild(body.line);
  if (body.extraRow) card.appendChild(body.extraRow); // Risk$ line for equities
  card.appendChild(btns);
  const note = el('div', 'card__note');
  card.appendChild(note);

  // let validator manage buttons state
  body.setButtons(btns);
  if (body.setNote) body.setNote(note);
  body.validate();
  // expose validator for external revalidation on instrument updates
  card._validate = (commit = false) => body.validate(commit);

  return card;
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

const optionStratRenderer = createOptionStratRenderer({
  ipcRenderer,
  el,
  state,
  rowKey,
  render,
  toast,
  shakeCard,
  placedOrderByKey,
  cardStates,
  setCardState,
  ticketToKey,
  getValuationRefreshMs: () => optionStratValuationRefreshMs
});
const pendingOptionValuations = optionStratRenderer.pendingOptionValuations;
const pendingOptionPayoffs = optionStratRenderer.pendingOptionPayoffs;
const createOptionBody = (...args) => optionStratRenderer.createOptionBody(...args);
const ensureOptionPayoff = (...args) => optionStratRenderer.ensureOptionPayoff(...args);
const refreshOptionValuation = (...args) => optionStratRenderer.refreshOptionValuation(...args);
const markRowOpened = (...args) => optionStratRenderer.markRowOpened(...args);
const markRowClosed = (...args) => optionStratRenderer.markRowClosed(...args);
const emitOptionStratButtonEvent = (...args) => optionStratRenderer.emitButtonEvent(...args);
optionStratRenderer.startValuationRefresh();

const orderCardsRenderer = createOrderCardsRenderer({
  el,
  inputNumber,
  uiState,
  orderCalc,
  priceToPoints,
  normNum: _normNum,
  isPos,
  isSL,
  tickSize,
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
  placedOrderByKey,
  ticketToKey,
  cardStates,
  cardByKey,
  setCardState,
  pendingActionInfo: (kind) => pendingOrdersRenderer.actionInfo(kind),
  emitOptionStratButtonEvent,
  toast,
  shakeCard,
  render
});
const createCryptoBody = (...args) => orderCardsRenderer.createCryptoBody(...args);
const createFxBody = (...args) => orderCardsRenderer.createFxBody(...args);
const createEquitiesBody = (...args) => orderCardsRenderer.createEquitiesBody(...args);
const place = (...args) => orderCardsRenderer.place(...args);

const pendingOrdersRenderer = createPendingOrdersRenderer();

const levelOrderRenderer = createLevelOrderRenderer({
  getConfig: () => levelOrderCfg,
  el,
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
  untrackInstrument: row => instrumentInfoRenderer.untrackInstrument(row)
});
const placeLevelOrderPositionAction = levelOrderRenderer.createPositionActionDispatcher({
  positionKey,
  positionCardTitle,
  pendingByReqId,
  retryCounts,
  pendingExecLabels,
  cardByKey,
  setCardState,
  toast,
  shakeCard,
  render
});
const positionActionHandlers = {};
const positionCardRenderers = {};
const positionRemovalHandlers = {};

loadRendererPositionHandlers({
  levelOrderRenderer,
  placeLevelOrderPositionAction,
  positionKey,
  positionCardTitle,
  btn,
  dispatchPositionAction,
  requestRemovePosition,
  registerPositionCardRenderer(cardType, renderer) {
    if (cardType && typeof renderer === 'function') positionCardRenderers[cardType] = renderer;
  },
  registerPositionActionHandler(cardType, handler) {
    if (cardType && typeof handler === 'function') positionActionHandlers[cardType] = handler;
  },
  registerPositionRemovalHandler(cardType, handler) {
    if (cardType && typeof handler === 'function') positionRemovalHandlers[cardType] = handler;
  }
});

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
    if (position.card?.type !== 'levelOrder') return;
    const key = positionKey(position);
    cardStates.delete(key);
    pendingExecLabels.delete(key);
  }
});
positionCardRenderers.regular = (position) => positionsRenderer.renderRegularPositionCard(position);
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
  return { status: 'unsupported', reason: `Unsupported position action ${command || id}` };
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

function clearPendingByKey(key) {
  for (const [rid, pendingKey] of pendingByReqId.entries()) {
    if (pendingKey === key) {
      pendingByReqId.delete(rid);
      pendingIdByReqId.delete(rid);
    }
  }
}

function removeRow(row) {
  const key = rowKey(row);
  const before = state.rows.length;
  state.rows = state.rows.filter(r => r !== row);
  if (state.rows.length === before) {
    state.rows = state.rows.filter(r => !(r.ticker === row.ticker && r.event === row.event && r.time === row.time && r.price === row.price));
  }
  cleanupRemovedRow(row, key);
  render();
  forgetInstrument(row.ticker, row.provider);
}

function cleanupRemovedRow(row, key = rowKey(row)) {
  uiState.delete(key);
  cardStates.delete(key);
  placedOrderByKey.delete(key);
  clearPendingByKey(key);
  userTouchedByTicker.delete(row.ticker); // reset touched flag for ticker
}

function removeLegacyRowsForPosition(position = {}) {
  const removedByService = positionRemovalHandlers[position.card?.type]?.(position) === true;
  const matches = state.rows.filter(row => row.cardType === 'levelOrder' && positionMatchesLegacyRow(position, row));
  if (matches.length === 0) return removedByService;
  const keys = new Set(matches.map(row => rowKey(row)));
  state.rows = state.rows.filter(row => !keys.has(rowKey(row)));
  for (const row of matches) {
    cleanupRemovedRow(row);
    forgetInstrument(row.ticker, row.provider);
  }
  return true;
}

function removeRowByKey(key) {
  const idx = state.rows.findIndex(r => rowKey(r) === key);
  if (idx >= 0) {
    const row = state.rows[idx];
    state.rows.splice(idx, 1);
    cleanupRemovedRow(row, key);
    render();
    forgetInstrument(row.ticker, row.provider);
  }
}

function scheduleInstantExecution(row) {
  if (!row || row.instrumentType !== 'OPT' || row.instantExecution !== true) return;
  const key = rowKey(row);
  if (instantExecutedKeys.has(key)) return;
  instantExecutedKeys.add(key);
  optionStratRenderer.scheduleInstantExecution(row, place);
}

// ======= IPC wiring =======
ipcRenderer.invoke('orders:list', 100).then(rows => {
  state.rows = Array.isArray(rows) ? rows.filter(row => row?.cardType !== 'levelOrder') : [];
  render();
}).catch(() => {
});

positionsRenderer.mount();

// Заявка поставлена в очередь адаптером (ждём подтверждение из DWX)
ipcRenderer.on('execution:pending', (_evt, rec) => {
  const reqId = rec?.reqId;
  if (!reqId) return;

  let key = pendingByReqId.get(reqId);
  if (!key) key = findKeyByTicker(rec?.order?.symbol || rec?.order?.ticker);
  if (rec?.parentRequestId || rec?.order?.meta?.parentRequestId) return;
  if (!key) return;

  pendingByReqId.set(reqId, key);
  retryCounts.set(reqId, 0);
  const card = cardByKey(key);
  if (rec.pendingId) {
    pendingIdByReqId.set(reqId, rec.pendingId);
    if (card) card.dataset.pendingId = rec.pendingId;
  } else {
    pendingIdByReqId.delete(reqId);
    if (card) delete card.dataset.pendingId;
  }
  if (card) {
    card.dataset.reqId = reqId;
    const rb = card.querySelector('.retry-btn');
    if (rb) rb.textContent = '0';
  }
  if (cardStates.get(key) !== 'pending-exec' || rec?.order?.side) {
    setCardState(key, 'pending');
  }
  if (card && rec?.order) {
    const ui = uiState.get(key) || {};
    if (rec.order.qty != null) {
      ui.qty = String(rec.order.qty);
      const $q = card.querySelector('input.qty');
      if ($q) $q.value = ui.qty;
    }
    if (rec.order.price != null) {
      ui.price = String(rec.order.price);
      const $p = card.querySelector('input.pr');
      if ($p) $p.value = ui.price;
    }
    if (rec.order.sl != null) {
      ui.sl = String(rec.order.sl);
      const $s = card.querySelector('input.sl');
      if ($s) $s.value = ui.sl;
    }
    if (rec.order.tp != null) {
      ui.tp = String(rec.order.tp);
      const $t = card.querySelector('input.tp');
      if ($t) $t.value = ui.tp;
    }
    uiState.set(key, ui);
  }
  toast(`… ${rec.order.symbol}: queued`);
});

ipcRenderer.on('execution:retry', (_evt, rec) => {
  let key = pendingByReqId.get(rec.reqId);
  if (!key) return;
  retryCounts.set(rec.reqId, rec.count);
  const card = cardByKey(key);
  if (card) {
    const rb = card.querySelector('.retry-btn');
    if (rb) rb.textContent = String(rec.count);
  }
});

ipcRenderer.on('execution:retry-stopped', (_evt, rec) => {
  let key = pendingByReqId.get(rec.reqId);
  if (!key) return;
  pendingByReqId.delete(rec.reqId);
  retryCounts.delete(rec.reqId);
  const card = cardByKey(key);
  if (card) {
    delete card.dataset.reqId;
    const rb = card.querySelector('.retry-btn');
    if (rb) {
      rb.textContent = '0';
      rb.style.display = 'none';
    }
  }
  setCardState(key, null);
  render();
});

ipcRenderer.on('orders:remove', (_evt, filter) => {
  if (!filter || typeof filter !== 'object') return;
  const {producingLineId} = filter;
  if (producingLineId == null) return;
  const targetId = String(producingLineId);
  if (!targetId) return;
  const matches = state.rows.filter(row => String(row.producingLineId || '') === targetId);
  if (matches.length === 0) return;
  const keysToRemove = new Set(matches.map(row => rowKey(row)));
  const nextRows = [];
  const removed = [];
  for (const row of state.rows) {
    const key = rowKey(row);
    if (keysToRemove.has(key)) {
      removed.push({row, key});
    } else {
      nextRows.push(row);
    }
  }
  if (removed.length === 0) return;
  state.rows = nextRows;
  removed.forEach(({row, key}) => {
    uiState.delete(key);
    cardStates.delete(key);
    clearPendingByKey(key);
    userTouchedByTicker.delete(row.ticker);
    forgetInstrument(row.ticker, row.provider);
  });
  render();
});

// Обновлённая логика получения ивента
ipcRenderer.on('orders:new', (_evt, row) => {
  if (row?.cardType === 'levelOrder') return;
  // ищем существующую карточку по ТИКЕРУ
  let idx;
  if (row.instrumentType === 'OPT') {
    idx = state.rows.findIndex(r => rowKey(r) === rowKey(row));
  } else {
    idx = state.rows.findIndex(r => r.ticker === row.ticker);
  }

  if (idx === -1) {
    // карточки нет — добавляем новую
    state.rows.unshift(row);
    if (state.rows.length > 500) state.rows.length = 500;
    render();
    scheduleInstantExecution(row);
    return;
  }
  // карточка для тикера уже есть
  const oldRow = state.rows[idx];
  const oldKey = rowKey(oldRow);
  const st = cardStates.get(oldKey);
  if (isTerminalCardState(st)) {
    handleClosedCard({row, idx, oldRow, oldKey});
    return;
  }

  const touched = isTouched(row.ticker);

  if (touched) {
    // пользователь менял поля: НЕ трогаем данные, только поднимаем карточку вверх
    const existing = state.rows.splice(idx, 1)[0];
    state.rows.unshift(existing);
    render();
    return;
  }

  // пользователь не менял: обновляем данными последнего ивента + переносим наверх
  const newRow = {...oldRow, ...row};
  const newKey = rowKey(newRow);

  // подменяем строку
  state.rows[idx] = newRow;

  // мигрируем ключи в ui/pending и подтягиваем авто-поля из ивента
  migrateKey(oldKey, newKey, {
    preserveUi: false,
    nextUiPatch: (prevUi) => {
      const patch = {};
      if (row.qty != null) patch.qty = String(row.qty);
      if (row.price != null) patch.price = String(row.price);
      if (row.sl != null) patch.sl = String(row.sl);
      if (row.tp != null) patch.tp = String(row.tp);
      return patch;
    }
  });

  // перемещаем обновлённую карточку на верх
  const updated = state.rows.splice(idx, 1)[0];
  state.rows.unshift(updated);

  if (state.rows.length > 500) state.rows.length = 500;
  render();
});

// Результат исполнения: закрыть или подсветить карточку
ipcRenderer.on('execution:result', (_evt, rec) => {
  const reqId = rec?.order?.meta?.requestId || rec?.reqId;
  if (!reqId) return;
  if (rec?.parentRequestId || rec?.order?.meta?.parentRequestId) return;
  const key = pendingByReqId.get(reqId);
  if (!key) return;

  pendingByReqId.delete(reqId);
  pendingIdByReqId.delete(reqId);
  retryCounts.delete(reqId);
  const card = cardByKey(key);
  if (card) {
    delete card.dataset.reqId;
    delete card.dataset.pendingId;
    const rb = card.querySelector('.retry-btn');
    if (rb) rb.textContent = '0';
  }

  const ok = rec.status === 'ok' || rec.status === 'simulated';
  if (ok) {
    const st = cardStates.get(key);
    if (st !== 'executing' && st !== 'profit' && st !== 'loss') {
      setCardState(key, 'placed');
    }
    if (rec.providerOrderId) ticketToKey.set(String(rec.providerOrderId), key);
    const providerOrderId = String(rec.providerOrderId || '');
    if (providerOrderId) {
      const row = state.rows.find(r => rowKey(r) === key);
      const symbol = rec.order?.symbol || rec.order?.ticker || row?.ticker || row?.symbol || '';
      const openedAt = Date.now();
      placedOrderByKey.set(key, {
        provider: rec.provider || (row && row.provider) || '',
        ticket: providerOrderId,
        symbol: symbol,
        strategyCommand: row?.strategyCommand,
        name: rec.order?.name || row?.name,
        payoff: rec.payoff || rec.raw?.payoff,
        valuation: rec.valuation || rec.raw?.valuation,
        openedAt
      });
      if (row && (rec.payoff || rec.raw?.payoff)) row.payoff = rec.payoff || rec.raw.payoff;
      if (row && (rec.valuation || rec.raw?.valuation)) row.valuation = rec.valuation || rec.raw.valuation;
      if (row && row.instrumentType === 'OPT') row.openedAt = row.openedAt || openedAt;
    }
    toast(`✔ ${rec.order.symbol} ${rec.order.side} ${rec.order.qty} — placed`);
    render();
  } else if (rec.status === 'unknown' || rec.partial === true) {
    setCardState(key, 'pending');
    if (card) card.title = rec.reason || 'Execution state unknown';
    toast(`... ${rec.order?.symbol || ''}: execution state unknown`);
    render();
  } else {
    setCardState(key, null);
    render();
    shakeCard(key);
    if (card) card.title = rec.reason || 'Rejected';
    toast(`✖ ${rec.order?.symbol || ''}: ${rec.reason || 'Rejected'}`);
  }
});

ipcRenderer.on('position:opened', (_evt, rec) => {
  if (rec?.origOrder?.meta?.parentRequestId) return;
  const ticket = String(rec.ticket);
  let key = ticketToKey.get(ticket);
  if (!key) {
    const reqId = rec.origOrder?.meta?.requestId;
    if (reqId) {
      key = pendingByReqId.get(reqId);
      if (key) ticketToKey.set(ticket, key);
    }
  }
  if (!key) return;
  placedOrderByKey.delete(key);
  markRowOpened(key);
  setCardState(key, 'executing');
  render();
});

ipcRenderer.on('level-order:positions-ready', (_evt, rec = {}) => {
  void rec;
});

ipcRenderer.on('position:closed', (_evt, rec) => {
  if (rec?.origOrder?.meta?.parentRequestId) return;
  const ticket = String(rec.ticket);
  const key = ticketToKey.get(ticket);
  if (!key) return;
  markRowClosed(key);
  if (typeof rec.profit === 'number') {
    setCardState(key, rec.profit >= 0 ? 'profit' : 'loss');
  } else {
    setCardState(key, 'closed');
  }
  render();
});

ipcRenderer.on('order:cancelled', (_evt, rec) => {
  const ticket = String(rec.ticket);
  const key = ticketToKey.get(ticket);
  if (key) {
    ticketToKey.delete(ticket);
    placedOrderByKey.delete(key);
    removeRowByKey(key);
  }
});

// ======= UI events =======
$filter.addEventListener('input', () => {
  state.filter = $filter.value || '';
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
    migrateKey,
    setLevelOrderConfig(config) {
      levelOrderCfg = config || {};
    },
    setOptionStratDisplayFields(fields) {
      optionStratRenderer.setDisplayFields(fields);
    },
    render
  };
}
