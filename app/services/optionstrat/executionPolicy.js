function isOptionStratLike(value = {}) {
  const instrumentType = String(value.instrumentType || '').toUpperCase();
  const cardType = String(value.cardType || '').toLowerCase();
  const provider = String(value.provider || value.meta?.provider || '').toLowerCase();
  const event = String(value.event || '').toLowerCase();
  return instrumentType === 'OPT'
    || cardType === 'option'
    || cardType === 'optionstrat'
    || provider === 'optionstrat'
    || event === 'optionstrat';
}

function normalizeOptionStratPayload(payload = {}) {
  const symbol = String(payload.symbol || payload.ticker || '');
  return {
    instrumentType: 'OPT',
    symbol,
    ticker: symbol,
    root: payload.root,
    provider: payload.provider,
    event: payload.event,
    time: payload.time,
    cardType: payload.cardType,
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

function validateOptionStratOrder(order = {}) {
  const hasSymbol = !!String(order.symbol || order.ticker || '').trim();
  const hasLegs = Array.isArray(order.legs) && order.legs.length > 0;
  return hasSymbol && hasLegs
    ? { ok: true }
    : { ok: false, reason: 'OPT: ticker and legs required' };
}

function createOptionStratExecutionPolicy() {
  return {
    id: 'optionstrat',
    matchesPayload: isOptionStratLike,
    matchesOrder: isOptionStratLike,
    normalizePayload: normalizeOptionStratPayload,
    validateOrder: validateOptionStratOrder,
    executionOptions: () => ({
      requiresQuote: false,
      usesRiskSizing: false,
      usesTradeRules: false
    })
  };
}

module.exports = {
  createOptionStratExecutionPolicy,
  isOptionStratLike,
  normalizeOptionStratPayload,
  validateOptionStratOrder
};
