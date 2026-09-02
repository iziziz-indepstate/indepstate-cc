const NEAREST_TRACKED_LEVEL_PLACEHOLDER = 'nearestTrackedLevel';

const PLACEHOLDER_PROVIDERS = {
  [NEAREST_TRACKED_LEVEL_PLACEHOLDER]: 'levelTrack'
};

function parseLevelNumber(value) {
  const n = Number(String(value ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function normalizeLevelPlaceholder(value) {
  const raw = String(value ?? '').trim();
  return raw === NEAREST_TRACKED_LEVEL_PLACEHOLDER ? raw : null;
}

function createLevelProviderRegistry() {
  const providers = new Map();

  return {
    registerLevelProvider(name, provider) {
      const key = String(name || '').trim();
      if (!key || !provider || typeof provider.resolveLevel !== 'function') return false;
      providers.set(key, provider);
      return () => providers.delete(key);
    },
    getLevelProvider(name) {
      return providers.get(String(name || '').trim());
    }
  };
}

async function resolveLevelInput(levelRaw, {
  ticker,
  action,
  servicesApi = {},
  context = {}
} = {}) {
  const numeric = parseLevelNumber(levelRaw);
  if (Number.isFinite(numeric) && numeric > 0) {
    return { ok: true, level: numeric, source: { kind: 'numeric' } };
  }

  const placeholder = normalizeLevelPlaceholder(levelRaw);
  if (!placeholder) return { ok: false, error: 'Level > 0 required' };

  const providerName = PLACEHOLDER_PROVIDERS[placeholder];
  const provider = servicesApi.levelOrder?.getLevelProvider?.(providerName);
  if (!provider || typeof provider.resolveLevel !== 'function') {
    return { ok: false, error: `Level provider is not registered: ${providerName}` };
  }

  const result = await provider.resolveLevel({ ticker, action, placeholder, context });
  if (!result || result.ok === false) {
    return {
      ok: false,
      error: result?.error || `No level from provider ${providerName} for ${placeholder}`,
      source: result?.source || { kind: 'placeholder', placeholder, provider: providerName }
    };
  }

  const level = parseLevelNumber(result.level);
  if (!Number.isFinite(level) || level <= 0) {
    return { ok: false, error: `Provider ${providerName} returned invalid level` };
  }
  return {
    ok: true,
    level,
    source: {
      kind: 'placeholder',
      placeholder,
      provider: providerName,
      ...(result.source || {})
    }
  };
}

module.exports = {
  NEAREST_TRACKED_LEVEL_PLACEHOLDER,
  createLevelProviderRegistry,
  normalizeLevelPlaceholder,
  parseLevelNumber,
  resolveLevelInput
};
