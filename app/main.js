// app/main.js
// Electron main: Express(3210) + JSONL logs + IPC "queue-place-order" + execution adapters via the brokerage service

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.resolve(__dirname, '..','.env') });

const servicesApi = require('./services/servicesApi');
const { detectInstrumentType } = require('./services/instruments');
const events = require('./services/events');
const { createPendingOrderHub, registerPendingOrdersIpcHandlers } = require('./services/pendingOrders');
const tradeRules = servicesApi.tradeRules || require('./services/tradeRules');
const loadConfig = require('./config/load');
const orderCalc = servicesApi.orderCalculator || require('./services/orderCalculator');
const { GroupedOrderLifecycleRegistry } = require('./services/brokerage/comps/groupedOrderLifecycle');
const {
  createAdapterLifecycleBridge,
  createExecutionApplicationService,
  createProviderResolution
} = require('./application/execution');
const { registerExecutionIpcHandlers } = require('./infrastructure/execution');
const {
  createPositionsChangedPublisher,
  registerPositionsIpcHandlers
} = require('./infrastructure/positions');
const {
  registerWindowStateIpcHandlers
} = require('./infrastructure/electron');
const {
  registerMainApplicationServicesForManifests
} = require('./services/serviceMainRegistration');
let uiCfg = loadConfig('../services/ui/config/ui.json');

function loadServices(servicesApi = {}) {
  let dirs = [];
  const manifests = [];
  try {
    dirs = loadConfig('../services/settings/config/services.json');
  } catch {
    dirs = [];
  }
  if (!Array.isArray(dirs)) return manifests;
  for (const dir of dirs) {
    try {
      const manifest = require(path.join(__dirname, dir, 'manifest.js'));
      manifests.push({ dir, manifest });
      if (typeof manifest?.initService === 'function') {
        manifest.initService(servicesApi);
      }
    } catch (err) {
      console.error('[serviceLoader] Failed to load', dir, err);
    }
  }
  return manifests;
}

const serviceManifests = loadServices(servicesApi);
function registerServiceMainApplicationServices(context = {}) {
  registerMainApplicationServicesForManifests(serviceManifests, context, (err, dir) => {
    console.error('[serviceLoader] Failed to register application services for', dir, err);
  });
}
function registerServiceMainIpcHandlers(context = {}) {
  for (const { dir, manifest } of serviceManifests) {
    if (typeof manifest?.registerMainIpcHandlers !== 'function') continue;
    try {
      manifest.registerMainIpcHandlers({ ...context, serviceDir: dir });
    } catch (err) {
      console.error('[serviceLoader] Failed to register IPC handlers for', dir, err);
    }
  }
}
const { getAdapter, resolveProvider } = servicesApi.brokerage || {};
const instrumentInfo = servicesApi.instrumentInfo;
const providerResolution = createProviderResolution({ resolveProvider });
const { resolveProviderName } = providerResolution;

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
const groupedOrderLifecycles = new GroupedOrderLifecycleRegistry();

function appendJsonl(file, obj) {
  try { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); }
  catch (e) { console.error('appendJsonl error:', e); }
}
const nowTs = () => Date.now();
function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

const adapterLifecycleBridge = createAdapterLifecycleBridge({
  servicesApi,
  events,
  appendJsonl,
  execLog: EXEC_LOG,
  nowTs,
  getMainWindow: () => mainWindow,
  wiredAdapters,
  pendingIndex,
  trackerPending,
  trackerIndex,
  confirmedOrderByTicket,
  confirmedOrderByCid,
  groupedOrderLifecycles,
  cardControllers: servicesApi.executionCardControllers
});

function wireAdapter(adapter, providerName) {
  return adapterLifecycleBridge.wireAdapter(adapter, providerName);
}

// ----------------- Electron window -----------------
let mainWindow;
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

registerWindowStateIpcHandlers({
  ipcMain,
  getWindowStateSnapshot,
  setWindowState
});

app.whenReady().then(() => {
  ensureLogs({ truncateExecutionsOnStart: true });

  registerServiceMainApplicationServices({
    servicesApi,
    positions: servicesApi.positions,
    resolveProviderName,
    sendToRenderer,
    nowTs,
    logDir: LOG_DIR,
    defaultWebhookPort: PORT,
    phase: 'before-window'
  });

  createWindow();
  setupIpc();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
});

function setupIpc() {
  const executionService = createExecutionApplicationService({
    getAdapter,
    wireAdapter,
    instrumentInfo,
    orderCalc,
    tradeRules,
    events,
    positions: servicesApi.positions,
    appendJsonl,
    execLog: EXEC_LOG,
    nowTs,
    sendToRenderer,
    trackerPending,
    trackerIndex,
    pendingIndex,
    resolveOrderProviderName: providerResolution.resolveOrderProviderName,
    resolveProviderName: providerResolution.resolveProviderName,
    providerCanResolveRiskQty: providerResolution.providerCanResolveRiskQty,
    cardControllers: servicesApi.executionCardControllers,
    orderPayloadPolicies: servicesApi.executionPayloadPolicies
  });

  servicesApi.execution = {
    queuePlaceOrder: (payload) => executionService.queuePlaceOrder(payload),
    pickProviderName: (instrumentType) => executionService.pickProviderName(instrumentType)
  };

  registerServiceMainApplicationServices({
    servicesApi,
    getAdapter,
    wireAdapter,
    instrumentInfo,
    orderCalc,
    appendJsonl,
    execLog: EXEC_LOG,
    nowTs,
    sendToRenderer,
    resolveProviderName: providerResolution.resolveProviderName,
    executionService,
    pendingIndex,
    trackerPending,
    groupedOrderLifecycles,
    phase: 'after-execution'
  });

  const pendingHub = createPendingOrderHub({
    subscribe: (provider, symbols) => {
      const adapter = getAdapter(provider);
      try { adapter.client?.subscribe_symbols_bar_data(symbols.map(s => [s, 'M1'])); } catch {}
    },
    queuePlaceOrder: (payload) => executionService.queuePlaceOrder(payload),
    wireAdapter,
    mainWindow,
    instrumentInfo
  });
  servicesApi.settings?.onApply?.('pending-strategies', ({ config }) => pendingHub.configureStrategies(config));
  registerPendingOrdersIpcHandlers({
    ipcMain,
    pendingHub,
    queuePlaceOrder: (payload) => executionService.queuePlaceOrder(payload)
  });

  registerServiceMainIpcHandlers({
    ipcMain,
    servicesApi
  });

  registerExecutionIpcHandlers({
    ipcMain,
    getAdapter,
    wireAdapter,
    appendJsonl,
    execLog: EXEC_LOG,
    nowTs,
    events,
    closeControllers: servicesApi.executionCloseControllers,
    instrumentInfo,
    detectInstrumentType,
    resolveProviderName: providerResolution.resolveProviderName
  });
  registerPositionsIpcHandlers({
    ipcMain,
    positionsService: servicesApi.positions
  });
  createPositionsChangedPublisher({
    positionsService: servicesApi.positions,
    getMainWindow: () => mainWindow
  });
}
