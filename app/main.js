// app/main.js
// Electron main: Express(3210) + JSONL logs + IPC "queue-place-order" + execution adapters via the brokerage service

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

require('dotenv').config({ path: path.resolve(__dirname, '..','.env') });

const servicesApi = require('./services/servicesApi');
const { createOrderCardService } = require('./services/orderCards');
const { detectInstrumentType } = require('./services/instruments');
const events = require('./services/events');
const { createPendingOrderHub } = require('./services/pendingOrders');
const tradeRules = servicesApi.tradeRules || require('./services/tradeRules');
const loadConfig = require('./config/load');
const orderCalc = servicesApi.orderCalculator || require('./services/orderCalculator');
const { buildOptionStratHedgePayload } = require('./services/optionstrat/hedge');
const { GroupedOrderLifecycleRegistry } = require('./services/brokerage/comps/groupedOrderLifecycle');
const { calculateLimitBidTradePlan } = require('./services/levelOrder/strategy');
const { collectRetryStopEntries, getRetryStopParentIds } = require('./services/levelOrder/retryStop');
const { normalizeOrderQty, isValidOrderQty } = require('./services/executionQuantity');
const orderCardsCfg = loadConfig('../services/orderCards/config/order-cards.json');
let uiCfg = loadConfig('../services/ui/config/ui.json');

function loadServices(servicesApi = {}) {
  let dirs = [];
  try {
    dirs = loadConfig('../services/settings/config/services.json');
  } catch {
    dirs = [];
  }
  if (!Array.isArray(dirs)) return;
  for (const dir of dirs) {
    try {
      const manifest = require(path.join(__dirname, dir, 'manifest.js'));
      if (typeof manifest?.initService === 'function') {
        manifest.initService(servicesApi);
      }
    } catch (err) {
      console.error('[serviceLoader] Failed to load', dir, err);
    }
  }
}

loadServices(servicesApi);
const { getAdapter, resolveProvider } = servicesApi.brokerage || {};
const instrumentInfo = servicesApi.instrumentInfo;

function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off', ''].includes(s)) return false;
  return fallback; // если пришло что-то странное — вернём дефолт
}

function envInt(name, fallback = 0) {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function resolveWebhookPort(candidate, fallback) {
  const num = Number(candidate);
  if (!Number.isFinite(num)) return fallback;
  const port = Math.trunc(num);
  if (port <= 0 || port > 65535) return fallback;
  return port;
}

const CID_IN_COMMENT_RE = /cid[:=]\s*([a-z0-9]+)/i;

function normalizeCid(candidate) {
  if (candidate == null) return '';
  let str = String(candidate).trim();
  if (!str) return '';
  const cidMatch = str.match(CID_IN_COMMENT_RE);
  if (cidMatch) return cidMatch[1];
  if (str.startsWith('pending:')) return str.slice('pending:'.length);
  return str;
}

function generateCid() {
  return crypto.randomBytes(6).toString('hex');
}

function ensureCommentHasCid(comment, cid) {
  const base = comment == null ? '' : String(comment).trim();
  if (!cid) return base;
  if (base.includes(cid)) return base;
  if (CID_IN_COMMENT_RE.test(base)) {
    return base.replace(CID_IN_COMMENT_RE, `cid:${cid}`);
  }
  return base ? `${base} | cid:${cid}` : `cid:${cid}`;
}

function ensureOrderCid(order) {
  if (!order || typeof order !== 'object') return '';
  if (!order.meta) order.meta = {};
  const candidates = [order.meta.cid, order.clientOrderId, order.cid];
  let cid = '';
  for (const candidate of candidates) {
    const normalized = normalizeCid(candidate);
    if (normalized) {
      cid = normalized;
      break;
    }
  }
  if (!cid) cid = generateCid();
  order.meta.cid = cid;
  if (!normalizeCid(order.clientOrderId)) {
    order.clientOrderId = cid;
  }
  order.comment = ensureCommentHasCid(order.comment, cid);
  return cid;
}

function getTerminalPositionComment(position = {}) {
  return String(position.comment || position.comment_string || position.clientOrderId || position.id || position.ticket || '');
}

function isTerminalPendingOrder(position = {}) {
  if (position.__isPosition === true) return false;
  const type = String(position.type || position.order_type || position.cmd || '').toLowerCase();
  return type.includes('limit') || type.includes('stop') || type.includes('pending');
}

function terminalPositionQty(position = {}) {
  const candidates = [
    position.lots,
    position.volume,
    position.qty,
    position.size,
    position.contracts,
    position.volume_current
  ];
  for (const candidate of candidates) {
    const value = Math.abs(Number(candidate));
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function getTerminalPositionIdentifiers(position = {}) {
  const values = [
    position.ticket,
    position.order,
    position.order_id,
    position.orderId,
    position.position_id,
    position.positionId,
    position.id,
    position.comment,
    position.comment_string,
    position.clientOrderId
  ];
  const ids = new Set();
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (!text) continue;
    ids.add(text);
    const cid = normalizeCid(text);
    if (cid) ids.add(cid);
  }
  return ids;
}

function levelOrderChildCid(child = {}) {
  const raw = child.result?.providerOrderId || child.result?.cid || child.result?.raw?.cid || '';
  return normalizeCid(raw);
}

function levelOrderChildExpectedIds(child = {}) {
  const ids = new Set();
  const cid = levelOrderChildCid(child);
  if (cid) ids.add(cid);
  const ticket = String(child.providerOrderId || child.ticket || child.result?.ticket || '').trim();
  if (ticket) ids.add(ticket);
  return ids;
}

function normalizeSymbolForMatch(value) {
  return String(value || '').trim().toUpperCase();
}

function scanLevelOrderPositions(openOrders, children, symbol) {
  const expected = [];
  const expectedIds = new Set();
  for (const child of children || []) {
    const ids = levelOrderChildExpectedIds(child);
    const qty = Number(child.qty);
    if (ids.size && Number.isFinite(qty) && qty > 0) {
      expected.push({ ids, qty });
      for (const id of ids) expectedIds.add(id);
    }
  }
  const targetSymbol = normalizeSymbolForMatch(symbol);
  const matchedPositions = [];
  const foundIds = new Set();
  for (const pos of openOrders || []) {
    if (!pos || isTerminalPendingOrder(pos)) continue;
    if (targetSymbol && normalizeSymbolForMatch(pos.symbol) !== targetSymbol) continue;
    const posIds = getTerminalPositionIdentifiers(pos);
    const qty = terminalPositionQty(pos);
    const matchedIds = [...expectedIds].filter(id => posIds.has(id));
    if (!matchedIds.length) continue;
    matchedPositions.push(pos);
    for (const id of matchedIds) foundIds.add(id);
  }
  let expectedQty = 0;
  for (const exp of expected) expectedQty += exp.qty;
  let foundQty = 0;
  for (const pos of matchedPositions) foundQty += terminalPositionQty(pos);
  const anyCidFound = expectedIds.size > 0 && foundIds.size > 0;
  const qtyOk = expectedQty > 0 && foundQty + 1e-9 >= expectedQty;
  return {
    ready: anyCidFound && qtyOk,
    expectedQty,
    foundQty,
    expectedCids: expected.flatMap(exp => [...exp.ids]),
    foundCids: [...foundIds],
    matchedPositions: matchedPositions.length
  };
}
// ----------------- CONSTS -----------------
const PORT = envInt("TV_WEBHOOK_PORT", 3210);
const IS_ELECTRON_MENU_ENABLED = envBool("IS_ELECTRON_MENU_ENABLED", false);
const TV_WEBHOOK_TOKEN = process.env.TV_WEBHOOK_TOKEN || 'supersecret123';
process.env.TV_WEBHOOK_TOKEN = TV_WEBHOOK_TOKEN;
const APP_ROOT = app.isPackaged ? path.dirname(app.getAppPath()) : path.resolve(__dirname, '..');
global.APP_ROOT = APP_ROOT;
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const EXEC_LOG = path.join(LOG_DIR, 'executions.jsonl');
const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

// ----------------- FS utils -----------------
function ensureLogs({ truncateExecutionsOnStart = false } = {}) {
   if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
   if (!fs.existsSync(EXEC_LOG)) fs.writeFileSync(EXEC_LOG, '');
   if (truncateExecutionsOnStart) {
     // обнуляем лог заявок при старте
     fs.writeFileSync(EXEC_LOG, '');
   }
}

// --- Pending registry + wiring для адаптеров DWX-подтверждений ---
const wiredAdapters = new WeakSet();
const pendingIndex = new Map(); // pendingId(cID) -> { reqId, adapter, order, ts }
const confirmedOrderByTicket = new Map(); // provider ticket -> original normalized order
const confirmedOrderByCid = new Map(); // cid/pendingId -> original normalized order
const trackerPending = new Map(); // reqId -> { ticker, tp, sp }
const trackerIndex = new Map(); // ticket -> { ticker, tp, sp, cid }
const levelOrderPositionMonitors = new Map(); // parent requestId -> { timer, children, ... }
const groupedOrderLifecycles = new GroupedOrderLifecycleRegistry();

function emitLevelOrderPositionsReadyIfComplete(parentRequestId) {
  const snapshot = groupedOrderLifecycles.takeReadySnapshot(parentRequestId);
  if (!snapshot) return false;
  const payload = {
    requestId: parentRequestId,
    parentRequestId,
    provider: snapshot.provider,
    symbol: snapshot.symbol,
    expectedQty: snapshot.expectedQty,
    foundQty: snapshot.foundQty,
    expectedCids: snapshot.cids,
    foundCids: snapshot.cids
  };
  appendJsonl(EXEC_LOG, { t: nowTs(), kind: 'level-order-positions-ready', source: 'lifecycle', ...payload });
  console.log('[LEVEL][POSITIONS_READY]', {
    requestId: parentRequestId,
    symbol: snapshot.symbol,
    foundQty: snapshot.foundQty,
    expectedQty: snapshot.expectedQty,
    source: 'lifecycle'
  });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('level-order:positions-ready', payload);
  }
  stopLevelOrderPositionMonitor(parentRequestId);
  return true;
}

function extractCid(s) {
  const m = String(s).match(/cid[:=]\s*([a-f0-9]{8,})/i);
  return m ? m[1] : undefined;
}

function wireAdapter(adapter, providerName) {
  if (!adapter?.on || wiredAdapters.has(adapter)) return;
  wiredAdapters.add(adapter);

  adapter.on('order:confirmed', ({ pendingId, ticket, mtOrder, origOrder }) => {
    const rec = pendingIndex.get(pendingId);
    if (!rec) return;
    pendingIndex.delete(pendingId);

    const payload = {
      ts: nowTs(),
      reqId: rec.reqId,
      provider: providerName,
      status: 'ok',
      providerOrderId: String(ticket || ''),
      pendingId,
      parentRequestId: rec.order?.meta?.parentRequestId,
      childIndex: rec.order?.meta?.childIndex,
      childCount: rec.order?.meta?.childCount,
      strategyId: rec.order?.meta?.strategyId,
      order: rec.order
    };
    const normalizedTicket = String(ticket || '');
    const parentRequestId = rec.order?.meta?.parentRequestId;
    const monitor = parentRequestId ? levelOrderPositionMonitors.get(parentRequestId) : null;
    if (monitor && normalizedTicket) {
      const child = monitor.children.find(item => item.requestId === rec.reqId || levelOrderChildCid(item) === String(pendingId));
      if (child) child.providerOrderId = normalizedTicket;
    }
    if (parentRequestId && normalizedTicket) {
      groupedOrderLifecycles.registerTicket(parentRequestId, {
        provider: providerName,
        symbol: rec.order?.symbol || rec.order?.ticker || '',
        expectedCount: rec.order?.meta?.childCount,
        ticket: normalizedTicket,
        cid: pendingId,
        qty: rec.order?.qty
      });
    }
    if (normalizedTicket) confirmedOrderByTicket.set(normalizedTicket, rec.order);
    if (pendingId) confirmedOrderByCid.set(String(pendingId), rec.order);
    if (rec.cid) confirmedOrderByCid.set(String(rec.cid), rec.order);
    if (rec.order?.meta?.cid) confirmedOrderByCid.set(String(rec.order.meta.cid), rec.order);
    appendJsonl(EXEC_LOG, { t: payload.ts, kind: 'confirm', ...payload, mtOrder });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('execution:result', payload);
    }
    if (parentRequestId) {
      emitLevelOrderPositionsReadyIfComplete(parentRequestId);
    }
    const info = trackerPending.get(rec.reqId);
    if (info) {
      const cid = extractCid(mtOrder?.comment || '');
      if (cid) info.cid = cid;
      trackerIndex.set(normalizedTicket, info);
      trackerPending.delete(rec.reqId);
    }
    console.log('[EXEC][CONFIRMED]', { reqId: rec.reqId, ticket: payload.providerOrderId });
  });

  adapter.on('order:rejected', ({ pendingId, reason, msg, origOrder }) => {
    const rec = pendingIndex.get(pendingId);
    if (!rec) return;
    pendingIndex.delete(pendingId);

    const payload = {
      ts: nowTs(),
      reqId: rec.reqId,
      provider: providerName,
      status: 'rejected',
      reason: reason || 'EA error',
      pendingId,
      order: rec.order
    };
    appendJsonl(EXEC_LOG, { t: payload.ts, kind: 'reject', ...payload, msg });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('execution:result', payload);
    }
    trackerPending.delete(rec.reqId);
    console.log('[EXEC][REJECTED]', { reqId: rec.reqId, reason: payload.reason });
  });

  adapter.on('order:retry', ({ pendingId, count }) => {
    const rec = pendingIndex.get(pendingId);
    if (!rec) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('execution:retry', { reqId: rec.reqId, pendingId, count });
    }
  });

  adapter.on('position:opened', ({ ticket, order, origOrder }) => {
    const normalizedTicket = String(ticket || '');
    const cid = extractCid(order?.comment || order?.comment_string || order?.clientOrderId || order?.id || '');
    const enrichedOrigOrder = origOrder
      || confirmedOrderByTicket.get(normalizedTicket)
      || (cid ? confirmedOrderByCid.get(cid) : null)
      || (cid ? pendingIndex.get(cid)?.order : null);
    events.emit('position:opened', { ticket, order, origOrder: enrichedOrigOrder, provider: providerName });
    const parentRequestId = enrichedOrigOrder?.meta?.parentRequestId;
    console.log('[EXEC][POSITION_OPENED]', {
      provider: providerName,
      ticket: normalizedTicket,
      parentRequestId,
      cid: enrichedOrigOrder?.meta?.cid || cid
    });
    if (parentRequestId && normalizedTicket) {
      groupedOrderLifecycles.markOpened(parentRequestId, {
        provider: providerName,
        symbol: enrichedOrigOrder?.symbol || enrichedOrigOrder?.ticker || order?.symbol || '',
        expectedCount: enrichedOrigOrder?.meta?.childCount,
        ticket: normalizedTicket,
        cid: enrichedOrigOrder?.meta?.cid,
        qty: enrichedOrigOrder?.qty ?? order?.size
      });
      emitLevelOrderPositionsReadyIfComplete(parentRequestId);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('position:opened', { ticket, order, origOrder: enrichedOrigOrder, provider: providerName });
    }
  });

  adapter.on('position:closed', ({ ticket, trade }) => {
    events.emit('position:closed', { ticket, trade, provider: providerName });
    const info = trackerIndex.get(String(ticket));
    const profit = trade?.profit;
    if (info) {
      trackerIndex.delete(String(ticket));
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('position:closed', { ticket, trade, profit, provider: providerName });
    }
  });

  adapter.on('order:cancelled', ({ ticket }) => {
    events.emit('order:cancelled', { ticket, provider: providerName });
    trackerIndex.delete(String(ticket));
    groupedOrderLifecycles.removeTicket(ticket, providerName);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('order:cancelled', { ticket, provider: providerName });
    }
  });
}

function appendJsonl(file, obj) {
  try { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); }
  catch (e) { console.error('appendJsonl error:', e); }
}
const nowTs = () => Date.now();

// ----------------- Electron window -----------------
let mainWindow;
let orderCardServices = [];
let orderCardService;
let windowStateSaveTimer = null;

function loadWindowState() {
  try {
    if (!fs.existsSync(WINDOW_STATE_FILE)) return {};
    const raw = fs.readFileSync(WINDOW_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const state = {};
    if (Number.isFinite(parsed.width) && parsed.width > 100) state.width = Math.trunc(parsed.width);
    if (Number.isFinite(parsed.height) && parsed.height > 100) state.height = Math.trunc(parsed.height);
    if (Number.isFinite(parsed.x)) state.x = Math.trunc(parsed.x);
    if (Number.isFinite(parsed.y)) state.y = Math.trunc(parsed.y);
    if (typeof parsed.maximized === 'boolean') state.maximized = parsed.maximized;
    return state;
  } catch (err) {
    console.warn('[windowState] Failed to load state:', err?.message || err);
    return {};
  }
}

function writeWindowState(state) {
  try {
    fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn('[windowState] Failed to save state:', err?.message || err);
  }
}

function saveWindowStateNow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  const state = {
    ...bounds,
    maximized: mainWindow.isMaximized()
  };
  writeWindowState(state);
}

function getWindowStateSnapshot() {
  if (!mainWindow || mainWindow.isDestroyed()) return loadWindowState();
  return {
    ...mainWindow.getBounds(),
    maximized: mainWindow.isMaximized()
  };
}

function setWindowState(state = {}) {
  if (!state || typeof state !== 'object') return getWindowStateSnapshot();
  const current = getWindowStateSnapshot();
  const next = {...current};
  if (Number.isFinite(state.width) && state.width > 100) next.width = Math.trunc(state.width);
  if (Number.isFinite(state.height) && state.height > 100) next.height = Math.trunc(state.height);
  if (Number.isFinite(state.x)) next.x = Math.trunc(state.x);
  if (Number.isFinite(state.y)) next.y = Math.trunc(state.y);
  if (typeof state.maximized === 'boolean') next.maximized = state.maximized;
  writeWindowState(next);
  return next;
}

servicesApi.settings?.onApply?.('ui', ({ config }) => {
  uiCfg = config || {};
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setAlwaysOnTop(uiCfg.alwaysOnTop === true);
  const current = mainWindow.getBounds();
  const next = { ...current };
  if (Number.isFinite(uiCfg.width) && uiCfg.width > 100) next.width = Math.trunc(uiCfg.width);
  if (Number.isFinite(uiCfg.height) && uiCfg.height > 100) next.height = Math.trunc(uiCfg.height);
  if (Number.isFinite(uiCfg.x)) next.x = Math.trunc(uiCfg.x);
  if (Number.isFinite(uiCfg.y)) next.y = Math.trunc(uiCfg.y);
  mainWindow.setBounds(next);
  setWindowState(next);
});

function scheduleWindowStateSave() {
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null;
    saveWindowStateNow();
  }, 250);
}

function createWindow() {
  const savedState = loadWindowState();
  mainWindow = new BrowserWindow({
    width: savedState.width || uiCfg?.width || 1280,
    height: savedState.height || uiCfg?.height || 900,
    x: Number.isFinite(savedState.x) ? savedState.x : Number.isFinite(uiCfg?.x) ? uiCfg.x : undefined,
    y: Number.isFinite(savedState.y) ? savedState.y : Number.isFinite(uiCfg?.y) ? uiCfg.y : undefined,
    alwaysOnTop: uiCfg?.alwaysOnTop === true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  if (savedState.maximized) {
    mainWindow.maximize();
  }
  mainWindow.on('resize', scheduleWindowStateSave);
  mainWindow.on('move', scheduleWindowStateSave);
  mainWindow.on('close', saveWindowStateNow);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  if (IS_ELECTRON_MENU_ENABLED == false) {
    Menu.setApplicationMenu(null);
  }
  // mainWindow.webContents.openDevTools();
}

ipcMain.handle('window:get-state', () => getWindowStateSnapshot());
ipcMain.handle('window:set-state', (_evt, state) => setWindowState(state));

app.whenReady().then(() => {
  ensureLogs({ truncateExecutionsOnStart: true });

  const sourcesCfg = orderCardsCfg?.sources || [{ type: 'webhook' }];
  orderCardServices = sourcesCfg.map((src) => {
    const normalized = (src && typeof src === 'object' && !Array.isArray(src))
      ? src
      : { type: typeof src === 'string' ? src : 'webhook' };
    const type = normalized.type || 'webhook';
    const opts = {
      ...normalized,
      type,
      nowTs,
      onRow(row) {
        const ticker = row.ticker || row.symbol;
        const instrumentType = row.instrumentType || detectInstrumentType(String(ticker || ''));
        row.provider = resolveProviderName({ row, symbol: ticker, instrumentType });
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('orders:new', row);
        }
      }
    };
    if (type === 'webhook') {
      opts.port = resolveWebhookPort(normalized.port, PORT);
      opts.logFile = path.join(LOG_DIR, normalized.logFile || 'webhooks.jsonl');
      opts.truncateOnStart = normalized.truncateOnStart ?? true;
    }
    return createOrderCardService(opts);
  });
  for (const svc of orderCardServices) svc.start();

  orderCardService = {
    async getOrdersList(rows = 100) {
      const lists = await Promise.all(orderCardServices.map((s) => s.getOrdersList(rows)));
      const combined = lists.flat().sort((a, b) => (b.time || 0) - (a.time || 0));
      return combined.map((row) => {
        const ticker = row.ticker || row.symbol;
        const instrumentType = row.instrumentType || detectInstrumentType(String(ticker || ''));
        return { ...row, provider: resolveProviderName({ row, symbol: ticker, instrumentType }) };
      });
    }
  };

  createWindow();
  setupIpc(orderCardService);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
});

// ----------------- IPC: queue-place-order -----------------

// Поддерживаем 2 формата payload:
// A) legacy: { ticker,event,price,kind,meta:{qty,stopPts,takePts,riskUsd?} }
// B) new:    { symbol,side,qty,price,sl,tp,meta:{riskUsd?} }
function normalizeOrderPayload(payload) {
  if (payload?.instrumentType === 'OPT') {
    const symbol = String(payload.symbol || payload.ticker || '');
    return {
      instrumentType: 'OPT',
      symbol,
      ticker: symbol,
      root: payload.root,
      provider: payload.provider,
      name: payload.name,
      description: payload.description,
      expirationDte: payload.expirationDte || payload.expiration,
      isCustomName: payload.isCustomName === true,
      isCashSecured: payload.isCashSecured === true,
      legs: Array.isArray(payload.legs) ? payload.legs : [],
      side: payload.side || payload.action || 'OPEN',
      type: payload.type || 'strategy',
      qty: 1,
      price: 1,
      sl: 1,
      meta: payload.meta || {}
    };
  }
  // определим формат
  const legacy = payload && payload.ticker && payload.meta;
  if (legacy) {
    const symbol = String(payload.ticker || '');
    const instrumentType =  payload.instrumentType;
    const comment = payload.comment ?? payload.meta?.comment;
    return {
        instrumentType ,                // 'CX' | 'EQ' | 'FX'
      symbol,                        // 'BTCUSDT.P' | 'AAPL'
      provider: payload.provider || payload.meta?.provider,
      side: payload.kind,            // 'BL'|'BSL'|'SL'|'SSL'
      type: payload.type,
      tickSize: payload.tickSize,
      qty: normalizeOrderQty(payload.meta.qty, instrumentType, payload.meta),
      price: Number(payload.price || 0),
      sl: Number(payload.meta.stopPts || 0),
      tp: payload.meta.takePts == null ? undefined : Number(payload.meta.takePts),
      comment: comment == null ? undefined : String(comment),
      meta: payload.meta || {}
    };
  }

  // новый формат
  const symbol = String(payload.symbol || payload.ticker || '');
  const instrumentType =  payload.instrumentType;
  const comment = payload.comment ?? payload.meta?.comment;
  const isHedgeMarket = payload?.meta?.hedge === true && String(payload.type || '').toLowerCase() === 'market';
  return {
    instrumentType,
    symbol,
    provider: payload.provider || payload.meta?.provider,
    side: payload.side || payload.action, // 'BL'|'BSL'|'SL'|'SSL'
    type: payload.type,
    tickSize: payload.tickSize,
    qty: normalizeOrderQty(payload.qty, instrumentType, payload.meta),
    price: isHedgeMarket ? undefined : Number(payload.price || 0),
    sl: isHedgeMarket ? undefined : Number(payload.sl || 0),
    tp: isHedgeMarket || payload.tp === '' || payload.tp == null ? undefined : Number(payload.tp),
    comment: comment == null ? undefined : String(comment),
    meta: payload.meta || {}
  };
}

function validateOrder(order) {
  if (order.instrumentType === 'OPT') {
    const hasSymbol = !!String(order.symbol || order.ticker || '').trim();
    const hasLegs = Array.isArray(order.legs) && order.legs.length > 0;
    return hasSymbol && hasLegs
      ? { ok: true }
      : { ok: false, reason: 'OPT: ticker and legs required' };
  }
  if (order.instrumentType === 'CX') {
    const riskUsd = Number(order.meta?.riskUsd);
    const hasRiskSizing = Number.isFinite(riskUsd) && riskUsd > 0;
    const hasManualQty = Number(order.qty) > 0;
    const ok = Number(order.price) > 0 && Number(order.sl) > 0 && (hasManualQty || hasRiskSizing);
    return ok ? { ok: true } : { ok: false, reason: 'CX: price>0, sl>0 and qty>0 or riskUsd>0 required' };
  } else if (order.instrumentType === 'FX') {
    const ok = (order.meta?.riskUsd > 0) && order.sl > 0 && order.price > 0 && order.qty > 0;
    return ok ? { ok: true } : { ok: false, reason: 'FX: riskUsd>0, sl>0, price>0, qty>0 required' };
  } else {
    const isHedge = order.meta?.hedge === true;
    const type = String(order.type || '').toLowerCase();
    const needsPrice = type !== 'market';
    const hasPrice = Number(order.price) > 0 || !needsPrice;
    const hasQty = isValidOrderQty(order.qty, order.instrumentType, order.meta);
    const hasRiskShape = (order.meta?.riskUsd > 0) && order.sl > 0 && Number(order.price) > 0;
    const ok = hasQty && (isHedge ? hasPrice : hasRiskShape);
    return ok ? { ok: true } : { ok: false, reason: 'EQ: riskUsd>0, sl>0, price>0, valid qty required (or hedge qty with price/market)' };
  }
}


function providerCanResolveRiskQty(providerName, adapter) {
  const p = String(providerName || '').toLowerCase();
  const id = String(adapter?.exchangeId || '').toLowerCase();
  return p.includes('binance') || ['binance', 'binanceusdm', 'binance-futures', 'binancefutures'].includes(id);
}

function resolveProviderName(context = {}) {
  if (typeof resolveProvider === 'function') {
    return resolveProvider(context).provider;
  }
  const explicit = context.provider || context.payload?.provider || context.row?.provider || context.meta?.provider;
  return String(explicit || 'simulated').trim().toLowerCase();
}

function resolveOrderProviderName(order) {
  return resolveProviderName({
    payload: order,
    symbol: order?.symbol || order?.ticker,
    instrumentType: order?.instrumentType,
    meta: order?.meta
  });
}

// --- EQ normalization: BL/BSL/SL/SSL -> buy/sell + limit/stoplimit (для адаптеров типа J2T)
function normalizeQuoteForValidation(quote) {
  if (!quote || typeof quote !== 'object') return quote;
  if (Number.isFinite(Number(quote.price))) return quote;
  const bid = Number(quote.bid);
  const ask = Number(quote.ask);
  if (Number.isFinite(bid) && Number.isFinite(ask)) return { ...quote, price: (bid + ask) / 2 };
  if (Number.isFinite(bid)) return { ...quote, price: bid };
  if (Number.isFinite(ask)) return { ...quote, price: ask };
  return quote;
}

function stopLevelOrderPositionMonitor(requestId) {
  const monitor = levelOrderPositionMonitors.get(requestId);
  if (monitor?.timer) clearTimeout(monitor.timer);
  levelOrderPositionMonitors.delete(requestId);
}

async function cancelGroupedOrderUnopenedTickets(groupId) {
  const group = groupedOrderLifecycles.get(groupId);
  if (!group) return { cancelled: 0, errors: [] };
  const adapter = getAdapter(group.provider);
  wireAdapter(adapter, group.provider);
  const errors = [];
  let cancelled = 0;
  for (const ticket of groupedOrderLifecycles.getUnopenedTickets(groupId)) {
    try {
      const result = await adapter.cancelOrder(ticket, group.symbol);
      cancelled += 1;
      appendJsonl(EXEC_LOG, {
        t: nowTs(),
        kind: 'level-order-cancel-terminal',
        parentRequestId: groupId,
        provider: group.provider,
        ticket,
        symbol: group.symbol,
        result
      });
    } catch (err) {
      const reason = err?.message || String(err);
      errors.push({ ticket, reason });
      appendJsonl(EXEC_LOG, {
        t: nowTs(),
        kind: 'level-order-cancel-terminal',
        parentRequestId: groupId,
        provider: group.provider,
        ticket,
        symbol: group.symbol,
        error: reason
      });
    }
  }
  return { cancelled, errors };
}

function startLevelOrderPositionMonitor({ adapter, providerName, requestId, strategyId, symbol, children, timeoutMs = 45000, intervalMs = 750 }) {
  if (
    !requestId
    || !adapter
    || (typeof adapter.listOpenPositions !== 'function' && typeof adapter.listOpenOrders !== 'function')
  ) return;
  stopLevelOrderPositionMonitor(requestId);
  const startedAt = Date.now();
  const monitor = { adapter, providerName, requestId, strategyId, symbol, children: children || [], timer: null };
  levelOrderPositionMonitors.set(requestId, monitor);

  const tick = async () => {
    try {
      const openPositions = typeof adapter.listOpenPositions === 'function'
        ? await adapter.listOpenPositions(symbol)
        : await adapter.listOpenOrders(symbol);
      const scan = scanLevelOrderPositions(openPositions, monitor.children, symbol);
      if (scan.ready) {
        stopLevelOrderPositionMonitor(requestId);
        const payload = {
          requestId,
          parentRequestId: requestId,
          provider: providerName,
          strategyId,
          symbol,
          expectedQty: scan.expectedQty,
          foundQty: scan.foundQty,
          expectedCids: scan.expectedCids,
          foundCids: scan.foundCids
        };
        appendJsonl(EXEC_LOG, { t: nowTs(), kind: 'level-order-positions-ready', ...payload });
        console.log('[LEVEL][POSITIONS_READY]', { requestId, symbol, foundQty: scan.foundQty, expectedQty: scan.expectedQty });
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('level-order:positions-ready', payload);
        }
        return;
      }
    } catch (err) {
      console.warn('[LEVEL][POSITIONS_POLL_ERR]', { requestId, error: err?.message || String(err) });
    }

    if (Date.now() - startedAt >= timeoutMs) {
      stopLevelOrderPositionMonitor(requestId);
      let sample = [];
      let scan = null;
      try {
        const openPositions = typeof adapter.listOpenPositions === 'function'
          ? await adapter.listOpenPositions(symbol)
          : await adapter.listOpenOrders(symbol);
        scan = scanLevelOrderPositions(openPositions, monitor.children, symbol);
        sample = (openPositions || []).slice(0, 10).map(pos => ({
          ticket: pos?.ticket,
          type: pos?.type || pos?.order_type || pos?.cmd,
          symbol: pos?.symbol,
          comment: pos?.comment || pos?.comment_string,
          qty: terminalPositionQty(pos),
          isPosition: pos?.__isPosition === true
        }));
      } catch {}
      console.warn('[LEVEL][POSITIONS_TIMEOUT]', { requestId, symbol, scan, sample });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('level-order:positions-timeout', { requestId, parentRequestId: requestId, provider: providerName, strategyId, symbol });
      }
      return;
    }
    monitor.timer = setTimeout(tick, intervalMs);
    levelOrderPositionMonitors.set(requestId, monitor);
  };

  monitor.timer = setTimeout(tick, intervalMs);
  levelOrderPositionMonitors.set(requestId, monitor);
}

function normalizeEquityOrderForExecution(order) {
  if (!['EQ','FX','CX'].includes(String(order.instrumentType))) return order;

  const action = String(order.side || '').toUpperCase();
  const alreadySide = String(order.side || '').toLowerCase();
  if (alreadySide === 'buy' || alreadySide === 'sell') {
    const type = String(order.type || 'limit').toLowerCase();
    const norm = { ...order, side: alreadySide, type };
    if ((type === 'limit' || type === 'stoplimit') && Number.isFinite(Number(order.price))) {
      norm.limitPrice = Number(order.price);
    }
    if ((type === 'stop' || type === 'stoplimit') && Number.isFinite(Number(order.price))) {
      norm.stopPrice = Number(order.price);
    }
    return norm;
  }
  let side, type, limitPrice, stopPrice;

  // Базовая интерпретация
  switch (action) {
    case 'BL':
      side = 'buy';  type = 'limit';     limitPrice = Number(order.price); break;
    case 'SL':
      side = 'sell'; type = 'limit';     limitPrice = Number(order.price); break;
    case 'BSL':
      side = 'buy';  type = 'stoplimit'; stopPrice = Number(order.price);  limitPrice = Number(order.price); break;
    case 'SSL':
      side = 'sell'; type = 'stoplimit'; stopPrice = Number(order.price);  limitPrice = Number(order.price); break;
    default:
      return order; // пусть упадёт на валидации адаптера
  }

  const norm = { ...order, side, type };
  if (type === 'limit' || type === 'stoplimit') norm.limitPrice = limitPrice;
  if (type === 'stop' || type === 'stoplimit')  norm.stopPrice  = stopPrice;
  return norm;
}

function setupIpc(orderSvc) {
  async function queuePlaceOrderInternal(payload) {
    const order = normalizeOrderPayload(payload);

    // серверная валидация (зеркалит UI)
    const v = validateOrder(order);
    if (!v.ok) {
      const rej = { status: 'rejected', reason: v.reason };
      appendJsonl(EXEC_LOG, { t: nowTs(), kind: 'place', valid: false, order, result: rej });
      return rej;
    }

    // выбор адаптера, requestId и нормализация под исполнение
    const providerName = resolveOrderProviderName(order);
    let execOrder;
    let cid = '';
    try {
      const ts = nowTs();
      const reqId = order?.meta?.requestId || `${ts}_${Math.random().toString(36).slice(2,8)}`;
      if (!order.meta) order.meta = {};
      order.meta.requestId = reqId;
      cid = ensureOrderCid(order);

        const sideCode = String(order.side || '').toUpperCase();
        const sideDir = sideCode.startsWith('S') || sideCode === 'SELL' ? 'short' : 'long';
        trackerPending.set(reqId, {
          ticker: order.meta?.ticker || order.symbol,
          tp: order.meta?.takePts,
          sp: order.meta?.stopPts,
          side: sideDir,
          cid,
          price: order.price,
          qty: order.qty
        });

      execOrder = normalizeEquityOrderForExecution(order);
      execOrder.comment = ensureCommentHasCid(execOrder.comment, cid);
      if (!execOrder.meta) execOrder.meta = {};
      execOrder.meta.cid = cid;

      const logOrder = {
        ...execOrder,
        cid,
        comment: execOrder.comment,
        sentAt: ts,
        meta: { ...(execOrder.meta || {}), cid, sentAt: ts, provider: providerName }
      };
      events.emit('execution:order-message', logOrder);

      const adapter = getAdapter(providerName);
      // разово подключим слушатели подтверждений (если адаптер их поддерживает)
      wireAdapter(adapter, providerName);

      const isOptionBlock = execOrder.instrumentType === 'OPT';
      const isHedgeMarket = !isOptionBlock
        && execOrder.meta?.hedge === true
        && String(execOrder.type || '').toLowerCase() === 'market';
      const instrumentSnapshot = await instrumentInfo.get({
        provider: providerName,
        symbol: execOrder.symbol,
        instrumentType: execOrder.instrumentType,
        payload: execOrder
      }, { forceQuote: true });
      const quote = normalizeQuoteForValidation(instrumentSnapshot?.quote);
      if (!isOptionBlock && !isHedgeMarket && (!quote || !Number.isFinite(quote.price))) {
        const rej = { status: 'rejected', provider: providerName, reason: 'No quote' };
        appendJsonl(EXEC_LOG, { t: ts, kind: 'place', valid: true, reqId, cid, provider: providerName, order: execOrder, result: rej });
        return rej;
      }

      const riskUsd = Number(order?.meta?.riskUsd);
      const stopPts = Number(execOrder.sl);
      const isFixedQty = order?.meta?.fixedQty === true;
      const isRiskBased = !isFixedQty && Number.isFinite(riskUsd) && riskUsd > 0 && Number.isFinite(stopPts) && stopPts > 0;
      const tickResolution = instrumentInfo.getTickSizeResolution({
        provider: providerName,
        symbol: execOrder.symbol,
        instrumentType: execOrder.instrumentType,
        payload: execOrder
      }, { explicitTickSize: execOrder.tickSize });
      const effectiveTickSize = tickResolution.tickSize;
      const metadataQuantityStep = Number(instrumentSnapshot?.metadata?.quantityStep);
      if (Number.isFinite(metadataQuantityStep) && metadataQuantityStep > 0) {
        execOrder.meta = { ...(execOrder.meta || {}), quantityStep: execOrder.meta?.quantityStep || metadataQuantityStep };
      }

      if (!isOptionBlock && Number.isFinite(effectiveTickSize) && effectiveTickSize > 0) {
        execOrder.tickSize = effectiveTickSize;
        if (isRiskBased) {
          execOrder.qty = orderCalc.qty({
            riskUsd,
            stopPts,
            tickSize: effectiveTickSize,
            lot: execOrder.lot || order.lot || 1,
            instrumentType: execOrder.instrumentType,
            quantityStep: execOrder.meta?.quantityStep
          });
        }
      } else if (!isOptionBlock && isRiskBased) {
        if (!providerCanResolveRiskQty(providerName, adapter)) {
          const rej = { status: 'rejected', provider: providerName, reason: `No tickSize for ${execOrder.symbol}; cannot calculate risk-based qty for provider ${providerName}` };
          appendJsonl(EXEC_LOG, { t: ts, kind: 'place', valid: true, reqId, cid, provider: providerName, order: execOrder, result: rej });
          return rej;
        }
        execOrder.meta.riskBasedQtyPending = true;
        execOrder.meta.riskUsd = riskUsd;
        execOrder.meta.stopPts = stopPts;
      }

      console.log('[EXEC][SIZE]', { symbol: execOrder.symbol, price: execOrder.price, riskUsd, stopPts, tickSize: execOrder.tickSize, lot: execOrder.lot, qty: execOrder.qty, tickSource: tickResolution.source });

      if (!isOptionBlock) {
        const quoteForRules = isHedgeMarket && (!quote || !Number.isFinite(quote.price)) ? { price: 1 } : quote;
        const ruleOrder = execOrder.meta?.hedge === true
          ? { ...execOrder, sl: Number.isFinite(Number(execOrder.sl)) && Number(execOrder.sl) > 0 ? execOrder.sl : Number.POSITIVE_INFINITY }
          : execOrder;
        const rule = tradeRules.validate(ruleOrder, quoteForRules);
        if (!rule.ok) {
          const rej = { status: 'rejected', provider: providerName, reason: rule.reason };
          appendJsonl(EXEC_LOG, { t: ts, kind: 'place', valid: true, reqId, cid, provider: providerName, order: execOrder, result: rej });
          return rej;
        }
      }

      console.log('[EXEC][REQ]', { provider: providerName, reqId, cid, symbol: execOrder.symbol, action: order.side, side: execOrder.side, type: execOrder.type, qty: execOrder.qty, price: execOrder.price, sl: execOrder.sl, tp: execOrder.tp });

      const result = await adapter.placeOrder(execOrder);

      // если адаптер вернул "pending:<cid>" — не закрываем карточку,
      // отправляем в UI спец-событие и ждём order:confirmed
      const maybePending = String(result?.providerOrderId || '');
      if (maybePending.startsWith('pending:')) {
        const pendingId = normalizeCid(maybePending) || cid;
        pendingIndex.set(pendingId, { reqId, adapter, providerName, order: execOrder, ts, cid: pendingId });

        appendJsonl(EXEC_LOG, {
          t: ts,
          kind: 'place-queued',
          reqId,
          provider: providerName,
          pendingId,
          cid: pendingId,
          order: execOrder
        });

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('execution:pending', {
            ts,
            reqId,
            provider: providerName,
            pendingId,
            cid: pendingId,
            parentRequestId: execOrder.meta?.parentRequestId,
            childIndex: execOrder.meta?.childIndex,
            childCount: execOrder.meta?.childCount,
            strategyId: execOrder.meta?.strategyId,
            order: execOrder
          });
        }

        events.emit('order:placed', { order: execOrder, result: { status: 'ok', provider: providerName, providerOrderId: result.providerOrderId, cid: pendingId } });

        console.log('[EXEC][QUEUED]', { reqId, pendingId, cid: pendingId });
        // для синхронного ответа IPC можно вернуть «ok» с pendingId,
        // но UI должен ждать финального события 'execution:result'
        return { status: 'ok', provider: providerName, providerOrderId: result.providerOrderId, cid: pendingId };
      }

      // иначе — поведение как раньше (simulated/rejected/другие адаптеры)
      const execRecord = {
        t: ts,
        kind: 'place',
        reqId,
        cid,
        valid: true,
        provider: (result && result.provider) || providerName,
        order: execOrder,
        result
      };
      appendJsonl(EXEC_LOG, execRecord);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('execution:result', {
          ts,
          reqId,
          provider: execRecord.provider,
          status: result?.status || 'rejected',
          reason: result?.reason,
          providerOrderId: result?.providerOrderId,
          cid,
          parentRequestId: execOrder.meta?.parentRequestId,
          childIndex: execOrder.meta?.childIndex,
          childCount: execOrder.meta?.childCount,
          strategyId: execOrder.meta?.strategyId,
          payoff: result?.payoff || result?.raw?.payoff,
          raw: result?.raw,
          order: execOrder
        });
      }

      const info = trackerPending.get(reqId);
      if (info && result?.status !== 'rejected' && result?.providerOrderId) {
        trackerIndex.set(String(result.providerOrderId), info);
      }
      trackerPending.delete(reqId);

      const lifecycleResult = result?.status === 'ok'
        ? { ...result, provider: execRecord.provider, cid }
        : { status: result?.status || 'rejected', provider: execRecord.provider, providerOrderId: result?.providerOrderId, reason: result?.reason, cid };
      events.emit('order:placed', { order: execOrder, result: lifecycleResult });

      console.log('[EXEC][RES]', { reqId, cid, status: result?.status, reason: result?.reason, providerOrderId: result?.providerOrderId });
      return result;
  } catch (err) {
      const rej = { status: 'rejected', reason: err.message || 'adapter error' };
      const errorCid = cid || normalizeCid(order?.meta?.cid);
      appendJsonl(EXEC_LOG, { t: nowTs(), kind: 'place', valid: true, order, reqId: order?.meta?.requestId, cid: errorCid || undefined, error: String(err) });

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('execution:result', {
          ts: nowTs(),
          reqId: order?.meta?.requestId,
          provider: providerName,
          status: 'rejected',
          reason: rej.reason,
          cid: errorCid || undefined,
          order
        });
      }
      trackerPending.delete(order?.meta?.requestId);
      console.log('[EXEC][ERR]', { provider: providerName, reqId: order?.meta?.requestId, cid: errorCid || undefined, error: String(err) });
      events.emit('order:placed', { order: execOrder, result: { status: 'rejected', provider: providerName, reason: rej.reason, cid: errorCid || undefined } });
      return rej;
    }
  }

  servicesApi.execution = {
    queuePlaceOrder: queuePlaceOrderInternal,
    pickProviderName: (instrumentType) => resolveProviderName({ instrumentType })
  };

  ipcMain.handle('optionstrat:button-event', async (_evt, payload = {}) => {
    const { eventName, payload: eventPayload } = buildOptionStratHedgePayload(payload.action, payload.row || {});
    if (!eventPayload.hedgeOpenSide) {
      return { ok: false, reason: 'Unsupported OptionStrat strategy for hedge automation' };
    }
    if (servicesApi.actionBus && typeof servicesApi.actionBus.emit === 'function') {
      servicesApi.actionBus.emit(eventName, eventPayload);
      return { ok: true, event: eventName, payload: eventPayload };
    }
    return { ok: false, reason: 'actions-bus is not available' };
  });

  const pendingHub = createPendingOrderHub({
    subscribe: (provider, symbols) => {
      const adapter = getAdapter(provider);
      try { adapter.client?.subscribe_symbols_bar_data(symbols.map(s => [s, 'M1'])); } catch {}
    },
    ipcMain,
    queuePlaceOrder: queuePlaceOrderInternal,
    wireAdapter,
    mainWindow,
    instrumentInfo
  });
  servicesApi.settings?.onApply?.('pending-strategies', ({ config }) => pendingHub.configureStrategies(config));

  async function queueLevelOrderInternal(payload = {}) {
    const symbol = String(payload.ticker || payload.symbol || '').trim();
    const instrumentType = payload.instrumentType || detectInstrumentType(symbol);
    const providerName = resolveProviderName({ payload, symbol, instrumentType, meta: payload.meta });
    const strategyId = payload.strategyId || generateCid();
    const requestId = payload.requestId || `${nowTs()}_${Math.random().toString(36).slice(2,8)}`;

    try {
      const adapter = getAdapter(providerName);
      wireAdapter(adapter, providerName);
      const instrumentSnapshot = await instrumentInfo.get({ provider: providerName, symbol, instrumentType, payload }, { forceQuote: true });
      const quote = instrumentSnapshot?.quote;
      const bid = Number(quote?.bid);
      const ask = Number(quote?.ask);
      const tickSize = instrumentInfo.resolveTickSize(
        { provider: providerName, symbol, instrumentType, payload },
        { explicitTickSize: payload.tickSize }
      );
      const plan = calculateLimitBidTradePlan({
        action: payload.action,
        ticker: symbol,
        instrumentType,
        level: payload.level,
        riskUsd: payload.riskUsd,
        stopOffsetPts: payload.stopOffsetPts,
        maxLot: payload.maxLot,
        minLot: payload.minLot ?? instrumentSnapshot?.metadata?.quantityStep,
        takeProfitPts: payload.takeProfitPts,
        bid,
        ask,
        buyPriceSource: payload.buyPriceSource,
        sellPriceSource: payload.sellPriceSource,
        tickSize,
        lot: payload.lot || 1,
        orderCalculator: orderCalc
      });
      if (!plan.ok) {
        const rej = { status: 'rejected', provider: providerName, reason: plan.reason };
        appendJsonl(EXEC_LOG, { t: nowTs(), kind: 'level-order', valid: false, reqId: requestId, provider: providerName, payload, quote, result: rej });
        return rej;
      }

      const results = [];
      for (let i = 0; i < plan.childQtys.length; i += 1) {
        const childReqId = `${requestId}_${i + 1}`;
        const childPayload = {
          ticker: symbol,
          event: 'levelOrder',
          price: plan.referencePrice,
          kind: plan.orderKind,
          instrumentType,
          tickSize: plan.tickSize,
          provider: providerName,
          meta: {
            requestId: childReqId,
            qty: plan.childQtys[i],
            stopPts: plan.stopPts,
            takePts: plan.takeProfitPts,
            riskUsd: plan.riskUsd,
            fixedQty: true,
            strategy: 'limitBidTrade',
            strategyId,
            parentRequestId: requestId,
            childIndex: i + 1,
            childCount: plan.childQtys.length,
            level: plan.level,
            bid: plan.bid,
            ask: plan.ask,
            priceSource: plan.priceSource,
            referencePrice: plan.referencePrice,
            stopOffsetPts: plan.stopOffsetPts,
            minLot: plan.minLot,
            quantityStep: plan.minLot,
            pointSize: payload.pointSize,
            stopPrice: plan.stopPrice
          }
        };
        const res = await queuePlaceOrderInternal(childPayload);
        results.push({ requestId: childReqId, qty: plan.childQtys[i], result: res });
        if (!res || res.status === 'rejected' || res.status === 'error') {
          const rej = {
            status: 'rejected',
            provider: providerName,
            reason: res?.reason || 'Level order child rejected',
            raw: { plan, results }
          };
          appendJsonl(EXEC_LOG, { t: nowTs(), kind: 'level-order', valid: true, reqId: requestId, provider: providerName, strategyId, plan, result: rej });
          return rej;
        }
      }

      const ok = {
        status: 'ok',
        provider: providerName,
        providerOrderId: `level:${strategyId}`,
        strategyId,
        raw: { plan, results }
      };
      startLevelOrderPositionMonitor({
        adapter,
        providerName,
        requestId,
        strategyId,
        symbol,
        children: results
      });
      appendJsonl(EXEC_LOG, { t: nowTs(), kind: 'level-order', valid: true, reqId: requestId, provider: providerName, strategyId, plan, result: ok });
      return ok;
    } catch (err) {
      const reason = err?.message || String(err);
      appendJsonl(EXEC_LOG, { t: nowTs(), kind: 'level-order', valid: true, reqId: requestId, provider: providerName, strategyId, payload, error: reason });
      return { status: 'rejected', provider: providerName, reason };
    }
  }

  servicesApi.execution.queueLevelOrder = queueLevelOrderInternal;

  ipcMain.handle('level-order:place', async (_evt, payload = {}) => queueLevelOrderInternal(payload));

  ipcMain.handle('execution:stop-retry', async (_evt, reqId) => {
    const matches = collectRetryStopEntries(pendingIndex, reqId);
    const parentIds = getRetryStopParentIds(reqId, matches);
    let terminalCancelled = 0;
    const terminalErrors = [];

    for (const parentId of parentIds) {
      stopLevelOrderPositionMonitor(parentId);
      const terminalResult = await cancelGroupedOrderUnopenedTickets(parentId);
      terminalCancelled += terminalResult.cancelled;
      terminalErrors.push(...terminalResult.errors);
    }

    for (const { pendingId, rec } of matches) {
      rec.adapter?.stopOpenOrder?.(pendingId);
      pendingIndex.delete(pendingId);
      trackerPending.delete(rec.reqId);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('execution:retry-stopped', {
          reqId: rec.reqId,
          pendingId,
          parentRequestId: rec.order?.meta?.parentRequestId
        });
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      for (const parentId of parentIds) {
        mainWindow.webContents.send('execution:retry-stopped', {
          reqId: parentId,
          parentRequestId: parentId,
          stopped: matches.length
        });
      }
    }

    return { status: 'ok', stopped: matches.length, terminalCancelled, terminalErrors };
  });

  ipcMain.handle('execution:cancel-order', async (_evt, payload = {}) => {
    const providerNameRaw = payload.provider;
    const ticketRaw = payload.ticket;
    const symbolRaw = payload.symbol;
    const nameRaw = payload.name || payload.order?.name;
    const providerName = typeof providerNameRaw === 'string' ? providerNameRaw : String(providerNameRaw || '');
    const ticket = typeof ticketRaw === 'string' ? ticketRaw : String(ticketRaw || '');
    const symbol = typeof symbolRaw === 'string' ? symbolRaw : (symbolRaw == null ? undefined : String(symbolRaw));
    const name = typeof nameRaw === 'string' ? nameRaw : (nameRaw == null ? undefined : String(nameRaw));

    if (!providerName || !ticket) {
      return { status: 'error', reason: 'provider and ticket required' };
    }

    try {
      const adapter = getAdapter(providerName);
      wireAdapter(adapter, providerName);
      if (typeof adapter?.cancelOrder !== 'function') {
        const res = { status: 'unsupported', provider: providerName };
        appendJsonl(EXEC_LOG, { t: nowTs(), kind: 'cancel', provider: providerName, ticket, symbol, result: res });
        return res;
      }
      const result = await adapter.cancelOrder(ticket, symbol);
      appendJsonl(EXEC_LOG, { t: nowTs(), kind: 'cancel', provider: providerName, ticket, symbol, result });
      const res = result || { status: 'ok', provider: providerName };
      const isOptionStratClose = String(providerName || '').toLowerCase() === 'optionstrat' || !!res?.raw?.strategy;
      if (res.status === 'ok' && isOptionStratClose) {
        events.emit('order:closed', {
          provider: providerName,
          ticket,
          symbol,
          order: name ? { name } : undefined,
          result: { ...res, provider: res.provider || providerName }
        });
      }
      return res;
    } catch (err) {
      const reason = err?.message || String(err || '');
      appendJsonl(EXEC_LOG, { t: nowTs(), kind: 'cancel', provider: providerName, ticket, symbol, error: reason });
      return { status: 'error', provider: providerName, reason };
    }
  });

  ipcMain.handle('optionstrat:estimate', async (_evt, payload = {}) => {
    const order = normalizeOrderPayload({
      ...payload,
      instrumentType: 'OPT',
      provider: payload.provider || payload.meta?.provider || 'optionstrat'
    });
    const providerName = resolveOrderProviderName(order);
    try {
      const adapter = getAdapter(providerName);
      wireAdapter(adapter, providerName);
      if (typeof adapter?.estimateOrder !== 'function') {
        return { status: 'unsupported', provider: providerName };
      }
      return await adapter.estimateOrder(order);
    } catch (err) {
      return { status: 'rejected', provider: providerName, reason: err?.message || String(err) };
    }
  });

  ipcMain.handle('optionstrat:valuation', async (_evt, payload = {}) => {
    const providerName = payload.provider || payload.meta?.provider || 'optionstrat';
    const ticket = typeof payload.ticket === 'string' ? payload.ticket : String(payload.ticket || '');
    const symbol = typeof payload.symbol === 'string' ? payload.symbol : (payload.symbol == null ? undefined : String(payload.symbol));
    if (!ticket) return { status: 'error', provider: providerName, reason: 'ticket required' };
    try {
      const adapter = getAdapter(providerName);
      wireAdapter(adapter, providerName);
      if (typeof adapter?.getStrategyValuation !== 'function') {
        return { status: 'unsupported', provider: providerName };
      }
      return await adapter.getStrategyValuation(ticket, symbol);
    } catch (err) {
      return { status: 'error', provider: providerName, reason: err?.message || String(err) };
    }
  });

  ipcMain.handle('instrument:get', async (_evt, arg) => {
    try {
      const symbol = typeof arg === 'object' ? arg.symbol : arg;
      const provider = typeof arg === 'object' ? arg.provider : undefined;
      const instrumentType = detectInstrumentType(String(symbol || ''));
      const providerName = resolveProviderName({ provider, payload: typeof arg === 'object' ? arg : {}, symbol, instrumentType });
      return await instrumentInfo.get({ provider: providerName, symbol, instrumentType, payload: typeof arg === 'object' ? arg : {} });
    } catch {
      return null;
    }
  });

  ipcMain.handle('instrument:forget', async (_evt, arg) => {
    try {
      const symbol = typeof arg === 'object' ? arg.symbol : arg;
      const provider = typeof arg === 'object' ? arg.provider : undefined;
      const instrumentType = detectInstrumentType(String(symbol || ''));
      const providerName = resolveProviderName({ provider, payload: typeof arg === 'object' ? arg : {}, symbol, instrumentType });
      return await instrumentInfo.forget({ provider: providerName, symbol, instrumentType, payload: typeof arg === 'object' ? arg : {} });
    } catch {
      return false;
    }
  });

  // --- IPC: orders:list (tail JSONL файлов, совместим с старым вызовом) ---
  ipcMain.handle('orders:list', async (_evt, arg) => {
    // Совместимость: могут передать число (rows) или объект {file, rows}
    let file = 'webhooks';
    let rows = 100;
    if (typeof arg === 'number') {
      rows = arg;
    } else if (arg && typeof arg === 'object') {
      file = arg.file || file;
      rows = arg.rows || rows;
    }

    if (file === 'webhooks') {
      return orderSvc.getOrdersList(rows);
    }
    if (file === 'executions') {
      // Читаем весь файл (объёмы небольшие); при росте — заменить на tail по байтам
      let text = '';
      try {
        text = fs.readFileSync(EXEC_LOG, 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }

      const lines = text.split('\n').filter(Boolean);
      const tail = lines.slice(-Math.max(1, rows));
      const result = [];
      for (const l of tail) {
        try {
          const rec = JSON.parse(l);
          result.push(rec);
        } catch {
          // skip bad line
        }
      }
      return result;
    }

    throw new Error(`Unknown file alias: ${file}`);
  });
}
