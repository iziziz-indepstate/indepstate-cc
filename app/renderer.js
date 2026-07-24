// renderer.js — crypto & equities cards, stable UI state, safe layout
const {ipcRenderer} = require('electron');
const path = require('path');
const loadConfig = require('./config/load');
const settingsRuntime = require('./services/settings');
const servicesApi = require('./services/servicesApi');
const tradeRules = servicesApi.tradeRules || require('./services/tradeRules');
const {detectInstrumentType} = require("./services/instruments");
const { buildOptionStratHedgePayload } = require('./services/optionstrat/hedge');
const {findTickSizeOverride, getDefaultTickSize} = require('./services/instrumentInfo/points');
const orderCalc = servicesApi.orderCalculator || require('./services/orderCalculator');
const { resolveLevelOrderDefaults, normalizePriceSource, resolveQuotePrice } = require('./services/levelOrder/strategy');
let orderCardsCfg = loadConfig('../services/orderCards/config/order-cards.json');
let levelOrderCfg = loadConfig('../services/levelOrder/config/level-order.json');

let SHOW_BID_ASK = !!(orderCardsCfg && orderCardsCfg.showBidAsk);
let SHOW_SPREAD = !!(orderCardsCfg && orderCardsCfg.showSpread);


const envInstrRefresh = Number(process.env.INSTRUMENT_REFRESH_MS);
let INSTRUMENT_REFRESH_MS = Number.isFinite(envInstrRefresh)
  ? envInstrRefresh
  : Number(orderCardsCfg?.instrumentRefreshMs) || 1000;
let optionStratValuationRefreshMs = 5000;
const DEFAULT_OPTIONSTRAT_DISPLAY_FIELDS = {
  pl: true,
  value: true,
  maxLoss: true,
  maxProfit: true,
  change: true,
  rr: true
};
let optionStratDisplayFields = {...DEFAULT_OPTIONSTRAT_DISPLAY_FIELDS};

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
  if (Number.isFinite(ms) && ms > 0) optionStratValuationRefreshMs = ms;
  optionStratDisplayFields = normalizeOptionStratDisplayFields(cfg.displayFields);
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

// Short labels for pending execution orders
const pendingExecLabels = new Map(); // key -> label

// --- pending заявки по requestId ---
const pendingByReqId = new Map();
const pendingIdByReqId = new Map();
const ticketToKey = new Map(); // ticket -> rowKey
const levelOrderGroups = new Map(); // parent requestId -> grouped child state
const levelOrderChildToGroup = new Map(); // child requestId -> parent requestId
const levelOrderPendingToGroup = new Map(); // adapter pendingId/cid -> parent requestId
const levelOrderTicketToGroup = new Map(); // provider ticket -> parent requestId
const placedOrderByKey = new Map(); // rowKey -> { provider, ticket, symbol }
const retryCounts = new Map(); // reqId -> retry count
const instantExecutedKeys = new Set();

// --- пользователь вручную менял поля карточки для этого тикера?
const userTouchedByTicker = new Map(); // ticker -> boolean

// котировки по тикерам
const instrumentInfo = new Map(); // provider:symbol -> flattened instrument snapshot for UI use
function instrumentInfoKey(ticker, provider) {
  return `${String(provider || '').trim().toLowerCase()}:${String(ticker || '').trim().toUpperCase()}`;
}
function instrumentInfoFor(ticker, rowOrProvider) {
  const provider = typeof rowOrProvider === 'object' ? rowOrProvider?.provider : rowOrProvider;
  const inferredProvider = provider || state.rows.find(row => row.ticker === ticker)?.provider;
  return instrumentInfo.get(instrumentInfoKey(ticker, inferredProvider)) || instrumentInfo.get(ticker);
}
function flattenInstrumentSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (!snapshot.quote && !snapshot.metadata) return { ...snapshot, snapshot };
  return {
    ...(snapshot.quote || {}),
    ...(snapshot.metadata || {}),
    provider: snapshot.provider,
    symbol: snapshot.symbol,
    instrumentType: snapshot.instrumentType,
    sources: snapshot.sources || {},
    quoteUpdatedAt: snapshot.quoteUpdatedAt,
    metadataUpdatedAt: snapshot.metadataUpdatedAt,
    snapshot
  };
}
// історія спредів у пунктах: ticker -> number[] (trim до 100)
const spreadHistory = new Map();

// ======= DOM =======
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
const settingsForms = new Map();
const DESCRIPTOR_META_KEYS = new Set(['description', 'type', 'item', 'default', 'enum']);

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

function renderRestartStatus(status = []) {
  if (!$settingsRestart) return;
  const entries = Array.isArray(status) ? status : [];
  if (!entries.length) {
    $settingsRestart.style.display = 'none';
    $settingsRestart.textContent = '';
    $settingsBtn.classList.remove('settings-restart-required');
    $settingsBtn.title = 'Settings';
    return;
  }
  $settingsRestart.textContent = `Restart required: ${entries.map(entry => `${entry.section} (${(entry.paths || []).join(', ')})`).join('; ')}`;
  $settingsRestart.style.display = 'block';
  $settingsBtn.classList.add('settings-restart-required');
  $settingsBtn.title = $settingsRestart.textContent;
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
  if (Number.isFinite(ms) && ms > 0) optionStratValuationRefreshMs = ms;
  optionStratDisplayFields = normalizeOptionStratDisplayFields(config?.displayFields);
  render();
});

ipcRenderer.on('settings:changed', async (_event, result) => {
  if (!result?.saved) return;
  const local = await settingsRuntime.applyConfig(result.section, result.config, result.appliedPaths || [], { source: 'settings-ui-renderer' });
  const failedPaths = new Set(local.restartRequiredPaths || []);
  settingsRuntime.commitAppliedConfig(
    result.section,
    result.config,
    (result.appliedPaths || []).filter(pathName => !failedPaths.has(pathName))
  );
  if (local.errors.length) {
    await ipcRenderer.invoke('settings:renderer-failed', result.section, result.appliedPaths || [], local.errors.join('; ')).catch(() => {});
  }
  ipcRenderer.invoke('settings:restart-status').then(renderRestartStatus).catch(() => {});
});
ipcRenderer.invoke('settings:restart-status').then(renderRestartStatus).catch(() => {});

function loadRendererHooks() {
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
      if (typeof manifest?.hookRenderer === 'function') {
        manifest.hookRenderer(ipcRenderer);
      }
    } catch (err) {
      console.error('[rendererServiceLoader] Failed to load', dir, err.message);
    }
  }
}

function loadSettingsSections() {
  settingsForms.clear();
  ipcRenderer.invoke('settings:restart-status').then(renderRestartStatus).catch(() => {});
  ipcRenderer.invoke('settings:list').then((sections = []) => {
    $settingsSections.innerHTML = '';
    let prevGroup;
    sections.forEach((s, idx) => {
      if (idx > 0 && (s.group !== prevGroup || idx === 3)) {
        const hr = document.createElement('hr');
        $settingsSections.appendChild(hr);
      }
      prevGroup = s.group;
      const div = document.createElement('div');
      div.textContent = s.name;
      div.dataset.section = s.key;
      div.addEventListener('click', () => showSection(s.key));
      $settingsSections.appendChild(div);
    });
    if (sections[0]) showSection(sections[0].key);
  }).catch(() => {
  });
}

function setNestedSettingValue(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const nextIsIndex = /^\d+$/.test(parts[i + 1]);
    if (nextIsIndex) {
      if (!Array.isArray(cur[part])) cur[part] = [];
    } else if (typeof cur[part] !== 'object' || cur[part] === null || Array.isArray(cur[part])) {
      cur[part] = {};
    }
    cur = cur[part];
  }
  const last = parts[parts.length - 1];
  if (/^\d+$/.test(last)) cur[Number(last)] = value;
  else cur[last] = value;
}

function getNestedSettingValue(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((value, part) => value == null ? undefined : value[part], obj);
}

function deleteNestedSettingValue(obj, path) {
  const parts = String(path || '').split('.').filter(Boolean);
  if (!parts.length) return;
  const parent = parts.slice(0, -1)
    .reduce((value, part) => value == null ? undefined : value[part], obj);
  if (parent && typeof parent === 'object') delete parent[parts.at(-1)];
}

function cloneSettingsValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function serializeStructuredSettingsForm(form, name) {
  const data = {};
  for (const input of form.querySelectorAll('input')) {
    const key = input.dataset.field;
    if (!key) continue;
    if (key.split('.').some(part => part.startsWith('__'))) continue;
    let value;
    if (input.dataset.arrayMarker === '1') value = [];
    else if (input.type === 'checkbox') value = input.checked;
    else if (input.type === 'number') value = input.value === '' ? null : Number(input.value);
    else value = input.value;
    setNestedSettingValue(data, key, value);
  }
  for (const group of form.querySelectorAll('.settings-dynamic-map[data-setting-path]')) {
    const values = {};
    const valueRole = group.dataset.valueRole || 'value';
    for (const row of group.querySelectorAll('.settings-dynamic-map-row')) {
      const symbol = row.querySelector('input[data-role="symbol"]')?.value.trim();
      const value = Number(row.querySelector(`input[data-role="${valueRole}"]`)?.value);
      if (symbol && Number.isFinite(value) && value > 0) values[symbol] = value;
    }
    setNestedSettingValue(data, group.dataset.settingPath, values);
  }
  return data;
}

function setRawSettingsError(form, message = '') {
  const error = form.querySelector('[data-role="raw-json-error"]');
  if (!error) return;
  error.textContent = message;
  error.style.display = message ? 'block' : 'none';
}

function parseRawSettingsForm(form) {
  const editor = form.querySelector('textarea[data-role="raw-json"]');
  if (!editor) return serializeStructuredSettingsForm(form, form.dataset.section);
  try {
    const config = JSON.parse(editor.value);
    if (form.dataset.rawEditorType === 'array' && !Array.isArray(config)) {
      throw new Error('Configuration must be a JSON array');
    }
    if (form.dataset.rawEditorType !== 'array' && (!config || typeof config !== 'object' || Array.isArray(config))) {
      throw new Error('Configuration must be a JSON object');
    }
    setRawSettingsError(form);
    return config;
  } catch (error) {
    setRawSettingsError(form, error?.message || String(error));
    throw error;
  }
}

function serializeSettingsForm(form, name) {
  if (form.dataset.editorMode !== 'json') return serializeStructuredSettingsForm(form, name);
  const rawConfig = parseRawSettingsForm(form);
  const rawPath = form.dataset.rawEditorPath || '';
  if (!rawPath) return rawConfig;
  const config = serializeStructuredSettingsForm(form, name);
  setNestedSettingValue(config, rawPath, rawConfig);
  return config;
}

function getSettingsInput(form, field) {
  return form.querySelector(`input[data-field="${field}"]`);
}

function setSettingsInputValue(form, field, value) {
  const input = getSettingsInput(form, field);
  if (!input) return;
  input.value = value == null ? '' : String(value);
  form.dataset.dirty = '1';
}

function formatWindowState(state) {
  const value = (key) => Number.isFinite(state?.[key]) ? String(Math.trunc(state[key])) : '-';
  return `width ${value('width')} / height ${value('height')} / x ${value('x')} / y ${value('y')}`;
}

function appendUiWindowStateTools(form, parent = form) {
  const group = document.createElement('div');
  group.className = 'settings-group settings-window-state';

  const title = document.createElement('div');
  title.className = 'settings-group-title';
  title.textContent = 'Current window';
  group.appendChild(title);

  const current = document.createElement('div');
  current.className = 'settings-window-state-current';
  current.textContent = 'width - / height - / x - / y -';
  group.appendChild(current);

  const actions = document.createElement('div');
  actions.className = 'settings-window-state-actions';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.textContent = 'Refresh';
  actions.appendChild(refreshBtn);

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.textContent = 'Use current window';
  actions.appendChild(applyBtn);

  group.appendChild(actions);
  parent.insertBefore(group, parent.firstChild);

  let lastState = null;
  const refresh = () => ipcRenderer.invoke('window:get-state')
    .then((state = {}) => {
      lastState = state;
      current.textContent = formatWindowState(state);
      return state;
    })
    .catch(() => null);

  refreshBtn.addEventListener('click', refresh);
  applyBtn.addEventListener('click', () => {
    const apply = (state) => {
      if (!state) return;
      for (const field of ['width', 'height', 'x', 'y']) {
        if (Number.isFinite(state[field])) setSettingsInputValue(form, field, Math.trunc(state[field]));
      }
    };
    if (lastState) {
      apply(lastState);
      return;
    }
    refresh().then(apply);
  });

  refresh();
}

function appendNumericSymbolMapTools(form, {
  path,
  title,
  values = {},
  valuePlaceholder,
  valueRole = 'value',
  rowClass = '',
  addLabel = 'Add symbol override',
  onChange
} = {}, parent = form) {
  const group = document.createElement('div');
  group.className = 'settings-group settings-dynamic-map';
  group.dataset.settingPath = path;
  group.dataset.valueRole = valueRole;

  const titleElement = document.createElement('div');
  titleElement.className = 'settings-group-title';
  titleElement.textContent = title;
  group.appendChild(titleElement);

  const rows = document.createElement('div');
  rows.className = 'settings-dynamic-map-rows';
  group.appendChild(rows);

  const markDirty = () => {
    form.dataset.dirty = '1';
    onChange?.();
  };
  const addRow = (symbol = '', numericValue = '') => {
    const row = document.createElement('div');
    row.className = `settings-dynamic-map-row ${rowClass}`.trim();
    row.style.display = 'grid';
    row.style.gridTemplateColumns = '1fr 110px auto';
    row.style.gap = '8px';
    row.style.alignItems = 'center';
    row.style.marginBottom = '8px';

    const symbolInput = document.createElement('input');
    symbolInput.type = 'text';
    symbolInput.placeholder = 'SYMBOL';
    symbolInput.value = symbol;
    symbolInput.dataset.role = 'symbol';
    symbolInput.addEventListener('input', markDirty);
    row.appendChild(symbolInput);

    const valueInput = document.createElement('input');
    valueInput.type = 'number';
    valueInput.step = 'any';
    valueInput.placeholder = valuePlaceholder;
    valueInput.value = numericValue == null ? '' : String(numericValue);
    valueInput.dataset.role = valueRole;
    valueInput.addEventListener('input', markDirty);
    row.appendChild(valueInput);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.className = 'settings-array-remove';
    remove.addEventListener('click', () => {
      row.remove();
      markDirty();
    });
    row.appendChild(remove);
    rows.appendChild(row);
  };

  Object.entries(values || {}).forEach(([symbol, value]) => addRow(symbol, value));

  const add = document.createElement('button');
  add.type = 'button';
  add.textContent = addLabel;
  add.className = 'settings-array-add';
  add.addEventListener('click', () => {
    addRow('', '');
    markDirty();
  });
  group.appendChild(add);
  parent.appendChild(group);
}

function numericSymbolMapSpecs(name, config = {}) {
  if (name === 'tick-sizes') {
    return [{
      path: 'bySymbol',
      title: 'Tick size overrides by symbol',
      values: config.bySymbol || {},
      valuePlaceholder: 'Tick size',
      valueRole: 'tickSize',
      rowClass: 'tick-size-symbol-row'
    }];
  }
  if (name === 'order-calculator') {
    return [{
      path: 'riskUsd.bySymbol',
      title: 'Default risk overrides by symbol',
      values: config.riskUsd?.bySymbol || {},
      valuePlaceholder: 'Risk $',
      valueRole: 'riskUsd',
      rowClass: 'risk-symbol-row'
    }];
  }
  return [];
}

function showSection(name) {
  [...$settingsSections.querySelectorAll('div[data-section]')].forEach(d => {
    d.classList.toggle('active', d.dataset.section === name);
  });
  const existing = settingsForms.get(name);
  if (existing) {
    $settingsFields.innerHTML = '';
    $settingsFields.appendChild(existing);
    return;
  }
  ipcRenderer.invoke('settings:get', name).then((res = {}) => {
    const cfg = res.config || res;
    const descriptorProperties = (res.descriptor && res.descriptor.properties) || {};
    const rawEditorDescriptor = descriptorProperties.rawEditor === true
      ? {}
      : (descriptorProperties.rawEditor && typeof descriptorProperties.rawEditor === 'object'
          ? descriptorProperties.rawEditor
          : null);
    const desc = cloneSettingsValue((res.descriptor && res.descriptor.options) || {});
    const dynamicMapPaths = numericSymbolMapSpecs(name, cfg).map(spec => spec.path);
    dynamicMapPaths.forEach(mapPath => deleteNestedSettingValue(desc, mapPath));
    const form = document.createElement('form');
    form.dataset.section = name;
    form.dataset.editorMode = 'form';
    const structuredEditor = document.createElement('div');
    structuredEditor.className = 'settings-structured-editor';
    form.appendChild(structuredEditor);
    let structuredEditorChanged = false;
    let structuredConfigValue = cfg;
    const markStructuredDirty = () => {
      structuredEditorChanged = true;
      form.dataset.dirty = '1';
    };
    const hasOwn = Object.prototype.hasOwnProperty;
    const getDefault = (d) => (d && hasOwn.call(d, 'default') ? d.default : undefined);
    const build = (parent, cfgObj, descObj, prefix = '') => {
      const hasItemDesc = !!(descObj && typeof descObj === 'object' && !Array.isArray(descObj) && descObj.item);
      if (Array.isArray(cfgObj) || Array.isArray(descObj) || hasItemDesc) {
        const arr = Array.isArray(cfgObj) ? cfgObj : [];
        const itemDesc = Array.isArray(descObj)
          ? descObj[0]
          : hasItemDesc
            ? descObj.item
            : (descObj && descObj.item) || {};
        const itemsWrap = document.createElement('div');
        const baseParts = prefix ? prefix.split('.') : [];
        const itemIsObjDesc = itemDesc && typeof itemDesc === 'object' && !itemDesc.type && Object.keys(itemDesc).length;
        if (prefix) {
          const marker = document.createElement('input');
          marker.type = 'hidden';
          marker.dataset.field = prefix;
          marker.dataset.arrayMarker = '1';
          marker.value = '';
          parent.appendChild(marker);
        }
        const renderItem = (val, idx) => {
          const d = itemDesc;
          const defaultVal = getDefault(d);
          const effectiveVal = val !== undefined ? val : defaultVal;
          const isObj = (effectiveVal && typeof effectiveVal === 'object' && !Array.isArray(effectiveVal)) || itemIsObjDesc;
          const path = prefix ? `${prefix}.${idx}` : String(idx);
          if (isObj) {
            const group = document.createElement('div');
            group.className = 'settings-group';
            const head = document.createElement('div');
            head.style.display = 'flex';
            head.style.alignItems = 'center';
            const title = document.createElement('div');
            title.className = 'settings-group-title';
            title.textContent = (d && d.description) || String(idx);
            head.appendChild(title);
            const rm = document.createElement('button');
            rm.type = 'button';
            rm.textContent = '×';
            rm.className = 'settings-array-remove';
            rm.addEventListener('click', () => {
              itemsWrap.removeChild(group);
              reindex();
              markStructuredDirty();
            });
            head.appendChild(rm);
            group.appendChild(head);
            const nested = effectiveVal && typeof effectiveVal === 'object' ? effectiveVal : {};
            build(group, nested, d || {}, path);
            itemsWrap.appendChild(group);
          } else {
            const label = document.createElement('label');
            const span = document.createElement('span');
            span.textContent = (d && d.description) || String(idx);
            label.appendChild(span);
            let input;
            const type = (d && d.type) || typeof effectiveVal;
            if (type === 'boolean') {
              input = document.createElement('input');
              input.type = 'checkbox';
              if (val !== undefined) input.checked = !!val;
              else if (defaultVal !== undefined) input.checked = !!defaultVal;
              else input.checked = false;
            } else if (type === 'number') {
              input = document.createElement('input');
              input.type = 'number';
              const initial = val !== undefined ? val : defaultVal;
              input.value = initial ?? '';
            } else {
              input = document.createElement('input');
              input.type = 'text';
              const initial = val !== undefined ? val : defaultVal;
              input.value = initial ?? '';
            }
            input.dataset.field = path;
            input.addEventListener('input', () => {
              markStructuredDirty();
            });
            input.addEventListener('change', () => {
              markStructuredDirty();
            });
            label.appendChild(input);
            const rm = document.createElement('button');
            rm.type = 'button';
            rm.textContent = '×';
            rm.className = 'settings-array-remove';
            rm.addEventListener('click', () => {
              itemsWrap.removeChild(label);
              reindex();
              markStructuredDirty();
            });
            label.appendChild(rm);
            itemsWrap.appendChild(label);
          }
        };
        const reindex = () => {
          Array.from(itemsWrap.children).forEach((child, i) => {
            for (const input of child.querySelectorAll('input')) {
              const parts = input.dataset.field.split('.');
              parts[baseParts.length] = String(i);
              input.dataset.field = parts.join('.');
            }
            const t = child.querySelector('.settings-group-title');
            if (t && !(itemDesc && itemDesc.description)) t.textContent = String(i);
          });
        };
        arr.forEach((val, idx) => renderItem(val, idx));
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.textContent = '+';
        addBtn.className = 'settings-array-add';
        addBtn.addEventListener('click', () => {
          let v;
          const defaultVal = getDefault(itemDesc);
          if (itemIsObjDesc) v = {};
          else if (defaultVal !== undefined) v = defaultVal;
          else if (itemDesc && itemDesc.type === 'number') v = 0;
          else if (itemDesc && itemDesc.type === 'boolean') v = false;
          else v = '';
          renderItem(v, itemsWrap.children.length);
          markStructuredDirty();
        });
        parent.appendChild(itemsWrap);
        parent.appendChild(addBtn);
        return;
      }
      const keys = new Set([
        ...Object.keys(cfgObj || {}),
        ...Object.keys(descObj || {})
      ]);
      for (const key of keys) {
        const hasValue = cfgObj && hasOwn.call(cfgObj, key);
        if (String(key).startsWith('__')) continue;
        if (!hasValue && DESCRIPTOR_META_KEYS.has(key)) continue;
        const val = hasValue ? cfgObj[key] : undefined;
        const d = descObj ? descObj[key] : undefined;
        const defaultVal = getDefault(d);
        const effectiveVal = hasValue ? val : defaultVal;
        const isObj = (effectiveVal && typeof effectiveVal === 'object' && !Array.isArray(effectiveVal)) ||
          (d && typeof d === 'object' && !d.type);
        if (isObj) {
          const group = document.createElement('div');
          group.className = 'settings-group';
          const title = document.createElement('div');
          title.className = 'settings-group-title';
          title.textContent = (d && d.description) || key;
          group.appendChild(title);
          const nested = effectiveVal && typeof effectiveVal === 'object' ? effectiveVal : {};
          build(group, nested, d || {}, prefix ? `${prefix}.${key}` : key);
          parent.appendChild(group);
        } else {
          const label = document.createElement('label');
          const span = document.createElement('span');
          span.textContent = (d && d.description) || key;
          label.appendChild(span);
          let input;
          const type = (d && d.type) || typeof effectiveVal;
          if (type === 'boolean') {
            input = document.createElement('input');
            input.type = 'checkbox';
            if (hasValue) input.checked = !!val;
            else if (defaultVal !== undefined) input.checked = !!defaultVal;
            else input.checked = false;
          } else if (type === 'number') {
            input = document.createElement('input');
            input.type = 'number';
            const initial = hasValue ? val : defaultVal;
            input.value = initial ?? '';
          } else {
            input = document.createElement('input');
            input.type = 'text';
            const initial = hasValue ? val : defaultVal;
            input.value = initial ?? '';
          }
          const path = prefix ? `${prefix}.${key}` : key;
          input.dataset.field = path;
          input.addEventListener('input', () => {
            markStructuredDirty();
          });
          input.addEventListener('change', () => {
            markStructuredDirty();
          });
          label.appendChild(input);
          parent.appendChild(label);
        }
      }
    };
    const renderStructuredEditor = (config) => {
      structuredEditor.innerHTML = '';
      const structuredConfig = cloneSettingsValue(config) || {};
      const dynamicMapSpecs = numericSymbolMapSpecs(name, config);
      dynamicMapSpecs.forEach(spec => deleteNestedSettingValue(structuredConfig, spec.path));
      build(structuredEditor, structuredConfig, desc);
      if (name === 'ui') appendUiWindowStateTools(form, structuredEditor);
      dynamicMapSpecs.forEach(spec => {
        appendNumericSymbolMapTools(form, { ...spec, onChange: markStructuredDirty }, structuredEditor);
      });
      structuredConfigValue = config;
      structuredEditorChanged = false;
    };
    renderStructuredEditor(cfg);

    if (rawEditorDescriptor) {
      const rawEditorPath = String(rawEditorDescriptor.path || '');
      const initialRawValue = getNestedSettingValue(cfg, rawEditorPath);
      const rawEditorType = rawEditorDescriptor.type || (Array.isArray(initialRawValue) ? 'array' : 'object');
      form.dataset.rawEditorPath = rawEditorPath;
      form.dataset.rawEditorType = rawEditorType;
      const controls = document.createElement('div');
      controls.className = 'settings-editor-controls';
      const formButton = document.createElement('button');
      formButton.type = 'button';
      formButton.textContent = 'Form';
      formButton.dataset.editorMode = 'form';
      formButton.className = 'active';
      const jsonButton = document.createElement('button');
      jsonButton.type = 'button';
      jsonButton.textContent = rawEditorDescriptor.label || (rawEditorPath ? `${rawEditorPath} JSON` : 'JSON');
      jsonButton.dataset.editorMode = 'json';
      controls.append(formButton, jsonButton);
      form.insertBefore(controls, structuredEditor);

      const rawEditor = document.createElement('div');
      rawEditor.className = 'settings-raw-editor';
      rawEditor.hidden = true;
      const textarea = document.createElement('textarea');
      textarea.dataset.role = 'raw-json';
      textarea.spellcheck = false;
      textarea.setAttribute('aria-label', `${descriptorProperties.name || name} JSON configuration`);
      const error = document.createElement('div');
      error.className = 'settings-raw-error';
      error.dataset.role = 'raw-json-error';
      error.style.display = 'none';
      rawEditor.append(textarea, error);

      if (rawEditorDescriptor.snippets === true && rawEditorType === 'array') {
        const snippetToggle = document.createElement('button');
        snippetToggle.type = 'button';
        snippetToggle.className = 'settings-snippet-toggle';
        snippetToggle.textContent = rawEditorDescriptor.snippetLabel || 'Add JSON snippet';
        const snippetPanel = document.createElement('div');
        snippetPanel.className = 'settings-snippet-panel';
        snippetPanel.hidden = true;
        const snippetEditor = document.createElement('textarea');
        snippetEditor.dataset.role = 'raw-json-snippet';
        snippetEditor.spellcheck = false;
        snippetEditor.placeholder = '{ "event": "event-name", "action": "commandLine:command" }';
        const snippetError = document.createElement('div');
        snippetError.className = 'settings-raw-error';
        snippetError.dataset.role = 'raw-json-snippet-error';
        snippetError.style.display = 'none';
        const snippetActions = document.createElement('div');
        snippetActions.className = 'settings-snippet-actions';
        const appendSnippet = document.createElement('button');
        appendSnippet.type = 'button';
        appendSnippet.textContent = 'Append';
        const cancelSnippet = document.createElement('button');
        cancelSnippet.type = 'button';
        cancelSnippet.textContent = 'Cancel';
        snippetActions.append(appendSnippet, cancelSnippet);
        snippetPanel.append(snippetEditor, snippetError, snippetActions);
        rawEditor.append(snippetToggle, snippetPanel);

        const setSnippetError = (message = '') => {
          snippetError.textContent = message;
          snippetError.style.display = message ? 'block' : 'none';
        };
        snippetToggle.addEventListener('click', () => {
          snippetPanel.hidden = false;
          snippetEditor.focus();
        });
        cancelSnippet.addEventListener('click', () => {
          snippetPanel.hidden = true;
          snippetEditor.value = '';
          setSnippetError();
        });
        appendSnippet.addEventListener('click', () => {
          try {
            const current = parseRawSettingsForm(form);
            const parsed = JSON.parse(snippetEditor.value);
            const additions = Array.isArray(parsed) ? parsed : [parsed];
            if (!additions.length || additions.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
              throw new Error('Snippet must be an action object or an array of action objects');
            }
            textarea.value = JSON.stringify([...current, ...additions], null, 2);
            form.dataset.dirty = '1';
            setRawSettingsError(form);
            setSnippetError();
            snippetEditor.value = '';
            snippetPanel.hidden = true;
            textarea.focus();
          } catch (snippetFailure) {
            setSnippetError(snippetFailure?.message || String(snippetFailure));
            snippetEditor.focus();
          }
        });
      }
      form.appendChild(rawEditor);

      const activateMode = (mode) => {
        if (mode === form.dataset.editorMode) return true;
        if (mode === 'json') {
          const config = structuredEditorChanged
            ? serializeStructuredSettingsForm(form, name)
            : structuredConfigValue;
          const rawValue = getNestedSettingValue(config, rawEditorPath);
          textarea.value = JSON.stringify(
            rawValue === undefined ? (rawEditorType === 'array' ? [] : {}) : rawValue,
            null,
            2
          );
        } else {
          let rawValue;
          try {
            rawValue = parseRawSettingsForm(form);
          } catch {
            textarea.focus();
            return false;
          }
          let rawConfig = cloneSettingsValue(structuredEditorChanged
            ? serializeStructuredSettingsForm(form, name)
            : structuredConfigValue);
          if (rawEditorPath) {
            if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) rawConfig = {};
            setNestedSettingValue(rawConfig, rawEditorPath, rawValue);
          }
          else rawConfig = rawValue;
          renderStructuredEditor(rawConfig);
        }
        form.dataset.editorMode = mode;
        structuredEditor.hidden = mode !== 'form';
        rawEditor.hidden = mode !== 'json';
        formButton.classList.toggle('active', mode === 'form');
        jsonButton.classList.toggle('active', mode === 'json');
        if (mode === 'json') textarea.focus();
        return true;
      };

      formButton.addEventListener('click', () => activateMode('form'));
      jsonButton.addEventListener('click', () => activateMode('json'));
      textarea.addEventListener('input', () => {
        form.dataset.dirty = '1';
        try { parseRawSettingsForm(form); } catch {}
      });
    }
    settingsForms.set(name, form);
    $settingsFields.innerHTML = '';
    $settingsFields.appendChild(form);
  }).catch(() => {
  });
}

// ======= Utils =======
function findKeyByTicker(ticker) {
  const idx = state.rows.findIndex(r => r.ticker === ticker);
  return idx >= 0 ? rowKey(state.rows[idx]) : null;
}

function rowKey(row) {
  return `${row.ticker}|${row.event}|${row.time}|${row.price}`;
}

function signedOptionLegQty(leg) {
  const qty = Math.abs(Number(leg?.quantity ?? leg?.qty ?? 0));
  const side = String(leg?.side || '').toLowerCase();
  return side === 'sell' || side === 'short' ? -qty : qty;
}

function formatCurrencyValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(0)}`;
}

function formatPayoffValue(value, infinite) {
  return infinite ? '∞' : formatCurrencyValue(value);
}

function optionPayoffForRow(row) {
  return row?.payoff || row?.estimatedPayoff || row?.meta?.payoff || null;
}

function optionValuationForRow(row) {
  return row?.valuation || row?.optionValuation || row?.meta?.valuation || null;
}

function normalizeOptionStratDisplayFields(fields = {}) {
  const normalized = {...DEFAULT_OPTIONSTRAT_DISPLAY_FIELDS};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return normalized;
  for (const key of Object.keys(normalized)) {
    if (typeof fields[key] === 'boolean') normalized[key] = fields[key];
  }
  return normalized;
}

function coerceTimeValue(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value < 10000000000 ? value * 1000 : value;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10000000000 ? numeric * 1000 : numeric;
  const parsed = new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTradeTime(value) {
  const ms = coerceTimeValue(value);
  if (!ms) return '-';
  const date = new Date(ms);
  return date.toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function markRowOpened(key, timestamp = Date.now()) {
  const row = state.rows.find(r => rowKey(r) === key);
  if (row && row.instrumentType === 'OPT' && !row.openedAt) row.openedAt = timestamp;
  const orderInfo = placedOrderByKey.get(key);
  if (orderInfo && !orderInfo.openedAt) orderInfo.openedAt = timestamp;
}

function markRowClosed(key, timestamp = Date.now()) {
  const row = state.rows.find(r => rowKey(r) === key);
  if (row && row.instrumentType === 'OPT') {
    if (!row.openedAt) row.openedAt = timestamp;
    row.closedAt = timestamp;
  }
  const orderInfo = placedOrderByKey.get(key);
  if (orderInfo) {
    if (!orderInfo.openedAt) orderInfo.openedAt = timestamp;
    orderInfo.closedAt = timestamp;
  }
}

function emitOptionStratButtonEvent(action, row) {
  if (!row || row.instrumentType !== 'OPT') return;
  const { payload } = buildOptionStratHedgePayload(action, row);
  if (!payload.hedgeOpenSide) return;
  ipcRenderer.invoke('optionstrat:button-event', { action, row }).catch((err) => {
    console.warn('[optionstrat hedge]', err?.message || err);
  });
}

function formatPercentValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}${Math.abs(n).toFixed(1)}%`;
}

function optionLegToken(leg) {
  const qty = signedOptionLegQty(leg);
  const absQty = Math.abs(qty);
  const optionCode = String(leg.option || '').toUpperCase().startsWith('P') ? 'P' : 'C';
  return `${qty > 0 ? '+' : '-'}${absQty}${optionCode}${leg.strike}`;
}

function formatRiskReward(payoff) {
  if (!payoff) return '-';
  if (payoff.isMaxLossInfinite) return '-';
  const loss = Number(payoff.maxLoss);
  if (!Number.isFinite(loss) || loss < 0) return '-';
  if (payoff.isMaxProfitInfinite) return '1:∞';
  const profit = Number(payoff.maxProfit);
  if (!Number.isFinite(profit)) return '-';
  if (loss === 0) return profit > 0 ? '1:∞' : '-';
  return `1:${(profit / loss).toFixed(1)}`;
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
        const currentRow = appState.rows.find(r => rowKey(r) === key);
        if (currentRow?.cardType === 'levelOrder') {
          if (!reqId) {
            for (const group of levelOrderGroupsByKey(key)) cancelLevelOrderTerminalOrders(group, currentRow);
          }
          if (reqId) ipcRenderer.invoke('execution:stop-retry', reqId).catch(() => {});
          if (reqId) {
            pendingByReqId.delete(reqId);
            pendingIdByReqId.delete(reqId);
            retryCounts.delete(reqId);
            clearLevelOrderGroup(reqId);
            delete card.dataset.reqId;
          } else {
            clearLevelOrderByKey(key);
          }
          delete card.dataset.pendingId;
          setCardState(key, null);
          render();
          return;
        }
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
    } else {
      status.style.cursor = '';
      status.title = '';
      status.onclick = null;
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

const pendingInstruments = new Set();
const pendingOptionPayoffs = new Set();
const pendingOptionValuations = new Set();

function ensureInstrument(ticker, provider) {
  if (!ticker) return;
  if (!state.rows.some(r => r.ticker === ticker && r.provider === provider)) return; // card removed
  const infoKey = instrumentInfoKey(ticker, provider);
  if (instrumentInfo.has(infoKey)) return; // already have data
  if (pendingInstruments.has(infoKey)) return; // request in-flight
  pendingInstruments.add(infoKey);
  ipcRenderer.invoke('instrument:get', {symbol: ticker, provider}).then(info => {
    if (info) {
      pendingInstruments.delete(infoKey);
      instrumentInfo.set(infoKey, flattenInstrumentSnapshot(info));
      updateSpreadForTicker(ticker);
      render();
    } else {
      setTimeout(() => {
        pendingInstruments.delete(infoKey);
        ensureInstrument(ticker, provider);
      }, 1000);
    }
  }).catch(() => {
    setTimeout(() => {
      pendingInstruments.delete(infoKey);
      ensureInstrument(ticker, provider);
    }, 1000);
  });
}

function forgetInstrument(ticker, provider) {
  if (!ticker) return;
  if (state.rows.some(r => r.ticker === ticker && r.provider === provider)) return;
  const infoKey = instrumentInfoKey(ticker, provider);
  instrumentInfo.delete(infoKey);
  pendingInstruments.delete(infoKey);
  ipcRenderer.invoke('instrument:forget', {symbol: ticker, provider}).catch(() => {
  });
}

function ensureOptionPayoff(row) {
  if (!row || row.instrumentType !== 'OPT') return;
  if (optionPayoffForRow(row)) return;
  const key = rowKey(row);
  if (pendingOptionPayoffs.has(key)) return;
  pendingOptionPayoffs.add(key);
  ipcRenderer.invoke('optionstrat:estimate', {
    instrumentType: 'OPT',
    provider: row.provider || 'optionstrat',
    ticker: row.ticker || row.symbol,
    symbol: row.symbol || row.ticker,
    root: row.root,
    name: row.name,
    description: row.description,
    expirationDte: row.expirationDte || row.expiration,
    isCustomName: row.isCustomName,
    isCashSecured: row.isCashSecured,
    legs: row.legs
  }).then(result => {
    if (result?.status !== 'ok' || !result.payoff) return;
    const current = state.rows.find(r => rowKey(r) === key);
    if (!current) return;
    current.estimatedPayoff = result.estimatedPayoff || result.payoff;
    render();
  }).catch(() => {
  }).finally(() => {
    pendingOptionPayoffs.delete(key);
  });
}

function refreshOptionValuation(key, orderInfo) {
  if (!orderInfo || !orderInfo.ticket || !orderInfo.provider) return Promise.resolve(null);
  if (pendingOptionValuations.has(key)) return Promise.resolve(null);
  pendingOptionValuations.add(key);
  return ipcRenderer.invoke('optionstrat:valuation', {
    provider: orderInfo.provider,
    ticket: orderInfo.ticket,
    symbol: orderInfo.symbol
  }).then(result => {
    if (result?.status !== 'ok' || !result.valuation) return result;
    const current = state.rows.find(r => rowKey(r) === key);
    if (current) {
      current.valuation = result.valuation;
      render();
    }
    const stored = placedOrderByKey.get(key);
    if (stored) stored.valuation = result.valuation;
    return result;
  }).catch(err => {
    return { status: 'error', reason: err?.message || String(err) };
  }).finally(() => {
    pendingOptionValuations.delete(key);
  });
}

(function refreshOptionValuationsPeriodically() {
  setTimeout(async function tick() {
    try {
      const entries = Array.from(placedOrderByKey.entries())
        .filter(([key]) => {
          if (cardStates.get(key) !== 'placed') return false;
          const row = state.rows.find(r => rowKey(r) === key);
          return row?.instrumentType === 'OPT';
        });
      await Promise.all(entries.map(([key, orderInfo]) => refreshOptionValuation(key, orderInfo)));
    } finally {
      setTimeout(tick, Math.max(1000, Number(optionStratValuationRefreshMs) || 5000));
    }
  }, Math.max(1000, Number(optionStratValuationRefreshMs) || 5000));
})();

// Періодичне оновлення інструментної інформації для всіх видимих карток
(function refreshAllInstrumentsPeriodically() {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const instruments = Array.from(new Map((state.rows || [])
        .filter(r => r.ticker)
        .map(r => [instrumentInfoKey(r.ticker, r.provider), { ticker: r.ticker, provider: r.provider }])).values());
      if (!instruments.length) return;

      await Promise.all(instruments.map(async ({ ticker: t, provider }) => {
        const row = state.rows.find(r => r.ticker === t && r.provider === provider);
        if (!row) return; // пропускаємо, якщо картки вже немає
        const infoKey = instrumentInfoKey(t, provider);
        // не дублюємо запит, якщо вже є активний
        if (pendingInstruments.has(infoKey)) return;

        pendingInstruments.add(infoKey);
        try {
          const info = await ipcRenderer.invoke('instrument:get', {symbol: t, provider});
          if (info) {
            const prev = instrumentInfo.get(infoKey);
            instrumentInfo.set(infoKey, flattenInstrumentSnapshot(info));
            updateSpreadForTicker(t);
            revalidateCardsForTicker(t);
          }
        } catch {
          // ігноруємо помилку; наступна ітерація спробує знову
        } finally {
          pendingInstruments.delete(infoKey);
        }
      }));
    } finally {
      running = false;
    }
  }, INSTRUMENT_REFRESH_MS);
})();

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

  for (const group of levelOrderGroups.values()) {
    if (group.key === oldKey) group.key = newKey;
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
  let $levelPointSize = null;
  if (row.cardType === 'levelOrder') {
    $levelPointSize = inputNumber('Pt', 'point-size');
    $levelPointSize.title = 'Point price override';
    Object.assign($levelPointSize.style, {
      width: '58px',
      height: '20px',
      padding: '2px 5px',
      fontSize: '11px',
      borderRadius: '5px'
    });
    left.appendChild($levelPointSize);
  }
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
      body = row.cardType === 'levelOrder' ? createLevelOrderBody(row, key, $levelPointSize) : createEquitiesBody(row, key);
      break;
    case 'FX':
      body = row.cardType === 'levelOrder' ? createLevelOrderBody(row, key, $levelPointSize) : createFxBody(row, key);
      break;
    case 'CX':
      body = row.cardType === 'levelOrder' ? createLevelOrderBody(row, key, $levelPointSize) : createCryptoBody(row, key);
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
      const v = row.cardType === 'levelOrder' ? body.validate(kind) : body.validate();
      if (!v.valid) return;
      if (row.cardType === 'levelOrder') {
        await placeLevelOrder(kind, row, v, instrumentType, label);
      } else {
        await place(kind, row, v, instrumentType, label);
      }
    });
    b.setAttribute('data-kind', kind);
    return b;
  };
  const cardButtons = instrumentType === 'OPT'
    ? [{ label: 'OPEN', action: 'OPEN', style: 'bl' }]
    : row.cardType === 'levelOrder'
      ? [{ label: 'LB', action: 'LB', style: 'bl' }, { label: 'LS', action: 'LS', style: 'sl' }]
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

function createLevelOrderBody(row, key, $pointSize) {
  const defaults = resolveLevelOrderDefaults(levelOrderCfg, row.ticker);
  const defaultRisk = orderCalc.defaultRiskUsd({
    symbol: row.ticker,
    instrumentType: row.instrumentType || detectInstrumentType(row.ticker)
  });
  const saved = uiState.get(key) || {
    level: row.level != null ? String(row.level) : '',
    risk: row.riskUsd != null ? String(row.riskUsd) : (defaultRisk != null ? String(defaultRisk) : ''),
    stopOffsetPts: row.stopOffsetPts != null ? String(row.stopOffsetPts) : (defaults.stopOffsetPts != null ? String(defaults.stopOffsetPts) : ''),
    maxLot: row.maxLot != null ? String(row.maxLot) : (defaults.maxLot != null ? String(defaults.maxLot) : '0'),
    takeProfitPts: row.takeProfitPts != null ? String(row.takeProfitPts) : (defaults.takeProfitPts != null ? String(defaults.takeProfitPts) : ''),
    pointSize: row.pointSize != null ? String(row.pointSize) : ''
  };
  if ($pointSize) $pointSize.value = saved.pointSize;

  const line = el('div', 'quad-line level-order-line');
  line.style.display = 'grid';
  line.style.gridTemplateColumns = '1fr 1fr 1fr 1fr 1fr';
  line.style.alignItems = 'center';
  line.style.gap = line.style.gap || '8px';

  const $level = inputNumber('Level', 'level');
  const $risk = inputNumber('Risk $', 'risk');
  const $stopOffset = inputNumber('Stop off', 'sl');
  const $maxLot = inputNumber('Max lot', 'qty');
  const $tp = inputNumber('TP pts', 'tp');

  $level.value = saved.level;
  $risk.value = saved.risk;
  $stopOffset.value = saved.stopOffsetPts;
  $maxLot.value = saved.maxLot;
  $tp.value = saved.takeProfitPts;

  line.appendChild($level);
  line.appendChild($risk);
  line.appendChild($stopOffset);
  line.appendChild($maxLot);
  line.appendChild($tp);

  const persist = () => {
    uiState.set(key, {
      level: $level.value,
      risk: $risk.value,
      stopOffsetPts: $stopOffset.value,
      maxLot: $maxLot.value,
      takeProfitPts: $tp.value,
      pointSize: $pointSize ? $pointSize.value : ''
    });
  };

  const body = {
    type: 'levelOrder',
    line,
    setButtons($btns) {
      this._btns = $btns;
    },
    setNote($note) {
      this._note = $note;
    },
    validate(actionForValidation) {
      const level = _normNum($level.value);
      const risk = _normNum($risk.value);
      const stopOffsetPts = _normNum($stopOffset.value);
      const maxLot = _normNum($maxLot.value);
      const takeProfitPts = _normNum($tp.value);
      const pointSize = _normNum($pointSize?.value);
      const info = instrumentInfoFor(row.ticker, row);
      const bid = Number(info?.bid);
      const ask = Number(info?.ask);
      const buyPriceSource = normalizePriceSource(defaults.buyPriceSource, 'bid');
      const sellPriceSource = normalizePriceSource(defaults.sellPriceSource, 'bid');
      const sourceForAction = action => String(action || '').toUpperCase() === 'LS' ? sellPriceSource : buyPriceSource;
      const quoteForAction = action => resolveQuotePrice({ bid, ask, source: sourceForAction(action) });
      const pointSizeOk = !$pointSize || $pointSize.value === '' || (Number.isFinite(pointSize) && pointSize > 0);
      const tick = pointSizeOk && Number.isFinite(pointSize) && pointSize > 0 ? pointSize : tickSize(row);
      const tickOk = Number.isFinite(tick) && tick > 0;
      const minLot = Number(defaults.minLot);
      const minLotOk = Number.isFinite(minLot) && minLot > 0;
      const tpOk = $tp.value === '' || (Number.isFinite(takeProfitPts) && takeProfitPts > 0);
      const maxLotOk = Number.isFinite(maxLot) && maxLot >= 0;
      const commonValid = isPos(level) && isPos(risk) && isSL(stopOffsetPts) && maxLotOk && minLotOk && tpOk && pointSizeOk && tickOk;
      const quoteByAction = {
        LB: quoteForAction('LB'),
        LS: quoteForAction('LS')
      };
      const requestedActionRaw = String(actionForValidation || '').toUpperCase();
      const requestedAction = requestedActionRaw === 'LB' || requestedActionRaw === 'LS' ? requestedActionRaw : '';
      const quoteOk = action => quoteByAction[action]?.ok === true;
      const valid = commonValid && (requestedAction ? quoteOk(requestedAction) : quoteOk('LB') && quoteOk('LS'));

      line.classList.toggle('card--invalid', !valid);
      const setErr = (inp, bad) => inp.classList.toggle('input--error', !!bad);
      setErr($level, !isPos(level));
      setErr($risk, !isPos(risk));
      setErr($stopOffset, !isSL(stopOffsetPts));
      setErr($maxLot, !maxLotOk);
      setErr($tp, !tpOk);
      if ($pointSize) setErr($pointSize, !pointSizeOk);

      const commonReason = !isPos(level) ? 'Level > 0'
        : !isPos(risk) ? 'Risk $ > 0'
          : !isSL(stopOffsetPts) ? 'Stop offset pts > 0'
            : !maxLotOk ? 'Max lot >= 0'
              : !minLotOk ? 'Min lot > 0'
                : !tpOk ? 'TP pts > 0 or blank'
                  : !pointSizeOk ? 'Point price > 0 or blank'
                    : !tickOk ? 'Tick size required'
                      : '';
      const quoteReason = requestedAction && !quoteOk(requestedAction)
        ? quoteByAction[requestedAction]?.reason
        : !quoteOk('LB') ? quoteByAction.LB.reason
          : !quoteOk('LS') ? quoteByAction.LS.reason
            : '';
      const reason = commonReason || quoteReason;
      const buttonReason = action => commonReason || (!quoteOk(action) ? quoteByAction[action]?.reason : '');
      if (this._btns) this._btns.querySelectorAll('button').forEach(b => {
        const action = String(b.dataset.kind || '').toUpperCase();
        const buttonValid = commonValid && quoteOk(action);
        b.disabled = !buttonValid;
        const title = buttonReason(action);
        if (title) b.title = title; else b.removeAttribute('title');
      });
      if (this._note) {
        this._note.textContent = reason;
        this._note.style.display = reason ? 'block' : 'none';
      }
      persist();
      return {
        valid,
        type: 'levelOrder',
        level,
        risk,
        stopOffsetPts,
        maxLot,
        minLot,
        takeProfitPts: $tp.value === '' ? null : takeProfitPts,
        buyPriceSource,
        sellPriceSource,
        pointSize: $pointSize && $pointSize.value !== '' ? pointSize : null,
        tickSize: tick
      };
    }
  };

  [$level, $risk, $stopOffset, $maxLot, $tp, $pointSize].filter(Boolean).forEach(inp => {
    inp.addEventListener('input', () => {
      markTouched(row.ticker);
      persist();
      body.validate();
    });
  });

  return body;
}

function createOptionBody(row, key) {
  const line = el('div', 'quad-line option-legs');
  line.style.display = 'grid';
  line.style.gridTemplateColumns = '1fr';
  line.style.gap = '4px';

  const legs = Array.isArray(row.legs) ? row.legs : [];
  const summary = el('div', 'option-summary', null, {
    style: 'font-size:12px;color:#e5e7eb;display:flex;align-items:center;gap:3px;flex-wrap:wrap'
  });
  summary.appendChild(document.createTextNode(`${row.ticker || row.symbol || ''} ${row.expirationDte || ''} `.trim()));
  if (legs.length) summary.appendChild(document.createTextNode(' '));
  legs.forEach((leg, idx) => {
    const qty = signedOptionLegQty(leg);
    const legNode = el('span', null, optionLegToken(leg), {
      style: `color:${qty < 0 ? '#ef4444' : '#22c55e'};font-weight:700`
    });
    summary.appendChild(legNode);
    if (idx < legs.length - 1) summary.appendChild(document.createTextNode('/'));
  });
  line.appendChild(summary);

  const detailsRow = el('div', 'option-details', null, {
    style: 'display:flex;align-items:center;gap:8px;font-size:11px;line-height:1.2;flex-wrap:wrap'
  });
  const payoff = optionPayoffForRow(row);
  const valuation = optionValuationForRow(row);
  const openedAt = row.openedAt || row.meta?.openedAt;
  const closedAt = row.closedAt || row.meta?.closedAt;

  const maxLoss = payoff
    ? formatPayoffValue(payoff.maxLoss, payoff.isMaxLossInfinite)
    : '-';
  const maxProfit = payoff
    ? formatPayoffValue(payoff.maxProfit, payoff.isMaxProfitInfinite)
    : '-';
  const rr = formatRiskReward(payoff);
  const change = valuation ? Number(valuation.change) : NaN;
  const color = change > 0 ? '#22c55e' : change < 0 ? '#ef4444' : '#e5e7eb';

  if (valuation && optionStratDisplayFields.pl) {
    const changeNode = el('span', null, 'P/L ', { style: 'color:#fff' });
    changeNode.appendChild(el('span', null, formatCurrencyValue(change), { style: `color:${color};font-weight:700` }));
    detailsRow.appendChild(changeNode);
  }
  if (valuation && optionStratDisplayFields.value) {
    const valueNode = el('span', null, 'Value ', { style: 'color:#fff' });
    valueNode.appendChild(el('span', null, formatCurrencyValue(valuation.currentValue), { style: 'color:#e5e7eb;font-weight:700' }));
    detailsRow.appendChild(valueNode);
  }
  if (optionStratDisplayFields.maxLoss) {
    const lossNode = el('span', null, 'Max Loss ', { style: 'color:#fff' });
    lossNode.appendChild(el('span', null, maxLoss, { style: 'color:#ef4444;font-weight:700' }));
    detailsRow.appendChild(lossNode);
  }
  if (optionStratDisplayFields.maxProfit) {
    const profitNode = el('span', null, 'Max Profit ', { style: 'color:#fff' });
    profitNode.appendChild(el('span', null, maxProfit, { style: 'color:#22c55e;font-weight:700' }));
    detailsRow.appendChild(profitNode);
  }
  if (valuation && optionStratDisplayFields.change) {
    const pctNode = el('span', null, 'Change ', { style: 'color:#fff' });
    pctNode.appendChild(el('span', null, formatPercentValue(valuation.changePct), { style: `color:${color};font-weight:700` }));
    detailsRow.appendChild(pctNode);
  }
  if (optionStratDisplayFields.rr) {
    const rrNode = el('span', null, 'RR ', { style: 'color:#fff' });
    rrNode.appendChild(el('span', null, rr, { style: 'color:#e5e7eb;font-weight:700' }));
    detailsRow.appendChild(rrNode);
  }
  if (openedAt) {
    const openedNode = el('span', null, 'Opened ', { style: 'color:#9ca3af' });
    openedNode.appendChild(el('span', null, formatTradeTime(openedAt), { style: 'color:#e5e7eb;font-weight:700' }));
    detailsRow.appendChild(openedNode);
  }
  if (closedAt) {
    const closedNode = el('span', null, 'Closed ', { style: 'color:#9ca3af' });
    closedNode.appendChild(el('span', null, formatTradeTime(closedAt), { style: 'color:#e5e7eb;font-weight:700' }));
    detailsRow.appendChild(closedNode);
  }
  if (detailsRow.childNodes.length) line.appendChild(detailsRow);

  return {
    type: 'option',
    line,
    setButtons($btns) {
      this._btns = $btns;
    },
    setNote($note) {
      this._note = $note;
    },
    validate() {
      const valid = !!(row.ticker || row.symbol) && legs.length > 0;
      line.classList.toggle('card--invalid', !valid);
      const reason = valid ? '' : 'Option legs required';
      if (this._btns) this._btns.querySelectorAll('button').forEach(b => {
        b.disabled = !valid;
        if (!valid) b.title = reason; else b.removeAttribute('title');
      });
      if (this._note) {
        this._note.textContent = reason;
        this._note.style.display = reason ? 'block' : 'none';
      }
      return { valid, type: 'option' };
    }
  };
}

// ======= Crypto body (Qty, Price, SL, TP; TP auto = SL*3) =======
function createCryptoBody(row, key) {
  const defaultRisk = orderCalc.defaultRiskUsd({ symbol: row.ticker, instrumentType: 'CX' });
  const saved = uiState.get(key) || {
    qty: row.qty != null ? String(row.qty) : '',
    price: row.price != null ? String(row.price) : '',
    sl: row.sl != null ? String(row.sl) : '',
    tp: row.tp != null ? String(row.tp) : '',
    risk: row.risk != null ? String(row.risk) : (defaultRisk != null ? String(defaultRisk) : ''),
    tpTouched: row.tp != null, // если TP пришёл с хуком — не перезатираем авто-логикой
  };
  let tpTouched = !!saved.tpTouched;
  let autoTpUpdate = false;

  const line = el('div', 'quad-line');
  line.style.display = 'grid';
  line.style.gridTemplateColumns = '1fr 1fr 0.8fr 0.8fr 1fr'; // Qty, Price, SL, TP, Risk$
  line.style.alignItems = 'center';
  line.style.gap = line.style.gap || '8px';

  const $qty = inputNumber('Qty', 'qty');
  const $price = inputNumber('Price', 'pr');
  const $sl = inputNumber('SL', 'sl');
  const $tp = inputNumber('TP', 'tp');
  const $risk = inputNumber('Risk $', 'risk');

  // restore
  $qty.value = saved.qty;
  $price.value = saved.price;
  $sl.value = saved.sl;
  $tp.value = saved.tp;
  $risk.value = saved.risk;

  line.appendChild($qty);
  line.appendChild($price);
  line.appendChild($sl);
  line.appendChild($tp);
  line.appendChild($risk);

  const persist = () => {
    uiState.set(key, {
      qty: $qty.value,
      price: $price.value,
      sl: $sl.value,
      tp: $tp.value,
      risk: $risk.value,
      tpTouched
    });
  };
  const recomputeTP = () => {
    if (!tpTouched) {
      const slv = priceToPoints($sl, _normNum($price.value), row);
      autoTpUpdate = true;
      $tp.value = (slv && slv > 0) ? String(orderCalc.takePts(slv)) : '';
      autoTpUpdate = false;
      persist();
    }
  };
  const recomputeQtyFromRisk = () => {
    const r = _normNum($risk.value);
    const sl = priceToPoints($sl, _normNum($price.value), row);
    const lot = Number.isFinite(row.lot) && row.lot > 0 ? row.lot : 1;
    const tick = tickSize(row);

    if (isPos(r) && isSL(sl) && Number.isFinite(tick) && tick > 0) {
      const q = orderCalc.qty({riskUsd: r, stopPts: sl, tickSize: tick, lot, instrumentType: 'CX'});
      console.log('[UI][SIZE]', { ticker: row.ticker, riskUsd: r, stopPts: sl, tickSize: tick, quoteTickSize: instrumentInfoFor(row.ticker, row)?.tickSize, rowTickSize: row.tickSize, qty: q });
      $qty.value = String(q);
    }
    if (isPos(r) && isSL(sl) && (!Number.isFinite(tick) || tick <= 0)) {
      console.log('[UI][SIZE]', { ticker: row.ticker, riskUsd: r, stopPts: sl, tickSize: tick, quoteTickSize: instrumentInfoFor(row.ticker, row)?.tickSize, rowTickSize: row.tickSize, qty: null, state: 'tick-loading' });
      $qty.value = '';
    }
    persist();
  };

  const body = {
    type: 'crypto',
    line, $qty, $price, $sl, $tp, $risk,
    setButtons($btns) {
      this._btns = $btns;
    },
    setNote($note) {
      this._note = $note;
    },
    validate(commit = false) {
      const qty = _normNum($qty.value);
      const pr = _normNum($price.value);
      const risk = _normNum($risk.value);
      const sl = priceToPoints($sl, pr, row, commit);
      const tpVal = priceToPoints($tp, pr, row, commit);
      const info = instrumentInfoFor(row.ticker, row);
      const instrumentType = row.instrumentType || detectInstrumentType(row.ticker);
      const qtyOk = isPos(qty);
      const priceOk = isPos(pr);
      const slOk = isSL(sl);
      const {ok: rulesOk, reason: ruleReason = ''} = tradeRules.validate({
        price: pr,
        side: row.side,
        sl,
        instrumentType,
        qty
      }, info);
      const valid = qtyOk && priceOk && slOk && rulesOk;

      line.classList.toggle('card--invalid', !valid);

      const setErr = (inp, bad) => inp.classList.toggle('input--error', !!bad);
      setErr($qty, !qtyOk || (!rulesOk && ruleReason.toLowerCase().includes('qty')));
      setErr($price, !priceOk || (!rulesOk && !ruleReason.toLowerCase().includes('sl')));
      setErr($sl, !slOk || (!rulesOk && ruleReason.toLowerCase().includes('sl')));

      const reason = !qtyOk ? 'Qty > 0'
        : !priceOk ? 'Price > 0'
          : !slOk ? 'SL > 0'
            : !rulesOk ? ruleReason
              : '';
      if (this._btns) this._btns.querySelectorAll('button').forEach(b => {
        b.disabled = !valid;
        if (!valid) b.title = reason; else b.removeAttribute('title');
      });
      if (this._note) {
        if (!valid && reason) {
          this._note.textContent = reason;
          this._note.style.display = 'block';
        } else {
          this._note.textContent = '';
          this._note.style.display = 'none';
        }
      }
      return {valid, type: 'crypto', qty, pr, sl, tp: tpVal, risk};
    }
  };

  // wiring
  $risk.addEventListener('input', () => {
    markTouched(row.ticker);
    recomputeQtyFromRisk();
    body.validate();
  });
  $sl.addEventListener('input', () => {
    markTouched(row.ticker);
    if (String($sl.value).includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    body.validate();
  });
  $sl.addEventListener('blur', () => {
    const raw = $sl.value;
    priceToPoints($sl, _normNum($price.value), row, true);
    if (raw.includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    persist();
    body.validate(true);
  });
  $qty.addEventListener('input', () => {
    markTouched(row.ticker);
    persist();
    body.validate();
  });
  $price.addEventListener('input', () => {
    markTouched(row.ticker);
    persist();
    body.validate();
  });
  $price.addEventListener('blur', () => {
    const slRaw = $sl.value;
    priceToPoints($sl, _normNum($price.value), row, true);
    priceToPoints($tp, _normNum($price.value), row, true);
    if (slRaw.includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    persist();
    body.validate(true);
  });
  $tp.addEventListener('input', () => {
    if (autoTpUpdate) return;
    markTouched(row.ticker);
    tpTouched = true;
    persist();
    body.validate();
  });
  $tp.addEventListener('blur', () => {
    priceToPoints($tp, _normNum($price.value), row, true);
    persist();
    body.validate(true);
  });

  // Автопочатковий розрахунок qty з Risk/SL (якщо задано)
  recomputeQtyFromRisk();
  // Если TP не передан — вычисляем его из SL
  recomputeTP();
  return body;
}

// ======= Equities body (Qty, Price, SL, TP; Risk$ separate line; Qty auto from Risk/SL) =======
function createFxBody(row, key) {
  const defaultRisk = orderCalc.defaultRiskUsd({ symbol: row.ticker, instrumentType: 'FX' });
  const saved = uiState.get(key) || {
    qty: row.qty != null ? String(row.qty) : '',
    price: row.price != null ? String(row.price) : '',
    sl: row.sl != null ? String(row.sl) : '',
    tp: row.tp != null ? String(row.tp) : '',
    risk: row.risk != null ? String(row.risk) : (defaultRisk != null ? String(defaultRisk) : ''),
    tpTouched: row.tp != null,
  };
  let tpTouched = !!saved.tpTouched;
  let autoTpUpdate = false;

  const line = el('div', 'quad-line');
  line.style.display = 'grid';
  line.style.gridTemplateColumns = '1fr 1fr 0.8fr 0.8fr 1fr'; // Qty, Price, SL, TP, Risk$
  line.style.alignItems = 'center';
  line.style.gap = line.style.gap || '8px';

  const $qty = inputNumber('Qty', 'qty');
  const $price = inputNumber('Price', 'pr');
  const $sl = inputNumber('SL', 'sl');
  const $tp = inputNumber('TP', 'tp');
  const $risk = inputNumber('Risk $', 'risk');

  // restore
  $qty.value = saved.qty;
  $price.value = saved.price;
  $sl.value = saved.sl;
  $tp.value = saved.tp;
  $risk.value = saved.risk;

  const persist = () => {
    uiState.set(key, {
      qty: $qty.value,
      price: $price.value,
      sl: $sl.value,
      tp: $tp.value,
      risk: $risk.value,
      tpTouched
    });
  };
  const recomputeQtyFromRisk = () => {
    const r = _normNum($risk.value);
    const sl = priceToPoints($sl, _normNum($price.value), row);
    if (isPos(r) && isSL(sl)) {
      const tick = tickSize(row);
      const lot = row.lot || 100000;
      const q = orderCalc.qty({riskUsd: r, stopPts: sl, tickSize: tick, lot, instrumentType: 'FX'});
      $qty.value = String(q);
    }
    persist();
  };
  const recomputeTP = () => {
    if (!tpTouched) {
      const slv = priceToPoints($sl, _normNum($price.value), row);
      autoTpUpdate = true;
      $tp.value = (slv && slv > 0) ? String(orderCalc.takePts(slv)) : '';
      autoTpUpdate = false;
      persist();
    }
  };

  const body = {
    type: 'fx',
    line, $qty, $price, $sl, $tp, $risk,
    setButtons($btns) {
      this._btns = $btns;
    },
    validate(commit = false) {
      const qtyRaw = _normNum($qty.value);
      const pr = _normNum($price.value);
      const sl = priceToPoints($sl, pr, row, commit);
      const tpVal = priceToPoints($tp, pr, row, commit);
      const risk = _normNum($risk.value);
      const info = instrumentInfoFor(row.ticker, row);
      const instrumentType = row.instrumentType || 'FX';

      const qtyOk = Number.isFinite(qtyRaw) && qtyRaw > 0;
      const {ok: rulesOk, reason: ruleReason = ''} = tradeRules.validate({
        price: pr,
        side: row.side,
        sl,
        instrumentType,
        qty: qtyRaw
      }, info);
      const valid = isPos(risk) && isSL(sl) && isPos(pr) && qtyOk && rulesOk;

      line.classList.toggle('card--invalid', !valid);

      const setErr = (inp, bad) => inp.classList.toggle('input--error', !!bad);
      setErr($risk, !isPos(risk));
      setErr($sl, !isSL(sl) || (!rulesOk && ruleReason.toLowerCase().includes('sl')));
      setErr($price, !isPos(pr) || (!rulesOk && !ruleReason.toLowerCase().includes('sl')));
      setErr($qty, !qtyOk || (!rulesOk && ruleReason.toLowerCase().includes('qty')));

      const reason = !isPos(risk) ? 'Risk $ > 0'
        : !isSL(sl) ? 'SL > 0'
          : !isPos(pr) ? 'Price > 0'
            : !qtyOk ? 'Qty > 0'
              : !rulesOk ? ruleReason
                : '';
      if (this._btns) this._btns.querySelectorAll('button').forEach(b => {
        b.disabled = !valid;
        if (!valid) b.title = reason; else b.removeAttribute('title');
      });

      return {
        valid, type: 'fx',
        qty: qtyRaw, pr, sl, risk, tp: tpVal //todo normalize to min qty
      };
    }
  };

  // wiring
  $risk.addEventListener('input', () => {
    markTouched(row.ticker);
    recomputeQtyFromRisk();
    body.validate();
  });
  $sl.addEventListener('input', () => {
    markTouched(row.ticker);
    if (String($sl.value).includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    body.validate();
  });
  $sl.addEventListener('blur', () => {
    const raw = $sl.value;
    priceToPoints($sl, _normNum($price.value), row, true);
    if (raw.includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    persist();
    body.validate(true);
  });
  $qty.addEventListener('input', () => {
    markTouched(row.ticker);
    persist();
    body.validate();
  });
  $price.addEventListener('input', () => {
    markTouched(row.ticker);
    persist();
    body.validate();
  });
  $price.addEventListener('blur', () => {
    const slRaw = $sl.value;
    priceToPoints($sl, _normNum($price.value), row, true);
    priceToPoints($tp, _normNum($price.value), row, true);
    if (slRaw.includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    persist();
    body.validate(true);
  });
  $tp.addEventListener('input', () => {
    if (autoTpUpdate) return;
    markTouched(row.ticker);
    tpTouched = true;
    persist();
    body.validate();
  });
  $tp.addEventListener('blur', () => {
    priceToPoints($tp, _normNum($price.value), row, true);
    persist();
    body.validate(true);
  });

  // assemble
  line.appendChild($qty);
  line.appendChild($price);
  line.appendChild($sl);
  line.appendChild($tp);
  line.appendChild($risk);

  // compute qty from default risk and SL (if provided)
  recomputeQtyFromRisk();
  // if TP wasn't provided, derive it from SL
  recomputeTP();
  return body;
}


// ======= Equities body (Qty, Price, SL, TP; Risk$ separate line; Qty auto from Risk/SL) =======
function createEquitiesBody(row, key) {
  const defaultRisk = orderCalc.defaultRiskUsd({ symbol: row.ticker, instrumentType: 'EQ' });
  const saved = uiState.get(key) || {
    qty: row.qty != null ? String(row.qty) : '',
    price: row.price != null ? String(row.price) : '',
    sl: row.sl != null ? String(row.sl) : '',
    tp: row.tp != null ? String(row.tp) : '',
    risk: row.risk != null ? String(row.risk) : (defaultRisk != null ? String(defaultRisk) : ''),
    tpTouched: row.tp != null,
  };
  let tpTouched = !!saved.tpTouched;
  let autoTpUpdate = false;

  const line = el('div', 'quad-line');
  line.style.display = 'grid';
  line.style.gridTemplateColumns = '1fr 1fr 0.8fr 0.8fr 1fr'; // Qty, Price, SL, TP, Risk$
  line.style.alignItems = 'center';
  line.style.gap = line.style.gap || '8px';

  const $qty = inputNumber('Qty', 'qty');
  const $price = inputNumber('Price', 'pr');
  const $sl = inputNumber('SL', 'sl');
  const $tp = inputNumber('TP', 'tp');
  const $risk = inputNumber('Risk $', 'risk');

  // restore
  $qty.value = saved.qty;
  $price.value = saved.price;
  $sl.value = saved.sl;
  $tp.value = saved.tp;
  $risk.value = saved.risk;

  const persist = () => {
    uiState.set(key, {
      qty: $qty.value,
      price: $price.value,
      sl: $sl.value,
      tp: $tp.value,
      risk: $risk.value,
      tpTouched
    });
  };
  const recomputeQtyFromRisk = () => {
    const r = _normNum($risk.value);
    const sl = priceToPoints($sl, _normNum($price.value), row);
    if (isPos(r) && isSL(sl)) {
      const tick = tickSize(row);
      const q = orderCalc.qty({riskUsd: r, stopPts: sl, tickSize: tick, instrumentType: 'EQ'});
      $qty.value = String(q);
    }
    persist();
  };
  const recomputeTP = () => {
    if (!tpTouched) {
      const slv = priceToPoints($sl, _normNum($price.value), row);
      autoTpUpdate = true;
      $tp.value = (slv && slv > 0) ? String(orderCalc.takePts(slv)) : '';
      autoTpUpdate = false;
      persist();
    }
  };

  const body = {
    type: 'equities',
    line, $qty, $price, $sl, $tp, $risk,
    setButtons($btns) {
      this._btns = $btns;
    },
    setNote($note) {
      this._note = $note;
    },
    validate(commit = false) {
      const qtyRaw = _normNum($qty.value);
      const pr = _normNum($price.value);
      const sl = priceToPoints($sl, pr, row, commit);
      const tpVal = priceToPoints($tp, pr, row, commit);
      const risk = _normNum($risk.value);
      const info = instrumentInfoFor(row.ticker, row);
      const instrumentType = row.instrumentType || detectInstrumentType(row.ticker);

      const qtyOk = Number.isFinite(qtyRaw) && qtyRaw >= 1 && Math.floor(qtyRaw) === qtyRaw;
      const priceOk = isPos(pr);
      const slOk = isSL(sl);
      const riskOk = isPos(risk);
      const {ok: rulesOk, reason: ruleReason = ''} = tradeRules.validate({
        price: pr,
        side: row.side,
        sl,
        instrumentType,
        qty: qtyRaw
      }, info);

      const valid = riskOk && slOk && priceOk && qtyOk && rulesOk;

      line.classList.toggle('card--invalid', !valid);

      const setErr = (inp, bad) => inp.classList.toggle('input--error', !!bad);
      setErr($risk, !riskOk);
      setErr($sl, !slOk || (!rulesOk && ruleReason.toLowerCase().includes('sl')));
      setErr($price, !priceOk || (!rulesOk && !ruleReason.toLowerCase().includes('sl')));
      setErr($qty, !qtyOk || (!rulesOk && ruleReason.toLowerCase().includes('qty')));

      const reason = !riskOk ? 'Risk $ > 0'
        : !slOk ? 'SL > 0'
          : !priceOk ? 'Price > 0'
            : !qtyOk ? 'Qty ≥ 1 (int)'
              : !rulesOk ? ruleReason
                : '';
      if (this._btns) this._btns.querySelectorAll('button').forEach(b => {
        b.disabled = !valid;
        if (!valid) b.title = reason; else b.removeAttribute('title');
      });
      if (this._note) {
        if (!valid && reason) {
          this._note.textContent = reason;
          this._note.style.display = 'block';
        } else {
          this._note.textContent = '';
          this._note.style.display = 'none';
        }
      }

      return {
        valid, type: 'equities',
        qty: qtyRaw, pr, sl, risk, tp: tpVal,
        qtyInt: Number.isFinite(qtyRaw) ? Math.floor(qtyRaw) : 0
      };
    }
  };

  // wiring
  $risk.addEventListener('input', () => {
    markTouched(row.ticker);
    recomputeQtyFromRisk();
    body.validate();
  });
  $sl.addEventListener('input', () => {
    markTouched(row.ticker);
    if (String($sl.value).includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    body.validate();
  });
  $sl.addEventListener('blur', () => {
    const raw = $sl.value;
    priceToPoints($sl, _normNum($price.value), row, true);
    if (raw.includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    persist();
    body.validate(true);
  });
  $qty.addEventListener('input', () => {
    markTouched(row.ticker);
    persist();
    body.validate();
  });
  $price.addEventListener('input', () => {
    markTouched(row.ticker);
    persist();
    body.validate();
  });
  $price.addEventListener('blur', () => {
    const slRaw = $sl.value;
    priceToPoints($sl, _normNum($price.value), row, true);
    priceToPoints($tp, _normNum($price.value), row, true);
    if (slRaw.includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    persist();
    body.validate(true);
  });
  $tp.addEventListener('input', () => {
    if (autoTpUpdate) return;
    markTouched(row.ticker);
    tpTouched = true;
    persist();
    body.validate();
  });
  $tp.addEventListener('blur', () => {
    priceToPoints($tp, _normNum($price.value), row, true);
    persist();
    body.validate(true);
  });

  // assemble
  line.appendChild($qty);
  line.appendChild($price);
  line.appendChild($sl);
  line.appendChild($tp);
  line.appendChild($risk);

  // compute qty from default risk and SL (if provided)
  recomputeQtyFromRisk();
  // prefill TP from SL when not explicitly passed
  recomputeTP();
  return body;
}


function tickSize(row) {
  const explicit = Number(row?.tickSize);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const info = instrumentInfoFor(row.ticker, row);
  const cached = Number(info?.tickSize);
  if (Number.isFinite(cached) && cached > 0 && String(info?.sources?.tickSize || '').startsWith('adapter:')) return cached;
  const configured = Number(findTickSizeOverride(row.ticker));
  if (Number.isFinite(configured) && configured > 0) return configured;
  if (Number.isFinite(cached) && cached > 0) return cached;
  return getDefaultTickSize();
}

function decimalsFromTick(tick) {
  const t = Number(tick);
  if (!Number.isFinite(t) || t <= 0) return 5;
  const s = String(t);
  if (s.includes('e') || s.includes('E')) {
    const m = t.toString();
    const p = m.indexOf('.');
    return p >= 0 ? (m.length - p - 1) : 0;
  }
  const dot = s.indexOf('.');
  return dot >= 0 ? (s.length - dot - 1) : 0;
}

function formatPriceValue(info, row) {
  if (!info || typeof info !== 'object') return '';
  const bid = Number(info.bid);
  const ask = Number(info.ask);
  let price = Number(info.price);
  if (!Number.isFinite(price)) {
    if (Number.isFinite(bid) && Number.isFinite(ask)) price = (bid + ask) / 2;
  }
  if (!Number.isFinite(price)) return '';
  const tick = tickSize(row);
  const decimals = Math.min(8, Math.max(0, decimalsFromTick(tick)));
  return price.toFixed(decimals);
}

// Повертає спред у пунктах (integer) або NaN
function computeSpreadPts(info, row) {
  if (!info || !Number.isFinite(info.ask) || !Number.isFinite(info.bid)) return NaN;
  const spread = info.ask - info.bid;
  const tick = tickSize(row);
  if (!Number.isFinite(spread) || !Number.isFinite(tick) || tick <= 0) return NaN;
  const pts = spread / tick;
  if (!Number.isFinite(pts)) return NaN;
  return Math.max(0, Math.round(pts));
}

function formatBidAskText(info, row) {
  if (!info || typeof info !== 'object') return '';
  const bid = Number(info.bid);
  const ask = Number(info.ask);
  if (!Number.isFinite(bid) && !Number.isFinite(ask)) return '';
  const tick = tickSize(row);
  const decimals = Math.min(8, Math.max(0, decimalsFromTick(tick)));
  const b = Number.isFinite(bid) ? bid.toFixed(decimals) : '-';
  const a = Number.isFinite(ask) ? ask.toFixed(decimals) : '-';
  return `${b} / ${a}`;
}

function calcAvg(arr, n) {
  const len = Array.isArray(arr) ? arr.length : 0;
  if (!len) return NaN;
  const k = Math.max(1, Math.min(n, len));
  let sum = 0;
  for (let i = len - k; i < len; i++) sum += arr[i];
  return Math.round(sum / k);
}

function formatSpreadTriple(ticker, row, curPtsOverride) {
  const info = instrumentInfoFor(ticker, row);
  const cur = Number.isFinite(curPtsOverride) ? curPtsOverride : computeSpreadPts(info, row);
  if (!Number.isFinite(cur)) return '';
  const hist = spreadHistory.get(ticker) || [];
  const avg10 = Number.isFinite(calcAvg(hist, 10)) ? calcAvg(hist, 10) : cur;
  const avg100 = Number.isFinite(calcAvg(hist, 100)) ? calcAvg(hist, 100) : (Number.isFinite(avg10) ? avg10 : cur);
  return `${cur}/${avg10}/${avg100}`;
}

function updateSpreadForTicker(ticker) {
  if (!ticker) return;
  const info = instrumentInfoFor(ticker);
  const row = state.rows.find(r => r.ticker === ticker);
  if (!row) return;

  // 1) Оновлюємо історію (лише якщо спред відображається)
  let curPts;
  if (SHOW_SPREAD) {
    curPts = computeSpreadPts(info, row);
    if (Number.isFinite(curPts)) {
      const arr = spreadHistory.get(ticker) || [];
      arr.push(curPts);
      if (arr.length > 100) arr.splice(0, arr.length - 100);
      spreadHistory.set(ticker, arr);
    }
  }

  // 2) Оновлюємо UI для всіх карток із цим тикером
  const cards = $grid.querySelectorAll(`.card[data-ticker="${cssEsc(ticker)}"]`);
  cards.forEach(card => {
    if (SHOW_BID_ASK) {
      const ba = card.querySelector('.card__bidask');
      if (ba) ba.textContent = formatBidAskText(info, row) || '';
    }
    if (SHOW_SPREAD) {
      const sp = card.querySelector('.card__spread');
      if (sp) sp.textContent = formatSpreadTriple(ticker, row, curPts) || '';
    }
  });
}

function revalidateCardsForTicker(ticker) {
  if (!ticker) return;
  const cards = $grid.querySelectorAll(`.card[data-ticker="${cssEsc(ticker)}"]`);
  cards.forEach(card => {
    if (typeof card._validate === 'function') {
      try {
        card._validate(false);
      } catch (_) {
      }
    }
  });
}

function ensureLevelOrderGroup(parentRequestId, key, total = null) {
  if (!parentRequestId || !key) return null;
  let group = levelOrderGroups.get(parentRequestId);
  if (!group) {
    group = {
      parentRequestId,
      key,
      total: Number.isFinite(Number(total)) && Number(total) > 0 ? Number(total) : null,
      childReqIds: new Set(),
      placedReqIds: new Set(),
      openedTickets: new Set(),
      closedTickets: new Set(),
      profitByTicket: new Map(),
      tickets: new Set()
    };
    levelOrderGroups.set(parentRequestId, group);
  } else {
    group.key = key;
    if (Number.isFinite(Number(total)) && Number(total) > 0) group.total = Number(total);
  }
  return group;
}

function findLevelOrderGroupByReqId(reqId) {
  const parent = levelOrderChildToGroup.get(reqId);
  return parent ? levelOrderGroups.get(parent) : null;
}

function findLevelOrderGroupByPendingId(pendingId) {
  const parent = levelOrderPendingToGroup.get(String(pendingId || ''));
  return parent ? levelOrderGroups.get(parent) : null;
}

function findOrRegisterLevelOrderGroupFromMeta(meta = {}, fallbackKey) {
  const reqId = meta.requestId;
  const parentRequestId = meta.parentRequestId;
  if (!parentRequestId || !reqId) return null;
  const existing = findLevelOrderGroupByReqId(reqId);
  if (existing) return existing;
  const childCount = Number(meta.childCount);
  const key = fallbackKey || pendingByReqId.get(parentRequestId);
  if (!key) return null;
  const group = ensureLevelOrderGroup(parentRequestId, key, childCount);
  group.childReqIds.add(reqId);
  levelOrderChildToGroup.set(reqId, parentRequestId);
  pendingByReqId.set(reqId, key);
  return group;
}

function registerLevelOrderChild(rec = {}, fallbackKey) {
  const meta = {
    ...(rec.order?.meta || {}),
    requestId: rec.order?.meta?.requestId || rec.reqId,
    parentRequestId: rec.order?.meta?.parentRequestId || rec.parentRequestId,
    childCount: rec.order?.meta?.childCount || rec.childCount,
    childIndex: rec.order?.meta?.childIndex || rec.childIndex
  };
  const parentRequestId = meta.parentRequestId;
  const reqId = meta.requestId || rec.reqId;
  if (!parentRequestId || !reqId) return null;
  const childCount = Number(meta.childCount);
  const key = fallbackKey || pendingByReqId.get(parentRequestId) || findKeyByTicker(rec.order?.symbol || rec.order?.ticker);
  if (!key) return null;
  const group = ensureLevelOrderGroup(parentRequestId, key, childCount);
  group.childReqIds.add(reqId);
  levelOrderChildToGroup.set(reqId, parentRequestId);
  if (rec.pendingId) levelOrderPendingToGroup.set(String(rec.pendingId), parentRequestId);
  if (rec.cid) levelOrderPendingToGroup.set(String(rec.cid), parentRequestId);
  pendingByReqId.set(reqId, key);
  return group;
}

function registerLevelOrderTicket(group, ticket, key) {
  const normalized = String(ticket || '').trim();
  if (!group || !normalized) return;
  group.tickets.add(normalized);
  levelOrderTicketToGroup.set(normalized, group.parentRequestId);
  ticketToKey.set(normalized, key || group.key);
}

function levelOrderAllPlaced(group) {
  if (!group) return false;
  const total = group.total || group.childReqIds.size;
  return total > 0 && group.placedReqIds.size >= total;
}

function levelOrderAllOpened(group) {
  if (!group) return false;
  if (group.lifecycleReady === true) return true;
  const total = group.total || group.childReqIds.size;
  return total > 0 && group.openedTickets.size >= total;
}

function levelOrderAllClosed(group) {
  if (!group) return false;
  const total = group.tickets.size || group.total || group.childReqIds.size;
  return total > 0 && group.closedTickets.size >= total;
}

function clearLevelOrderGroup(parentReqId) {
  const group = levelOrderGroups.get(parentReqId);
  levelOrderGroups.delete(parentReqId);
  if (group) {
    for (const childReqId of group.childReqIds) {
      levelOrderChildToGroup.delete(childReqId);
      pendingByReqId.delete(childReqId);
      pendingIdByReqId.delete(childReqId);
      retryCounts.delete(childReqId);
    }
    for (const ticket of group.tickets) {
      levelOrderTicketToGroup.delete(ticket);
      ticketToKey.delete(ticket);
    }
  }
  for (const [pendingId, parent] of levelOrderPendingToGroup.entries()) {
    if (parent === parentReqId) levelOrderPendingToGroup.delete(pendingId);
  }
}

function levelOrderGroupsByKey(key) {
  return Array.from(levelOrderGroups.values()).filter(group => group.key === key);
}

function clearLevelOrderByKey(key) {
  for (const group of levelOrderGroupsByKey(key)) clearLevelOrderGroup(group.parentRequestId);
}

function cancelLevelOrderTerminalOrders(group, row) {
  if (!group) return;
  const provider = row?.provider || '';
  const symbol = row?.symbol || row?.ticker || '';
  for (const ticket of group.tickets) {
    if (group.openedTickets.has(ticket)) continue;
    ipcRenderer.invoke('execution:cancel-order', { provider, ticket, symbol }).catch(() => {});
  }
}

// ======= Order placement (shared) =======
const PENDING_ACTIONS = {
  BC: {strategy: 'consolidation', side: 'long'},
  SC: {strategy: 'consolidation', side: 'short'},
  BFB: {strategy: 'falseBreak', side: 'long'},
  SFB: {strategy: 'falseBreak', side: 'short'},
  BP: {strategy: 'limitByCurrent', side: 'long'},
  SP: {strategy: 'limitByCurrent', side: 'short'}
};

async function place(kind, row, v, instrumentType, btnLabel) {
  if (!v.valid) return;

  const key = rowKey(row);
  const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  pendingByReqId.set(requestId, key);
  retryCounts.set(requestId, 0);
  const pendingInfo = PENDING_ACTIONS[kind];
  const isPendingExec = !!pendingInfo;
  const isLong = pendingInfo ? pendingInfo.side === 'long' : null;
  const alias = isPendingExec ? btnLabel : null;
  if (alias) pendingExecLabels.set(key, alias);
  setCardState(key, isPendingExec ? 'pending-exec' : 'pending');
  const card = cardByKey(key);
  if (card) {
    card.dataset.reqId = requestId;
    const rb = card.querySelector('.retry-btn');
    if (rb) rb.textContent = '0';
  }

  let qtyVal, priceVal, slVal, takeVal, tick, extra = {};
  if (v.type === 'option') {
    qtyVal = 1;
    priceVal = 1;
    slVal = 1;
    takeVal = null;
    tick = 0.01;
  } else if (v.type === 'crypto') {
    qtyVal = v.qty;
    priceVal = v.pr;
    slVal = v.sl;
    takeVal = v.tp ?? null;
    tick = tickSize(row);  //do not fallback for crypro to keep fail order if tick size is unknown
    extra.riskUsd = v.risk;
  } else if (v.type === 'equities') {
    qtyVal = v.qtyInt;
    priceVal = v.pr;
    slVal = v.sl;
    takeVal = v.tp ?? null;
    tick = tickSize(row);
    extra.riskUsd = v.risk;
  } else {
    qtyVal = v.qty;
    priceVal = v.pr;
    slVal = v.sl;
    takeVal = v.tp ?? null;
    tick = tickSize(row);
    extra.riskUsd = v.risk;
  }

  const baseMeta = {
    requestId, // связь с execution:result
    qty: Number(qtyVal),
    stopPts: Number(slVal),
    takePts: takeVal == null ? null : Number(takeVal),
    ...extra
  };

  let res;
  try {
    if (isPendingExec) {
      const pendPayload = {
        ticker: row.ticker,
        provider: row.provider,
        event: row.event,
        price: Number(priceVal),
        side: isLong ? 'long' : 'short',
        strategy: pendingInfo?.strategy,
        instrumentType: instrumentType,
        tickSize: tick,
        meta: baseMeta,
      };
      res = await ipcRenderer.invoke('queue-place-pending', pendPayload);
    } else {
      if (v.type === 'option') {
        const payload = {
          ticker: row.ticker,
          symbol: row.symbol || row.ticker,
          root: row.root,
          provider: row.provider,
          instrumentType: 'OPT',
          name: row.name,
          description: row.description,
          expirationDte: row.expirationDte,
          isCustomName: row.isCustomName,
          isCashSecured: row.isCashSecured,
          legs: row.legs,
          side: 'OPEN',
          meta: baseMeta,
        };
        emitOptionStratButtonEvent('open', row);
        res = await ipcRenderer.invoke('queue-place-order', payload);
      } else {
      const payload = {
        ticker: row.ticker,
        event: row.event,
        price: Number(priceVal),
        kind,
        instrumentType: instrumentType,
        tickSize: tick,
        meta: baseMeta,
      };
      res = await ipcRenderer.invoke('queue-place-order', payload);
      }
    }
    if (res && typeof res.providerOrderId === 'string' && res.providerOrderId.startsWith('pending:')) {
      const pendId = res.providerOrderId.slice('pending:'.length);
      pendingIdByReqId.set(requestId, pendId);
      if (card) card.dataset.pendingId = pendId;
      toast(`… ${row.ticker}: sent, waiting confirmation`);
    }
    if (!res || res.status === 'rejected' || res.status === 'error') {
      setCardState(key, null);
      toast(`✖ ${row.ticker}: ${res?.reason || 'Rejected'}`);
      shakeCard(key);
      render();
    } else {
      if (v.type === 'option' && res.providerOrderId) {
        const openedAt = Date.now();
        pendingByReqId.delete(requestId);
        pendingIdByReqId.delete(requestId);
        retryCounts.delete(requestId);
        placedOrderByKey.set(key, {
          provider: res.provider || row.provider || 'optionstrat',
          ticket: String(res.providerOrderId),
          symbol: row.symbol || row.ticker || '',
          strategyCommand: row.strategyCommand,
          name: row.name,
          payoff: res.payoff || res.raw?.payoff,
          valuation: res.valuation || res.raw?.valuation,
          openedAt
        });
        if (res.payoff || res.raw?.payoff) row.payoff = res.payoff || res.raw.payoff;
        if (res.valuation || res.raw?.valuation) row.valuation = res.valuation || res.raw.valuation;
        row.openedAt = row.openedAt || openedAt;
        ticketToKey.set(String(res.providerOrderId), key);
        setCardState(key, 'placed');
      } else {
        setCardState(key, isPendingExec ? 'pending-exec' : 'pending');
      }
      render();
    }
  } catch (e) {
    setCardState(key, null);
    toast(`✖ ${row.ticker}: ${e.message || e}`);
    shakeCard(key);
    render();
  }
}

async function placeLevelOrder(kind, row, v, instrumentType, btnLabel) {
  if (!v.valid) return;

  const key = rowKey(row);
  const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const strategyId = `${requestId}_${String(kind).toLowerCase()}`;
  pendingByReqId.set(requestId, key);
  ensureLevelOrderGroup(requestId, key);
  retryCounts.set(requestId, 0);
  pendingExecLabels.set(key, btnLabel || kind);
  setCardState(key, 'pending-exec');
  const card = cardByKey(key);
  if (card) {
    card.dataset.reqId = requestId;
    const rb = card.querySelector('.retry-btn');
    if (rb) rb.textContent = '0';
  }

  try {
    const res = await ipcRenderer.invoke('level-order:place', {
      ticker: row.ticker,
      provider: row.provider,
      instrumentType,
      action: kind,
      level: v.level,
      riskUsd: v.risk,
      stopOffsetPts: v.stopOffsetPts,
      maxLot: v.maxLot,
      minLot: v.minLot,
      takeProfitPts: v.takeProfitPts,
      buyPriceSource: v.buyPriceSource,
      sellPriceSource: v.sellPriceSource,
      pointSize: v.pointSize,
      tickSize: v.tickSize,
      requestId,
      strategyId
    });
    if (!res || res.status === 'rejected' || res.status === 'error') {
      levelOrderGroups.delete(requestId);
      setCardState(key, null);
      toast(`x ${row.ticker}: ${res?.reason || 'Rejected'}`);
      shakeCard(key);
      render();
      return;
    }
    const group = levelOrderGroups.get(requestId);
    if (group && res.raw?.plan?.childQtys) group.total = res.raw.plan.childQtys.length;
    if (group && Array.isArray(res.raw?.results)) {
      for (const child of res.raw.results) {
        const childReqId = child?.requestId;
        const childStatus = child?.result?.status;
        if (!childReqId || (childStatus !== 'ok' && childStatus !== 'simulated')) continue;
        group.childReqIds.add(childReqId);
        levelOrderChildToGroup.set(childReqId, group.parentRequestId);
        const providerOrderId = String(child?.result?.providerOrderId || '');
        if (providerOrderId.startsWith('pending:')) {
          levelOrderPendingToGroup.set(providerOrderId.slice('pending:'.length), group.parentRequestId);
        } else if (providerOrderId) {
          registerLevelOrderTicket(group, providerOrderId, key);
        }
      }
    }
    if (group && levelOrderAllPlaced(group)) {
      setCardState(key, levelOrderAllOpened(group) ? 'executing' : 'pending-exec');
    } else {
      setCardState(key, 'pending-exec');
    }
    toast(`... ${row.ticker}: level order sent`);
    render();
  } catch (e) {
    setCardState(key, null);
    toast(`x ${row.ticker}: ${e.message || e}`);
    shakeCard(key);
    render();
  }
}

function clearPendingByKey(key) {
  for (const [rid, k] of pendingByReqId.entries()) {
    if (k === key) {
      pendingByReqId.delete(rid);
      pendingIdByReqId.delete(rid);
      retryCounts.delete(rid);
    }
  }
  for (const [parentReqId, group] of levelOrderGroups.entries()) {
    if (group.key !== key) continue;
    levelOrderGroups.delete(parentReqId);
    for (const childReqId of group.childReqIds) levelOrderChildToGroup.delete(childReqId);
    for (const [pendingId, parent] of levelOrderPendingToGroup.entries()) {
      if (parent === parentReqId) levelOrderPendingToGroup.delete(pendingId);
    }
    for (const ticket of group.tickets) levelOrderTicketToGroup.delete(ticket);
  }
  pendingExecLabels.delete(key);
  placedOrderByKey.delete(key);
  pendingOptionValuations.delete(key);
}

function removeRow(row) {
  const key = rowKey(row);
  const before = state.rows.length;
  state.rows = state.rows.filter(r => r !== row);
  if (state.rows.length === before) {
    state.rows = state.rows.filter(r => !(r.ticker === row.ticker && r.event === row.event && r.time === row.time && r.price === row.price));
  }
  uiState.delete(key);
  cardStates.delete(key);
  placedOrderByKey.delete(key);
  clearPendingByKey(key);
  userTouchedByTicker.delete(row.ticker); // reset touched flag for ticker
  render();
  forgetInstrument(row.ticker, row.provider);
}

function removeRowByKey(key) {
  const idx = state.rows.findIndex(r => rowKey(r) === key);
  if (idx >= 0) {
    const row = state.rows[idx];
    state.rows.splice(idx, 1);
    uiState.delete(key);
    cardStates.delete(key);
    placedOrderByKey.delete(key);
    clearPendingByKey(key);
    userTouchedByTicker.delete(row.ticker); // reset touched flag for ticker
    render();
    forgetInstrument(row.ticker, row.provider);
  }
}

function scheduleInstantExecution(row) {
  if (!row || row.instrumentType !== 'OPT' || row.instantExecution !== true) return;
  const key = rowKey(row);
  if (instantExecutedKeys.has(key)) return;
  instantExecutedKeys.add(key);
  setTimeout(() => {
    const current = state.rows.find(r => rowKey(r) === key);
    if (!current || cardStates.get(key)) return;
    place('OPEN', current, { valid: true, type: 'option' }, 'OPT', 'OPEN');
  }, 0);
}

// ======= IPC wiring =======
ipcRenderer.invoke('orders:list', 100).then(rows => {
  state.rows = Array.isArray(rows) ? rows : [];
  render();
}).catch(() => {
});

// Заявка поставлена в очередь адаптером (ждём подтверждение из DWX)
ipcRenderer.on('execution:pending', (_evt, rec) => {
  const reqId = rec?.reqId;
  if (!reqId) return;

  let key = pendingByReqId.get(reqId);
  if (!key) key = findKeyByTicker(rec?.order?.symbol || rec?.order?.ticker);
  const levelGroup = registerLevelOrderChild(rec, key);
  if (levelGroup) key = levelGroup.key;
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
    card.dataset.reqId = levelGroup ? levelGroup.parentRequestId : reqId;
    const rb = card.querySelector('.retry-btn');
    if (rb) rb.textContent = '0';
  }
  if (!levelGroup && (cardStates.get(key) !== 'pending-exec' || rec?.order?.side)) {
    setCardState(key, 'pending');
  }
  if (!levelGroup && card && rec?.order) {
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
  const levelGroup = findLevelOrderGroupByReqId(rec.reqId) || findLevelOrderGroupByPendingId(rec.pendingId);
  if (levelGroup) key = levelGroup.key;
  if (!key) return;
  retryCounts.set(rec.reqId, rec.count);
  const card = cardByKey(key);
  if (card) {
    const rb = card.querySelector('.retry-btn');
    if (rb) rb.textContent = String(rec.count);
  }
});

ipcRenderer.on('execution:retry-stopped', (_evt, rec) => {
  const levelGroup = findLevelOrderGroupByReqId(rec.reqId)
    || findLevelOrderGroupByPendingId(rec.pendingId)
    || levelOrderGroups.get(rec.parentRequestId || rec.reqId);
  let key = pendingByReqId.get(rec.reqId);
  if (levelGroup) key = levelGroup.key;
  if (!key) return;
  if (levelGroup) {
    const parentReqId = levelGroup.parentRequestId;
    clearLevelOrderGroup(parentReqId);
    pendingByReqId.delete(parentReqId);
    pendingIdByReqId.delete(parentReqId);
    retryCounts.delete(parentReqId);
    const card = cardByKey(key);
    if (card) {
      delete card.dataset.reqId;
      delete card.dataset.pendingId;
      const rb = card.querySelector('.retry-btn');
      if (rb) {
        rb.textContent = '0';
        rb.style.display = 'none';
      }
    }
    setCardState(key, null);
    render();
    return;
  }
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
  // ищем существующую карточку по ТИКЕРУ
  const idx = state.rows.findIndex(r => row.instrumentType === 'OPT' ? rowKey(r) === rowKey(row) : r.ticker === row.ticker);

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
  if (st === 'closed' || st === 'profit' || st === 'loss') {
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
      if (row.cardType === 'levelOrder') {
        if (row.level != null) patch.level = String(row.level);
        if (row.riskUsd != null) patch.risk = String(row.riskUsd);
        if (row.stopOffsetPts != null) patch.stopOffsetPts = String(row.stopOffsetPts);
        if (row.maxLot != null) patch.maxLot = String(row.maxLot);
        if (row.takeProfitPts != null) patch.takeProfitPts = String(row.takeProfitPts);
        if (row.pointSize != null) patch.pointSize = String(row.pointSize);
      }
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
  const levelGroup = registerLevelOrderChild(rec) || findLevelOrderGroupByPendingId(rec?.pendingId || rec?.cid);
  const key = levelGroup?.key || pendingByReqId.get(reqId);
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
  if (levelGroup) {
    if (ok) {
      levelGroup.placedReqIds.add(reqId);
      if (rec.providerOrderId) registerLevelOrderTicket(levelGroup, rec.providerOrderId, key);
      if (levelOrderAllPlaced(levelGroup)) {
        setCardState(key, levelOrderAllOpened(levelGroup) ? 'executing' : 'pending-exec');
        const cardEl = cardByKey(key);
        if (cardEl) {
          delete cardEl.dataset.reqId;
          delete cardEl.dataset.pendingId;
        }
        toast(`✔ ${rec.order?.symbol || ''}: level order group placed`);
        render();
      }
      return;
    }
    setCardState(key, null);
    render();
    shakeCard(key);
    if (card) card.title = rec.reason || 'Rejected';
    toast(`✖ ${rec.order?.symbol || ''}: ${rec.reason || 'Rejected'}`);
    return;
  }

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
  } else {
    setCardState(key, null);
    render();
    shakeCard(key);
    if (card) card.title = rec.reason || 'Rejected';
    toast(`✖ ${rec.order?.symbol || ''}: ${rec.reason || 'Rejected'}`);
  }
});

ipcRenderer.on('position:opened', (_evt, rec) => {
  const ticket = String(rec.ticket);
  let levelGroup = levelOrderGroups.get(levelOrderTicketToGroup.get(ticket));
  let key = levelGroup?.key || ticketToKey.get(ticket);
  if (!levelGroup && rec.origOrder?.meta?.parentRequestId) {
    const groupByMeta = findLevelOrderGroupByReqId(rec.origOrder.meta.requestId)
      || findOrRegisterLevelOrderGroupFromMeta(rec.origOrder.meta, key || pendingByReqId.get(rec.origOrder.meta.parentRequestId));
    if (groupByMeta) {
      levelGroup = groupByMeta;
      key = key || groupByMeta.key;
      registerLevelOrderTicket(levelGroup, ticket, key);
    }
  }
  if (!key) {
    const meta = rec.origOrder?.meta || {};
    const reqId = meta.requestId;
    if (reqId) {
      const fallbackKey = meta.parentRequestId ? pendingByReqId.get(meta.parentRequestId) : null;
      const groupByReq = findLevelOrderGroupByReqId(reqId) || findOrRegisterLevelOrderGroupFromMeta(meta, fallbackKey);
      if (groupByReq) levelGroup = groupByReq;
      key = groupByReq?.key || pendingByReqId.get(reqId);
      if (key) {
        ticketToKey.set(ticket, key);
        if (levelGroup) registerLevelOrderTicket(levelGroup, ticket, key);
      }
    }
  }
  if (!key) return;
  if (levelGroup) {
    levelGroup.openedTickets.add(ticket);
    markRowOpened(key);
    if (levelOrderAllOpened(levelGroup)) {
      placedOrderByKey.delete(key);
      setCardState(key, 'executing');
      render();
    }
    return;
  }
  placedOrderByKey.delete(key);
  markRowOpened(key);
  setCardState(key, 'executing');
  render();
});

ipcRenderer.on('level-order:positions-ready', (_evt, rec = {}) => {
  const parentRequestId = rec.parentRequestId || rec.requestId;
  const group = levelOrderGroups.get(parentRequestId);
  let key = group?.key || pendingByReqId.get(parentRequestId);
  if ((!key || !cardByKey(key)) && rec.symbol) {
    const liveKey = findKeyByTicker(rec.symbol);
    if (liveKey) {
      if (group) group.key = liveKey;
      key = liveKey;
    }
  }
  if (!key) return;
  if (group) {
    group.lifecycleReady = true;
    group.foundQty = Number(rec.foundQty);
    group.expectedQty = Number(rec.expectedQty);
    for (const cid of rec.foundCids || []) levelOrderPendingToGroup.set(String(cid), parentRequestId);
  }
  setCardState(key, 'executing');
  render();
});

ipcRenderer.on('position:closed', (_evt, rec) => {
  const ticket = String(rec.ticket);
  const levelGroup = levelOrderGroups.get(levelOrderTicketToGroup.get(ticket));
  const key = levelGroup?.key || ticketToKey.get(ticket);
  if (!key) return;
  if (levelGroup) {
    levelGroup.closedTickets.add(ticket);
    if (typeof rec.profit === 'number') levelGroup.profitByTicket.set(ticket, rec.profit);
    else levelGroup.profitByTicket.delete(ticket);
    markRowClosed(key);
    if (levelOrderAllClosed(levelGroup)) {
      const tickets = Array.from(levelGroup.tickets);
      const pnlComplete = tickets.length > 0 && tickets.every(groupTicket => levelGroup.profitByTicket.has(groupTicket));
      const totalProfit = pnlComplete
        ? tickets.reduce((sum, groupTicket) => sum + levelGroup.profitByTicket.get(groupTicket), 0)
        : null;
      setCardState(key, pnlComplete ? (totalProfit >= 0 ? 'profit' : 'loss') : 'closed');
      render();
    }
    return;
  }
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
  const levelGroup = levelOrderGroups.get(levelOrderTicketToGroup.get(ticket));
  const key = levelGroup?.key || ticketToKey.get(ticket);
  if (key) {
    const row = state.rows.find(r => rowKey(r) === key);
    ticketToKey.delete(ticket);
    if (levelGroup || row?.cardType === 'levelOrder' || levelOrderGroupsByKey(key).length > 0) {
      if (levelGroup) levelGroup.tickets.delete(ticket);
      levelOrderTicketToGroup.delete(ticket);
      return;
    }
    placedOrderByKey.delete(key);
    removeRowByKey(key);
  }
});

// ======= UI events =======
$filter.addEventListener('input', () => {
  state.filter = $filter.value || '';
  render();
});
$settingsBtn.addEventListener('click', () => {
  $settingsPanel.style.display = 'flex';
  loadSettingsSections();
});
let settingsSaveInProgress = false;
async function saveAndCloseSettingsPanel() {
  if (settingsSaveInProgress) return;
  settingsSaveInProgress = true;
  const results = [];
  try {
    const pendingSaves = [];
    for (const [name, form] of settingsForms.entries()) {
      if (form.dataset.dirty) {
        try {
          pendingSaves.push([name, serializeSettingsForm(form, name)]);
        } catch (error) {
          showSection(name);
          form.querySelector('textarea[data-role="raw-json"]')?.focus();
          toast(`Invalid JSON in ${name}: ${error?.message || error}`);
          return;
        }
      }
    }
    for (const [name, data] of pendingSaves) {
      results.push(await ipcRenderer.invoke('settings:set', name, data));
    }
    const failures = results.flatMap(result => result?.errors || []);
    const restart = await ipcRenderer.invoke('settings:restart-status').catch(() => []);
    renderRestartStatus(restart);
    if (failures.length) toast(`Settings saved; apply failed: ${failures.join('; ')}`);
    else if (Array.isArray(restart) && restart.length) toast('Settings saved; restart required for some changes');
    else if (results.length) toast('Settings saved and applied');
    $settingsPanel.style.display = 'none';
    settingsForms.clear();
  } catch (error) {
    toast(`Settings save failed: ${error?.message || error}`);
  } finally {
    settingsSaveInProgress = false;
  }
}

$settingsClose.addEventListener('click', saveAndCloseSettingsPanel);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($settingsPanel.style.display !== 'flex') return;
  e.preventDefault();
  saveAndCloseSettingsPanel();
});
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
    levelOrderGroups,
    levelOrderChildToGroup,
    levelOrderPendingToGroup,
    levelOrderTicketToGroup,
    clearLevelOrderGroup,
    retryCounts,
    cardStates,
    pendingExecLabels,
    placedOrderByKey,
    instrumentInfo,
    settingsForms,
    migrateKey,
    setLevelOrderConfig(config) {
      levelOrderCfg = config || {};
    },
    setOptionStratDisplayFields(fields) {
      optionStratDisplayFields = normalizeOptionStratDisplayFields(fields);
    },
    render
  };
}
