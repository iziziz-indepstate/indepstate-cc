const { isOptionStratLike } = require('./executionPolicy');

function signedOptionLegQty(leg) {
  const qty = Math.abs(Number(leg?.quantity ?? leg?.qty ?? 0));
  const side = String(leg?.side || '').toLowerCase();
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  return side === 'sell' || side === 'short' ? -qty : qty;
}

function optionLegToken(leg) {
  if (!leg || typeof leg !== 'object') return '';
  const qty = signedOptionLegQty(leg);
  if (!qty) return '';
  const optionCode = String(leg.option || '').toUpperCase().startsWith('P') ? 'P' : 'C';
  const strike = leg.strike ?? leg.price ?? '';
  return `${qty > 0 ? '+' : '-'}${Math.abs(qty)}${optionCode}${strike}`;
}

function formatOptionLegs(legs) {
  if (!Array.isArray(legs)) return '';
  return legs.map(optionLegToken).filter(Boolean).join('/');
}

function formatOptionLegPair(legs) {
  if (!Array.isArray(legs)) return '';
  return legs.map(leg => leg && typeof leg === 'object' ? leg.strike ?? leg.price ?? '' : '').filter(v => v !== '').join('/');
}

function parseOptionSymbol(symbol) {
  const match = String(symbol || '').match(/([CP])(\d+(?:\.\d+)?)$/i);
  if (!match) return {};
  return {
    option: match[1].toUpperCase() === 'P' ? 'PUT' : 'CALL',
    strike: Number(match[2])
  };
}

function finiteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function formatOptionPrice(value) {
  const num = finiteNumber(value);
  return num == null ? '' : num.toFixed(2);
}

function formatOptionNetPrice(value) {
  const num = finiteNumber(value);
  return num == null ? undefined : Number(num.toFixed(4));
}

function optionLegPriceToken(leg, priceKey) {
  if (!leg || typeof leg !== 'object') return '';
  const qty = finiteNumber(leg.quantity);
  const price = finiteNumber(leg[priceKey]);
  if (!qty || price == null) return '';
  const optionCode = String(leg.option || '').toUpperCase().startsWith('P') ? 'P' : 'C';
  const strike = leg.strike ?? '';
  return `${qty > 0 ? '+' : '-'}${Math.abs(qty)}${optionCode}${strike}@${formatOptionPrice(price)}`;
}

function formatOptionLegPrices(legs, priceKey) {
  if (!Array.isArray(legs)) return '';
  return legs.map(leg => optionLegPriceToken(leg, priceKey)).filter(Boolean).join('/');
}

function netOptionLegPrice(legs, priceKey) {
  if (!Array.isArray(legs) || !legs.length) return undefined;
  let seenPrice = false;
  let total = 0;
  for (const leg of legs) {
    const qty = finiteNumber(leg?.quantity);
    const price = finiteNumber(leg?.[priceKey]);
    if (!qty || price == null) continue;
    seenPrice = true;
    total += qty * price;
  }
  return seenPrice ? formatOptionNetPrice(total) : undefined;
}

function normalizeOpenOptionLegs(result) {
  if (result?.status !== 'ok') return [];
  const items = Array.isArray(result?.raw?.strategy?.items) ? result.raw.strategy.items : [];
  return items.map((item) => {
    const parsed = parseOptionSymbol(item?.symbol);
    const basis = finiteNumber(item?.basis);
    const quantity = finiteNumber(item?.quantity);
    if (!item?.symbol || basis == null || !quantity) return null;
    return {
      symbol: item.symbol,
      option: parsed.option,
      strike: parsed.strike,
      quantity,
      basis
    };
  }).filter(Boolean);
}

function normalizeCloseOptionLegs(result) {
  if (result?.status !== 'ok') return [];
  const rawItems = Array.isArray(result?.raw?.strategy?.items) ? result.raw.strategy.items : [];
  const valuationLegs = Array.isArray(result?.valuation?.legs) ? result.valuation.legs : [];
  const valuationBySymbol = new Map(valuationLegs.map(leg => [String(leg?.symbol || ''), leg]));
  const sourceItems = rawItems.length ? rawItems : valuationLegs;
  return sourceItems.map((item) => {
    const symbol = item?.symbol;
    const valuation = valuationBySymbol.get(String(symbol || '')) || {};
    const parsed = parseOptionSymbol(symbol);
    const basis = finiteNumber(item?.basis ?? valuation.basis);
    const quantity = finiteNumber(item?.quantity ?? valuation.quantity);
    const current = finiteNumber(valuation.current ?? item?.current);
    const close = finiteNumber(item?.close);
    if (!symbol || basis == null || !quantity || (current == null && close == null)) return null;
    return {
      symbol,
      option: parsed.option,
      strike: parsed.strike,
      quantity,
      basis,
      current,
      close
    };
  }).filter(Boolean);
}

function isOptionLifecyclePayload(payload = {}, enriched = {}) {
  return [
    payload,
    payload.order,
    payload.origOrder,
    payload.result,
    enriched
  ].some(value => value && typeof value === 'object' && isOptionStratLike(value));
}

function createOptionStratLifecycleEnricher() {
  return function optionStratLifecycleEnricher({ eventName, payload = {}, enriched = {} } = {}) {
    if (!isOptionLifecyclePayload(payload, enriched)) return null;

    const extra = {};
    if (Array.isArray(enriched.legs)) {
      extra.legsText = formatOptionLegs(enriched.legs);
      extra.legsPair = formatOptionLegPair(enriched.legs);
    }

    const result = payload.result && typeof payload.result === 'object' ? payload.result : {};
    const openLegs = eventName === 'order:placed' ? normalizeOpenOptionLegs(result) : [];
    if (openLegs.length) {
      extra.optionOpenLegs = openLegs;
      extra.optionOpenLegsText = formatOptionLegPrices(openLegs, 'basis');
      extra.optionOpenNetPrice = netOptionLegPrice(openLegs, 'basis');
    }

    const closeLegs = eventName === 'order:closed' ? normalizeCloseOptionLegs(result) : [];
    if (closeLegs.length) {
      extra.optionCloseLegs = closeLegs;
      extra.optionCloseLegsText = formatOptionLegPrices(closeLegs, 'close') || formatOptionLegPrices(closeLegs, 'current');
      extra.optionCloseNetPrice = netOptionLegPrice(closeLegs, closeLegs.some(leg => leg.close != null) ? 'close' : 'current');
      const pnl = finiteNumber(result?.valuation?.change);
      if (pnl != null) extra.optionPnl = pnl;
    }

    return extra;
  };
}

module.exports = {
  createOptionStratLifecycleEnricher,
  formatOptionLegs,
  formatOptionLegPair,
  normalizeOpenOptionLegs,
  normalizeCloseOptionLegs
};
