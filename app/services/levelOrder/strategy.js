function finiteNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundQty(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(10));
}

function normalizeMinLot(value) {
  const n = finiteNumber(value, 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

const PRICE_SOURCES = new Set(['bid', 'ask', 'mid']);

function normalizePriceSource(value, fallback) {
  const source = String(value || '').trim().toLowerCase();
  return PRICE_SOURCES.has(source) ? source : fallback;
}

function quoteRequiredReason(source) {
  if (source === 'ask') return 'Ask quote required';
  if (source === 'mid') return 'Bid/Ask quote required';
  return 'Bid quote required';
}

function resolveQuotePrice({ bid, ask, source }) {
  const bidPrice = finiteNumber(bid);
  const askPrice = finiteNumber(ask);
  if (source === 'ask') {
    return Number.isFinite(askPrice) && askPrice > 0
      ? { ok: true, price: askPrice, bid: bidPrice, ask: askPrice }
      : { ok: false, reason: quoteRequiredReason(source) };
  }
  if (source === 'mid') {
    return Number.isFinite(bidPrice) && bidPrice > 0 && Number.isFinite(askPrice) && askPrice > 0
      ? { ok: true, price: (bidPrice + askPrice) / 2, bid: bidPrice, ask: askPrice }
      : { ok: false, reason: quoteRequiredReason(source) };
  }
  return Number.isFinite(bidPrice) && bidPrice > 0
    ? { ok: true, price: bidPrice, bid: bidPrice, ask: askPrice }
    : { ok: false, reason: quoteRequiredReason(source) };
}

function roundQtyToStep(value, minLot = 1) {
  const qty = Number(value);
  const step = normalizeMinLot(minLot);
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  const units = Math.floor((qty + step * 1e-9) / step);
  return roundQty(units * step);
}

function resolveLevelOrderDefaults(config = {}, ticker) {
  const defaults = config.defaults || {};
  const normalizedTicker = String(ticker || '').trim().toUpperCase();
  const override = Array.isArray(config.symbols)
    ? config.symbols.find(item => String(item?.ticker || '').trim().toUpperCase() === normalizedTicker)
    : null;
  return {
    maxLot: finiteNumber(override?.maxLot, finiteNumber(defaults.maxLot, 0)),
    minLot: normalizeMinLot(finiteNumber(override?.minLot, finiteNumber(defaults.minLot, 1))),
    stopOffsetPts: finiteNumber(override?.stopOffsetPts, finiteNumber(defaults.stopOffsetPts, null)),
    takeProfitPts: finiteNumber(override?.takeProfitPts, finiteNumber(defaults.takeProfitPts, null)),
    buyPriceSource: normalizePriceSource(override?.buyPriceSource, normalizePriceSource(defaults.buyPriceSource, 'bid')),
    sellPriceSource: normalizePriceSource(override?.sellPriceSource, normalizePriceSource(defaults.sellPriceSource, 'bid'))
  };
}

function splitQuantity(totalQty, maxLot, instrumentType, minLot = 1) {
  const total = roundQtyToStep(totalQty, minLot);
  const max = Number(maxLot);
  if (!Number.isFinite(total) || total <= 0) return [];
  if (!Number.isFinite(max) || max <= 0 || max >= total) return [total];

  const cap = roundQtyToStep(max, minLot);
  if (!Number.isFinite(cap) || cap <= 0) return [total];

  const parts = [];
  let remaining = total;
  while (remaining > cap) {
    parts.push(cap);
    remaining = roundQty(remaining - cap);
  }
  if (remaining > 0) parts.push(roundQtyToStep(remaining, minLot));
  return parts.filter(q => Number.isFinite(q) && q > 0);
}

function calculateLimitBidTradePlan({
  action,
  ticker,
  instrumentType,
  level,
  riskUsd,
  stopOffsetPts,
  maxLot,
  minLot = 1,
  takeProfitPts,
  bid,
  ask,
  buyPriceSource,
  sellPriceSource,
  tickSize,
  lot = 1,
  orderCalculator
} = {}) {
  const sideAction = String(action || '').toUpperCase();
  if (sideAction !== 'LB' && sideAction !== 'LS') {
    return { ok: false, reason: 'Unsupported level order action' };
  }

  const lvl = finiteNumber(level);
  const tick = finiteNumber(tickSize);
  const risk = finiteNumber(riskUsd);
  const offset = finiteNumber(stopOffsetPts);
  const qtyStep = normalizeMinLot(minLot);
  if (!Number.isFinite(lvl) || lvl <= 0) return { ok: false, reason: 'Level > 0 required' };
  if (!Number.isFinite(tick) || tick <= 0) return { ok: false, reason: 'Tick size required' };
  if (!Number.isFinite(risk) || risk <= 0) return { ok: false, reason: 'Risk $ > 0 required' };
  if (!Number.isFinite(offset) || offset <= 0) return { ok: false, reason: 'Stop offset pts > 0 required' };

  const isBuy = sideAction === 'LB';
  const priceSource = isBuy
    ? normalizePriceSource(buyPriceSource, 'bid')
    : normalizePriceSource(sellPriceSource, 'bid');
  const quotePrice = resolveQuotePrice({ bid, ask, source: priceSource });
  if (!quotePrice.ok) return quotePrice;
  const referencePrice = quotePrice.price;

  if (isBuy && referencePrice < lvl) return { ok: false, reason: `Cannot buy when ${priceSource} is below level` };
  if (!isBuy && referencePrice > lvl) return { ok: false, reason: `Cannot sell when ${priceSource} is above level` };

  const levelDistancePts = Math.abs(referencePrice - lvl) / tick;
  const stopPts = levelDistancePts + offset;
  const stopPrice = isBuy ? lvl - offset * tick : lvl + offset * tick;
  const qty = orderCalculator.qty({
    riskUsd: risk,
    stopPts,
    tickSize: tick,
    lot,
    instrumentType,
    quantityStep: qtyStep
  });
  const childQtys = splitQuantity(qty, maxLot, instrumentType, qtyStep);
  if (!childQtys.length) return { ok: false, reason: 'Calculated quantity is 0' };

  const tp = finiteNumber(takeProfitPts);
  return {
    ok: true,
    ticker,
    action: sideAction,
    orderKind: isBuy ? 'BL' : 'SL',
    orderSide: isBuy ? 'buy' : 'sell',
    level: lvl,
    bid: quotePrice.bid,
    ask: quotePrice.ask,
    priceSource,
    referencePrice,
    tickSize: tick,
    riskUsd: risk,
    stopOffsetPts: offset,
    minLot: qtyStep,
    levelDistancePts,
    stopPts,
    stopPrice,
    takeProfitPts: Number.isFinite(tp) && tp > 0 ? tp : null,
    totalQty: qty,
    childQtys
  };
}

module.exports = {
  resolveLevelOrderDefaults,
  normalizePriceSource,
  resolveQuotePrice,
  quoteRequiredReason,
  splitQuantity,
  roundQtyToStep,
  calculateLimitBidTradePlan
};
