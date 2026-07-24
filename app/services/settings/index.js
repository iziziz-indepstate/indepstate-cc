const fs = require('fs');
const path = require('path');
const loadConfig = require('../../config/load');

const registry = new Map(); // key -> { defaultsPath, descriptorPath, baseline, policy }
const applyHandlers = new Map();
const runtimeConfigs = new Map();
const restartRequired = new Map();
const APPLY_POLICIES = {
  ui: { livePaths: ['*'] },
  'order-cards': {
    livePaths: ['closedCardEventStrategy', 'showBidAsk', 'showSpread', 'buttonRows', 'buttons', 'instrumentRefreshMs'],
    restartPaths: ['sources']
  },
  'level-order': { livePaths: ['*'] },
  'pending-strategies': { livePaths: ['*'] },
  'tick-sizes': { livePaths: ['*'] },
  'trade-rules': { livePaths: ['*'] },
  'order-calculator': { livePaths: ['*'] },
  execution: { livePaths: ['default', 'byInstrumentType', 'bySymbol'], restartPaths: ['providers'] },
  'actions-bus': { livePaths: ['*'] },
  'outbound-webhooks': { livePaths: ['*'] },
  'deal-trackers': { livePaths: ['*'] },
  'chart-images': { livePaths: ['*'] },
  'execution-log': { livePaths: ['*'] },
  'tv-listener': { livePaths: ['*'] },
  optionstrat: { livePaths: ['*'] },
  'command-line': { livePaths: ['*'] },
  'auto-updater': {
    livePaths: ['autoDownload', 'allowPrerelease', 'provider', 'owner', 'repo'],
    restartPaths: ['enabled']
  }
};

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function pathMatches(pathName, prefixes = []) {
  return prefixes.some(prefix => prefix === '*' || pathName === prefix || pathName.startsWith(`${prefix}.`));
}

function changedPaths(before, after, prefix = '') {
  if (Object.is(before, after)) return [];
  if (Array.isArray(before) || Array.isArray(after)) {
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix || '*'];
  }
  const beforeObject = before && typeof before === 'object';
  const afterObject = after && typeof after === 'object';
  if (!beforeObject || !afterObject) return [prefix || '*'];
  const out = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const child = prefix ? `${prefix}.${key}` : key;
    out.push(...changedPaths(before[key], after[key], child));
  }
  return out;
}

function getPath(obj, dottedPath) {
  if (dottedPath === '*') return obj;
  return dottedPath.split('.').reduce((value, key) => value == null ? undefined : value[key], obj);
}

function setPath(obj, dottedPath, value) {
  if (dottedPath === '*') return clone(value);
  const parts = dottedPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!cur[key] || typeof cur[key] !== 'object') cur[key] = {};
    cur = cur[key];
  }
  const last = parts[parts.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = clone(value);
  return obj;
}

function safeError(error) {
  const message = String(error?.message || error || 'Settings apply failed');
  return message
    .replace(/\bBearer\s+\S+/ig, 'Bearer [redacted]')
    .replace(/([?&](?:authorization|token|secret|password|credential|api[-_]?key)=)[^&\s]+/ig, '$1[redacted]')
    .replace(/("(?:authorization|token|secret|password|credential|api[-_]?key)"\s*:\s*")[^"]+/ig, '$1[redacted]')
    .replace(/(authorization|token|secret|password|credential|api[-_]?key)\s*[:=]\s*\S+/ig, '$1=[redacted]');
}

function register(key, defaultsPath, descriptorPath, policy = {}) {
  const existing = registry.get(key);
  const defaultPolicy = APPLY_POLICIES[key] || {};
  const info = {
    defaultsPath,
    descriptorPath,
    policy: {
      livePaths: Array.isArray(policy.livePaths) ? policy.livePaths.slice() : (existing?.policy?.livePaths || defaultPolicy.livePaths || []),
      restartPaths: Array.isArray(policy.restartPaths) ? policy.restartPaths.slice() : (existing?.policy?.restartPaths || defaultPolicy.restartPaths || [])
    }
  };
  try {
    info.baseline = clone(loadConfig(defaultsPath));
  } catch {
    info.baseline = {};
  }
  registry.set(key, info);
  if (!runtimeConfigs.has(key)) runtimeConfigs.set(key, clone(info.baseline));
}

function setApplyPolicy(key, policy = {}) {
  const info = registry.get(key);
  if (!info) return false;
  info.policy = {
    livePaths: Array.isArray(policy.livePaths) ? policy.livePaths.slice() : [],
    restartPaths: Array.isArray(policy.restartPaths) ? policy.restartPaths.slice() : []
  };
  return true;
}

function onApply(key, handler) {
  if (typeof handler !== 'function') return () => {};
  const handlers = applyHandlers.get(key) || new Set();
  handlers.add(handler);
  applyHandlers.set(key, handlers);
  return () => handlers.delete(handler);
}

function loadWithOverrides(info) {
  return loadConfig(info.defaultsPath);
}

function listConfigs() {
  const meta = [];
  for (const [key, info] of registry.entries()) {
    let props = {};
    if (info.descriptorPath) {
      try {
        const desc = JSON.parse(fs.readFileSync(info.descriptorPath, 'utf8'));
        props = desc.properties || {};
      } catch {}
    }
    meta.push({
      key,
      name: props.name || key,
      group: props.group,
      restartRequiredPaths: Array.from(restartRequired.get(key) || [])
    });
  }
  const priority = ['ui', 'services', 'auto-updater'];
  const noGroup = meta.filter(m => !m.group);
  const ordered = [];
  priority.forEach(p => {
    const idx = noGroup.findIndex(m => m.key === p);
    if (idx !== -1) ordered.push(noGroup.splice(idx, 1)[0]);
  });
  noGroup.sort((a, b) => a.name.localeCompare(b.name));
  const grouped = meta.filter(m => m.group).reduce((acc, m) => {
    (acc[m.group] = acc[m.group] || []).push(m);
    return acc;
  }, {});
  Object.keys(grouped).forEach(g => grouped[g].sort((a, b) => a.name.localeCompare(b.name)));
  const groups = Object.keys(grouped).sort();
  return ordered.concat(noGroup, ...groups.flatMap(g => grouped[g]));
}

function readConfig(name) {
  const info = registry.get(name);
  if (!info) return {};
  const cfg = loadWithOverrides(info);
  let descriptor = {};
  if (info.descriptorPath) {
    try {
      descriptor = JSON.parse(fs.readFileSync(info.descriptorPath, 'utf8'));
    } catch {}
  }
  return { config: cfg, descriptor };
}

function writeConfig(name, data) {
  const info = registry.get(name);
  if (!info) return false;
  const fileName = path.basename(info.defaultsPath);
  const overridePath = path.join(loadConfig.USER_ROOT, 'config', fileName);
  fs.mkdirSync(path.dirname(overridePath), { recursive: true });
  fs.writeFileSync(overridePath, JSON.stringify(data, null, 2));
  return true;
}

function classifyPaths(info, paths) {
  const live = [];
  const restart = [];
  const policy = info?.policy || {};
  for (const pathName of paths) {
    if (pathMatches(pathName, policy.restartPaths || [])) restart.push(pathName);
    else if (pathMatches(pathName, policy.livePaths || [])) live.push(pathName);
    else restart.push(pathName);
  }
  return { live, restart };
}

async function applyConfig(name, config, paths, context = {}) {
  const handlers = Array.from(applyHandlers.get(name) || []);
  const errors = [];
  const extraRestart = new Set();
  for (const handler of handlers) {
    try {
      const result = await handler({
        name,
        config: clone(config),
        previousConfig: clone(runtimeConfigs.get(name) || {}),
        changedPaths: paths.slice(),
        ...context
      });
      for (const pathName of result?.restartRequiredPaths || []) extraRestart.add(pathName);
    } catch (error) {
      errors.push(safeError(error));
      paths.forEach(pathName => extraRestart.add(pathName));
    }
  }
  return { errors, restartRequiredPaths: Array.from(extraRestart) };
}

function commitAppliedConfig(name, config, paths = []) {
  let runtime = clone(runtimeConfigs.get(name) || {});
  for (const pathName of paths) runtime = setPath(runtime, pathName, getPath(config, pathName));
  runtimeConfigs.set(name, runtime);
  return clone(runtime);
}

function updateRestartStatus(name, desiredConfig, extraRestartPaths = []) {
  const info = registry.get(name);
  if (!info) return [];
  const baselineDiff = changedPaths(info.baseline, desiredConfig);
  const classified = classifyPaths(info, baselineDiff);
  const paths = new Set(classified.restart);
  for (const pathName of extraRestartPaths) paths.add(pathName);
  if (paths.size) restartRequired.set(name, paths);
  else restartRequired.delete(name);
  return Array.from(paths);
}

async function saveAndApplyConfig(name, data) {
  const info = registry.get(name);
  if (!info) {
    return { saved: false, section: name, config: {}, appliedPaths: [], restartRequiredPaths: [], errors: ['Unknown settings section'] };
  }
  const before = clone(runtimeConfigs.get(name) || info.baseline || {});
  writeConfig(name, data);
  const { config } = readConfig(name);
  const diff = changedPaths(before, config);
  const classified = classifyPaths(info, diff);
  const applied = await applyConfig(name, config, classified.live, { source: 'settings-ui' });
  const failed = new Set(applied.restartRequiredPaths);
  const appliedPaths = classified.live.filter(pathName => !failed.has(pathName));
  commitAppliedConfig(name, config, appliedPaths);
  const restartPaths = updateRestartStatus(name, config, [...classified.restart, ...failed]);
  return {
    saved: true,
    section: name,
    config,
    appliedPaths,
    restartRequiredPaths: restartPaths,
    errors: applied.errors
  };
}

function reportApplyFailure(name, paths = [], error) {
  const current = restartRequired.get(name) || new Set();
  paths.forEach(pathName => current.add(pathName));
  if (current.size) restartRequired.set(name, current);
  return { restartRequiredPaths: Array.from(current), error: safeError(error) };
}

function getRestartStatus() {
  return Array.from(restartRequired.entries()).map(([section, paths]) => ({
    section,
    paths: Array.from(paths)
  }));
}

module.exports = {
  register,
  setApplyPolicy,
  onApply,
  listConfigs,
  readConfig,
  writeConfig,
  saveAndApplyConfig,
  applyConfig,
  commitAppliedConfig,
  reportApplyFailure,
  getRestartStatus,
  changedPaths,
  classifyPaths
};
