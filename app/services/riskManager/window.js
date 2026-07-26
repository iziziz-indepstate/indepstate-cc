const { ipcRenderer } = require('electron');

const $config = document.getElementById('config');
const $providers = document.getElementById('providers');
const $symbols = document.getElementById('symbols');
const $selectedProvider = document.getElementById('selected-provider');
const $globalEnabled = document.getElementById('global-enabled');
const $globalPoll = document.getElementById('global-poll');
const $globalLogLimit = document.getElementById('global-log-limit');
const $newSymbol = document.getElementById('new-symbol');
const $newSymbolStop = document.getElementById('new-symbol-stop');
const $newSymbolLoss = document.getElementById('new-symbol-loss');
const $positions = document.getElementById('positions');
const $logs = document.getElementById('logs');
const $status = document.getElementById('status');
const $error = document.getElementById('error');

let state = { config: {}, positions: [], logs: [] };
let configModel = {};
let configDirty = false;
let lastConfigText = '';
let selectedProvider = '';

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '-';
}

function fmtTime(value) {
  const n = Number(value);
  return Number.isFinite(n) ? new Date(n).toLocaleTimeString() : '-';
}

function cls(status) {
  if (status === 'ok') return 'ok';
  if (status === 'breached' || status === 'close-failed' || status === 'error') return 'bad';
  if (status === 'warning') return 'warn';
  return 'muted';
}

function ensureConfigShape(config = configModel) {
  if (!config || typeof config !== 'object') config = {};
  if (!config.providers || typeof config.providers !== 'object') config.providers = {};
  return config;
}

function providerNames() {
  return Object.keys(ensureConfigShape().providers || {}).sort((a, b) => a.localeCompare(b));
}

function selectedProviderConfig() {
  ensureConfigShape();
  if (!selectedProvider || !configModel.providers[selectedProvider]) {
    selectedProvider = providerNames()[0] || '';
  }
  return selectedProvider ? configModel.providers[selectedProvider] : null;
}

function numericInput(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? String(n) : '';
}

function readLimit(value) {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function setDirty(nextDirty = true) {
  configDirty = nextDirty;
  updateStatus();
}

function updateStatus() {
  $status.textContent = `${state.positions.length} positions, ${state.logs.length} log rows${configDirty ? ', unsaved config' : ''}`;
}

function isConfigFocused() {
  const active = document.activeElement;
  return !!active && !!active.closest('#providers, #symbols, #config, #global-enabled, #global-poll, #global-log-limit, #new-symbol, #new-symbol-stop, #new-symbol-loss');
}

function syncConfigEditor(force = false) {
  const nextText = JSON.stringify(ensureConfigShape(), null, 2);
  const isEditing = document.activeElement === $config;
  if (force || (!isEditing)) {
    $config.value = nextText;
    lastConfigText = nextText;
  }
}

function syncModelFromJsonEditor() {
  const text = $config.value;
  const parsed = JSON.parse(text || '{}');
  configModel = ensureConfigShape(parsed);
  lastConfigText = JSON.stringify(configModel, null, 2);
  if ($config.value !== lastConfigText && document.activeElement !== $config) {
    $config.value = lastConfigText;
  }
}

function renderConfigForm(force = false) {
  if (!force && isConfigFocused()) return;
  ensureConfigShape();
  $globalEnabled.checked = configModel.enabled !== false;
  $globalPoll.value = Number.isFinite(Number(configModel.pollMs)) ? String(configModel.pollMs) : '';
  $globalLogLimit.value = Number.isFinite(Number(configModel.logLimit)) ? String(configModel.logLimit) : '';
  renderProviders();
  renderSymbols();
  syncConfigEditor(force);
}

function renderProviders() {
  ensureConfigShape();
  const names = providerNames();
  if (!selectedProvider || !configModel.providers[selectedProvider]) selectedProvider = names[0] || '';
  $providers.innerHTML = '';
  for (const name of names) {
    const provider = configModel.providers[name] || {};
    const tr = document.createElement('tr');
    tr.className = `provider-row${name === selectedProvider ? ' selected' : ''}`;
    tr.dataset.provider = name;
    tr.innerHTML = `
      <td class="provider-cell">${escapeHtml(name)}</td>
      <td><input type="checkbox" data-provider="${escapeHtml(name)}" data-field="enabled" ${provider.enabled !== false ? 'checked' : ''}></td>
      <td><input class="compact-input" type="number" min="0" step="0.01" data-provider="${escapeHtml(name)}" data-field="maxStopRiskUsd" value="${escapeHtml(numericInput(provider.maxStopRiskUsd))}" placeholder="off"></td>
      <td><input class="compact-input" type="number" min="0" step="0.01" data-provider="${escapeHtml(name)}" data-field="maxOpenLossUsd" value="${escapeHtml(numericInput(provider.maxOpenLossUsd))}" placeholder="off"></td>
      <td><button class="icon danger" title="Remove provider" data-remove-provider="${escapeHtml(name)}">x</button></td>
    `;
    $providers.appendChild(tr);
  }
}

function renderSymbols() {
  const provider = selectedProviderConfig();
  $selectedProvider.textContent = selectedProvider ? selectedProvider : 'No provider selected';
  $symbols.innerHTML = '';
  if (!provider) return;
  if (!provider.symbols || typeof provider.symbols !== 'object') provider.symbols = {};
  const symbols = Object.keys(provider.symbols).sort((a, b) => a.localeCompare(b));
  for (const symbol of symbols) {
    const cfg = provider.symbols[symbol] || {};
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(symbol)}</td>
      <td><input type="checkbox" data-symbol="${escapeHtml(symbol)}" data-field="enabled" ${cfg.enabled !== false ? 'checked' : ''}></td>
      <td><input class="compact-input" type="number" min="0" step="0.01" data-symbol="${escapeHtml(symbol)}" data-field="maxStopRiskUsd" value="${escapeHtml(numericInput(cfg.maxStopRiskUsd))}" placeholder="inherit"></td>
      <td><input class="compact-input" type="number" min="0" step="0.01" data-symbol="${escapeHtml(symbol)}" data-field="maxOpenLossUsd" value="${escapeHtml(numericInput(cfg.maxOpenLossUsd))}" placeholder="inherit"></td>
      <td><button class="icon danger" title="Remove symbol override" data-remove-symbol="${escapeHtml(symbol)}">x</button></td>
    `;
    $symbols.appendChild(tr);
  }
}

function renderPositions() {
  $positions.innerHTML = '';
  for (const pos of state.positions || []) {
    const snap = pos.snapshot || {};
    const warnings = (snap.warnings || []).join('; ');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(pos.provider)}<br><span class="muted">${escapeHtml(pos.ticket)}</span></td>
      <td>${escapeHtml(pos.symbol || '-')} <span class="pill">${escapeHtml(pos.side || '-')}</span> <span class="pill">${escapeHtml(pos.kind || 'position')}</span><br><span class="muted">qty ${escapeHtml(snap.qty ?? '-')}</span></td>
      <td>Stop ${fmtMoney(snap.stopRiskUsd)} / ${fmtMoney(pos.limits?.maxStopRiskUsd)}<br>Loss ${fmtMoney(snap.openLossUsd)} / ${fmtMoney(pos.limits?.maxOpenLossUsd)}</td>
      <td><span class="${cls(pos.riskStatus)}">${escapeHtml(pos.riskStatus || 'pending')}</span><br><span class="muted">${escapeHtml(warnings || pos.closeReason || '')}</span></td>
      <td><button class="danger" data-key="${escapeHtml(pos.key)}">Close</button></td>
    `;
    $positions.appendChild(tr);
  }
}

function renderLogs() {
  $logs.innerHTML = '';
  for (const log of state.logs || []) {
    const valueLimit = Number.isFinite(Number(log.value)) && Number.isFinite(Number(log.limit))
      ? `${fmtMoney(log.value)} / ${fmtMoney(log.limit)}`
      : '';
    const resultText = [log.result?.status, log.result?.reason].filter(Boolean).join(' ');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtTime(log.ts)}</td>
      <td>${escapeHtml(log.provider || '-')}</td>
      <td>${escapeHtml(log.symbol || '-')} <span class="pill">${escapeHtml(log.itemKind || '-')}</span><br><span class="muted">${escapeHtml(log.ticket || '')}</span></td>
      <td>${escapeHtml(log.checkLabel || log.check || log.type || '-')}<br><span class="muted">${escapeHtml(valueLimit || log.reason || '')}</span></td>
      <td>${escapeHtml(log.action || '-')}</td>
      <td>${escapeHtml(resultText || log.reason || '-')}</td>
    `;
    $logs.appendChild(tr);
  }
}

function render(next, options = {}) {
  state = next || state;
  if (options.forceConfig === true || (!configDirty && !isConfigFocused())) {
    configModel = clone(state.config || {});
  }
  renderConfigForm(options.forceConfig === true);
  updateStatus();
  renderPositions();
  renderLogs();
}

function applyFormChange() {
  ensureConfigShape();
  configModel.enabled = $globalEnabled.checked;
  configModel.pollMs = readLimit($globalPoll.value) || 1000;
  configModel.logLimit = readLimit($globalLogLimit.value) || 200;
  setDirty(true);
  syncConfigEditor(true);
}

function updateProviderField(providerName, field, element) {
  const provider = ensureConfigShape().providers[providerName];
  if (!provider) return;
  if (field === 'enabled') provider.enabled = element.checked;
  else provider[field] = readLimit(element.value);
  setDirty(true);
  syncConfigEditor(true);
}

function updateSymbolField(symbol, field, element) {
  const provider = selectedProviderConfig();
  if (!provider) return;
  if (!provider.symbols || typeof provider.symbols !== 'object') provider.symbols = {};
  const cfg = provider.symbols[symbol];
  if (!cfg) return;
  if (field === 'enabled') cfg.enabled = element.checked;
  else cfg[field] = readLimit(element.value);
  setDirty(true);
  syncConfigEditor(true);
}

async function refresh() {
  $error.textContent = '';
  render(await ipcRenderer.invoke('risk-manager:list'));
}

$config.addEventListener('input', () => {
  configDirty = $config.value !== lastConfigText;
  updateStatus();
});

$config.addEventListener('blur', () => {
  try {
    const wasDirty = $config.value !== lastConfigText;
    syncModelFromJsonEditor();
    renderConfigForm(true);
    setDirty(wasDirty);
    $error.textContent = '';
  } catch (err) {
    $error.textContent = err?.message || String(err);
  }
});

for (const element of [$globalEnabled, $globalPoll, $globalLogLimit]) {
  element.addEventListener('input', applyFormChange);
}

$providers.addEventListener('click', event => {
  const removeName = event.target?.dataset?.removeProvider;
  if (removeName) {
    delete ensureConfigShape().providers[removeName];
    if (selectedProvider === removeName) selectedProvider = providerNames()[0] || '';
    setDirty(true);
    renderConfigForm(true);
    return;
  }
  const row = event.target?.closest('tr[data-provider]');
  if (row && !event.target.matches('input, button')) {
    selectedProvider = row.dataset.provider;
    renderProviders();
    renderSymbols();
  }
});

$providers.addEventListener('input', event => {
  const providerName = event.target?.dataset?.provider;
  const field = event.target?.dataset?.field;
  if (!providerName || !field) return;
  updateProviderField(providerName, field, event.target);
});

$symbols.addEventListener('input', event => {
  const symbol = event.target?.dataset?.symbol;
  const field = event.target?.dataset?.field;
  if (!symbol || !field) return;
  updateSymbolField(symbol, field, event.target);
});

$symbols.addEventListener('click', event => {
  const symbol = event.target?.dataset?.removeSymbol;
  if (!symbol) return;
  const provider = selectedProviderConfig();
  if (!provider?.symbols) return;
  delete provider.symbols[symbol];
  setDirty(true);
  renderConfigForm(true);
});

document.getElementById('add-provider').addEventListener('click', () => {
  const name = window.prompt('Provider name');
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return;
  ensureConfigShape().providers[normalized] = {
    enabled: true,
    maxStopRiskUsd: undefined,
    maxOpenLossUsd: undefined,
    symbols: {}
  };
  selectedProvider = normalized;
  setDirty(true);
  renderConfigForm(true);
});

document.getElementById('add-symbol').addEventListener('click', () => {
  const symbol = String($newSymbol.value || '').trim();
  if (!symbol) return;
  const provider = selectedProviderConfig();
  if (!provider) return;
  if (!provider.symbols || typeof provider.symbols !== 'object') provider.symbols = {};
  provider.symbols[symbol] = {
    enabled: true,
    maxStopRiskUsd: readLimit($newSymbolStop.value),
    maxOpenLossUsd: readLimit($newSymbolLoss.value)
  };
  $newSymbol.value = '';
  $newSymbolStop.value = '';
  $newSymbolLoss.value = '';
  setDirty(true);
  renderConfigForm(true);
});

document.getElementById('refresh').addEventListener('click', async () => {
  $error.textContent = '';
  render(await ipcRenderer.invoke('risk-manager:refresh'));
});

document.getElementById('save').addEventListener('click', async () => {
  try {
    if ($config.value !== lastConfigText) syncModelFromJsonEditor();
    const result = await ipcRenderer.invoke('risk-manager:save', ensureConfigShape());
    if (result?.errors?.length) $error.textContent = result.errors.join('; ');
    else $error.textContent = '';
    configDirty = false;
    render(await ipcRenderer.invoke('risk-manager:list'), { forceConfig: true });
  } catch (err) {
    $error.textContent = err?.message || String(err);
  }
});

$positions.addEventListener('click', async event => {
  const key = event.target?.dataset?.key;
  if (!key) return;
  $error.textContent = '';
  await ipcRenderer.invoke('risk-manager:close-position', { key, reason: 'manual risk-manager close' });
  render(await ipcRenderer.invoke('risk-manager:list'));
});

ipcRenderer.on('risk-manager:state', (_event, data) => render(data));
refresh();
