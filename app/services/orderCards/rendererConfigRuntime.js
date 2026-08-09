const DEFAULT_CARD_BUTTONS = [
  { label: 'BL', action: 'BL', style: 'bl' },
  { label: 'BC', action: 'BC', style: 'bc' },
  { label: 'BFB', action: 'BFB', style: 'bc' },
  { label: 'SL', action: 'SL', style: 'sl' },
  { label: 'SC', action: 'SC', style: 'sc' },
  { label: 'SFB', action: 'SFB', style: 'sc' }
];

function normalizeButton(button) {
  const normalized = Array.isArray(button)
    ? { label: button[0], action: button[1], style: button[2] }
    : button;
  if (!normalized || typeof normalized !== 'object') return null;
  if (!normalized.label || !normalized.action) return null;
  return {
    ...normalized,
    label: normalized.label,
    action: normalized.action
  };
}

function normalizeCardButtons(buttons) {
  const normalized = Array.isArray(buttons)
    ? buttons.map(normalizeButton).filter(Boolean)
    : [];
  return normalized.length
    ? normalized
    : DEFAULT_CARD_BUTTONS.map(button => ({ ...button }));
}

function createOrderCardsRendererConfigRuntime({
  loadConfig,
  settingsRuntime,
  env = process.env,
  render,
  onConfigApplied
} = {}) {
  let config = typeof loadConfig === 'function'
    ? loadConfig('../services/orderCards/config/order-cards.json')
    : {};
  const envInstrumentRefreshMs = Number(env?.INSTRUMENT_REFRESH_MS);
  const hasEnvInstrumentRefreshMs = Number.isFinite(envInstrumentRefreshMs);

  function currentInstrumentRefreshMs() {
    return hasEnvInstrumentRefreshMs
      ? envInstrumentRefreshMs
      : Number(config?.instrumentRefreshMs) || 1000;
  }

  const runtime = {
    shouldShowBidAsk: () => !!config?.showBidAsk,
    shouldShowSpread: () => !!config?.showSpread,
    getInstrumentRefreshMs: () => currentInstrumentRefreshMs(),
    getCardButtons: () => normalizeCardButtons(config?.buttons),
    getButtonRows: () => Number(config?.buttonRows) || 1,
    getClosedCardEventStrategy: () => config?.closedCardEventStrategy || 'ignore'
  };

  settingsRuntime?.onApply?.('order-cards', ({ config: nextConfig } = {}) => {
    config = nextConfig || {};
    onConfigApplied?.(runtime);
    render?.();
  });

  return runtime;
}

module.exports = {
  createOrderCardsRendererConfigRuntime,
  normalizeCardButtons,
  DEFAULT_CARD_BUTTONS
};
