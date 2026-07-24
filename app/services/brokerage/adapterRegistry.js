// services/brokerage/adapterRegistry.js
// Creates and caches adapter instances by provider name and injects config
// from services/brokerage/config/execution.json (or via initExecutionConfig).

const loadConfig = require('../../config/load');
const brokerageAdapters = require('./brokerageAdapters');

let executionConfig = null; // set via initExecutionConfig() or lazy‑loaded from disk
const instances = new Map(); // name -> adapter instance

function deepClone(obj){ return obj ? JSON.parse(JSON.stringify(obj)) : obj; }

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

module.exports = { getAdapter, initExecutionConfig, updateExecutionRouting, getExecutionConfig, getProviderConfig };
