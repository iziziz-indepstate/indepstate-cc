// services/brokerage/adapterRegistry.js
// Creates and caches adapter instances by provider name and injects config
// from services/brokerage/config/execution.json (or via initExecutionConfig).

const loadConfig = require('../../config/load');
const brokerageAdapters = require('./brokerageAdapters');

let executionConfig = null; // set via initExecutionConfig() or lazy‑loaded from disk
const instances = new Map(); // name -> adapter instance

function deepClone(obj){ return obj ? JSON.parse(JSON.stringify(obj)) : obj; }

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function fillMissing(target, defaults) {
  if (!isPlainObject(target) || !isPlainObject(defaults)) return false;
  let changed = false;
  for (const key of Object.keys(defaults)) {
    const defaultValue = defaults[key];
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] = deepClone(defaultValue);
      changed = true;
      continue;
    }
    if (isPlainObject(target[key]) && isPlainObject(defaultValue)) {
      changed = fillMissing(target[key], defaultValue) || changed;
    }
  }
  return changed;
}

function executionDefaultsFromExtension(extension = {}) {
  const defaults = {};
  const routing = extension.routingDefaults || {};
  const byInstrumentType = extension.byInstrumentType || routing.byInstrumentType;
  const bySymbol = extension.bySymbol || routing.bySymbol;
  const providers = extension.providers || extension.providerDefaults;
  if (Object.prototype.hasOwnProperty.call(extension, 'default')) defaults.default = extension.default;
  if (isPlainObject(byInstrumentType)) defaults.byInstrumentType = byInstrumentType;
  if (isPlainObject(bySymbol)) defaults.bySymbol = bySymbol;
  if (isPlainObject(providers)) defaults.providers = providers;
  return defaults;
}

function loadExecutionConfigFromDisk() {
  try {
    return loadConfig('../services/brokerage/config/execution.json');
  } catch (e) {
    console.error('[adapterRegistry] cannot read execution.json:', e.message);
    return { providers:{}, byInstrumentType:{}, bySymbol:{}, default:'simulated' };
  }
}

function initExecutionConfig(cfg){
  executionConfig = deepClone(cfg || {});
  // config changed — rebuild adapters on next getAdapter()
  instances.clear();
}

function normalizeAdapterName(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) throw new Error('[adapterRegistry] adapter name is required');
  return key;
}

function registerAdapterFactory(adapterName, factory) {
  const key = normalizeAdapterName(adapterName);
  if (typeof factory !== 'function') {
    throw new Error(`[adapterRegistry] adapter factory for "${adapterName}" must be a function`);
  }
  brokerageAdapters[key] = factory;
  instances.clear();
  return () => {
    if (brokerageAdapters[key] !== factory) return false;
    delete brokerageAdapters[key];
    instances.clear();
    return true;
  };
}

function hasAdapterFactory(adapterName) {
  const key = normalizeAdapterName(adapterName);
  return typeof brokerageAdapters[key] === 'function';
}

function listAdapterFactories() {
  return Object.keys(brokerageAdapters)
    .filter(key => typeof brokerageAdapters[key] === 'function')
    .sort();
}

function updateExecutionRouting(cfg = {}, paths = []) {
  const current = getExecutionConfig();
  const providers = current.providers || {};
  const next = deepClone(current);
  const unavailablePaths = [];
  const available = value => {
    const name = String(value || '').trim().toLowerCase();
    return !name || !!providers[name];
  };
  for (const pathName of paths) {
    const parts = pathName.split('.');
    let value = cfg;
    for (const part of parts) value = value == null ? undefined : value[part];
    if (value !== undefined && !available(value)) {
      unavailablePaths.push(pathName);
      continue;
    }
    let target = next;
    for (let i = 0; i < parts.length - 1; i += 1) {
      target[parts[i]] = target[parts[i]] && typeof target[parts[i]] === 'object' ? target[parts[i]] : {};
      target = target[parts[i]];
    }
    if (value === undefined) delete target[parts[parts.length - 1]];
    else target[parts[parts.length - 1]] = deepClone(value);
  }
  executionConfig = next;
  return unavailablePaths;
}

function registerExecutionProviderDefaults(extension = {}) {
  const next = deepClone(getExecutionConfig()) || {};
  const changed = fillMissing(next, executionDefaultsFromExtension(extension));
  if (changed) {
    executionConfig = next;
    instances.clear();
  }
  return deepClone(getExecutionConfig());
}

function getExecutionConfig(){
  if (!executionConfig) executionConfig = loadExecutionConfigFromDisk();
  return executionConfig;
}

// Support secrets like "$ENV:NAME" or "${ENV:NAME}"
function resolveEnvRef(str){
  if (typeof str !== 'string') return str;
  const m = str.match(/^\s*(?:\$\{?ENV:([A-Z0-9_]+)\}?)\s*$/i);
  if (!m) return str;
  const v = process.env[m[1]];
  return v == null ? '' : v;
}
function resolveSecrets(obj){
  if (!obj || typeof obj !== 'object') return resolveEnvRef(obj);
  if (Array.isArray(obj)) return obj.map(resolveSecrets);
  const out = {};
  for (const k of Object.keys(obj)) out[k] = resolveSecrets(obj[k]);
  return out;
}

function buildAdapter(providerName, cfg){
  const { adapter: adapterName, ...adapterCfg } = cfg || {};
  if (!adapterName) {
    throw new Error(`[adapterRegistry] provider "${providerName}" must specify an adapter`);
  }
  const n = String(adapterName).toLowerCase();
  const key = brokerageAdapters[n] ? n : n.split(/[:\-]/)[0];
  const factory = brokerageAdapters[key];
  if (typeof factory !== 'function') {
    throw new Error(`[adapterRegistry] unknown adapter "${adapterName}" for provider "${providerName}"`);
  }

  try {
    const inst = factory(adapterCfg, providerName, adapterName);
    inst.provider = providerName;
    return inst;
  } catch (e) {
    console.error('[adapterRegistry] failed to build adapter:', e);
    throw e;
  }

}

function getAdapter(name){
  const n = String(name || '').toLowerCase();
  if (instances.has(n)) return instances.get(n);

  const cfg = getExecutionConfig();
  const provCfg = resolveSecrets((cfg.providers && cfg.providers[n]) || {});
  const inst = buildAdapter(n, provCfg);
  instances.set(n, inst);
  if (typeof inst.preloadInstrumentMetadata === 'function') {
    Promise.resolve()
      .then(() => inst.preloadInstrumentMetadata())
      .catch(err => console.error('[adapterRegistry] instrument metadata preload failed:', n, err?.message || err));
  }
  return inst;
}

function getProviderConfig(name){
  const cfg = getExecutionConfig();
  return (cfg.providers && cfg.providers[name]) || {};
}

module.exports = {
  getAdapter,
  initExecutionConfig,
  updateExecutionRouting,
  getExecutionConfig,
  getProviderConfig,
  registerAdapterFactory,
  registerExecutionProviderDefaults,
  hasAdapterFactory,
  listAdapterFactories,
  executionDefaultsFromExtension
};
