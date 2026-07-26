const crypto = require('crypto');
const { normalizeOrderQty, isValidOrderQty } = require('../../services/executionQuantity');

const CID_IN_COMMENT_RE = /cid[:=]\s*([a-z0-9]+)/i;

function normalizeCid(candidate) {
  if (candidate == null) return '';
  let str = String(candidate).trim();
  if (!str) return '';
  const cidMatch = str.match(CID_IN_COMMENT_RE);
  if (cidMatch) return cidMatch[1];
  if (str.startsWith('pending:')) return str.slice('pending:'.length);
  return str;
}

function generateCid() {
  return crypto.randomBytes(6).toString('hex');
}

function ensureCommentHasCid(comment, cid) {
  const base = comment == null ? '' : String(comment).trim();
  if (!cid) return base;
  if (base.includes(cid)) return base;
  if (CID_IN_COMMENT_RE.test(base)) {
    return base.replace(CID_IN_COMMENT_RE, `cid:${cid}`);
  }
  return base ? `${base} | cid:${cid}` : `cid:${cid}`;
}

function ensureOrderCid(order) {
  if (!order || typeof order !== 'object') return '';
  if (!order.meta) order.meta = {};
  const candidates = [order.meta.cid, order.clientOrderId, order.cid];
  let cid = '';
  for (const candidate of candidates) {
    const normalized = normalizeCid(candidate);
    if (normalized) {
      cid = normalized;
      break;
    }
  }
  if (!cid) cid = generateCid();
  order.meta.cid = cid;
  if (!normalizeCid(order.clientOrderId)) {
    order.clientOrderId = cid;
  }
  order.comment = ensureCommentHasCid(order.comment, cid);
  return cid;
}

function normalizeOrderPayload(payload) {
  if (payload?.instrumentType === 'OPT') {
    const symbol = String(payload.symbol || payload.ticker || '');
    return {
      instrumentType: 'OPT',
      symbol,
      ticker: symbol,
      root: payload.root,
      provider: payload.provider,
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
  const legacy = payload && payload.ticker && payload.meta;
  if (legacy) {
    const symbol = String(payload.ticker || '');
    const instrumentType = payload.instrumentType;
    const comment = payload.comment ?? payload.meta?.comment;
    return {
      instrumentType,
      symbol,
      provider: payload.provider || payload.meta?.provider,
      side: payload.kind,
      type: payload.type,
      tickSize: payload.tickSize,
      qty: normalizeOrderQty(payload.meta.qty, instrumentType, payload.meta),
      price: Number(payload.price || 0),
      sl: Number(payload.meta.stopPts || 0),
      tp: payload.meta.takePts == null ? undefined : Number(payload.meta.takePts),
      comment: comment == null ? undefined : String(comment),
      meta: payload.meta || {}
    };
  }

  const symbol = String(payload.symbol || payload.ticker || '');
  const instrumentType = payload.instrumentType;
  const comment = payload.comment ?? payload.meta?.comment;
  const isHedgeMarket = payload?.meta?.hedge === true && String(payload.type || '').toLowerCase() === 'market';
  return {
    instrumentType,
    symbol,
    provider: payload.provider || payload.meta?.provider,
    side: payload.side || payload.action,
    type: payload.type,
    tickSize: payload.tickSize,
    qty: normalizeOrderQty(payload.qty, instrumentType, payload.meta),
    price: isHedgeMarket ? undefined : Number(payload.price || 0),
    sl: isHedgeMarket ? undefined : Number(payload.sl || 0),
    tp: isHedgeMarket || payload.tp === '' || payload.tp == null ? undefined : Number(payload.tp),
    comment: comment == null ? undefined : String(comment),
    meta: payload.meta || {}
  };
}

function validateOrder(order) {
  if (order.instrumentType === 'OPT') {
    const hasSymbol = !!String(order.symbol || order.ticker || '').trim();
    const hasLegs = Array.isArray(order.legs) && order.legs.length > 0;
    return hasSymbol && hasLegs
      ? { ok: true }
      : { ok: false, reason: 'OPT: ticker and legs required' };
  }
  if (order.instrumentType === 'CX') {
    const riskUsd = Number(order.meta?.riskUsd);
    const hasRiskSizing = Number.isFinite(riskUsd) && riskUsd > 0;
    const hasManualQty = Number(order.qty) > 0;
    const ok = Number(order.price) > 0 && Number(order.sl) > 0 && (hasManualQty || hasRiskSizing);
    return ok ? { ok: true } : { ok: false, reason: 'CX: price>0, sl>0 and qty>0 or riskUsd>0 required' };
  }
  if (order.instrumentType === 'FX') {
    const ok = (order.meta?.riskUsd > 0) && order.sl > 0 && order.price > 0 && order.qty > 0;
    return ok ? { ok: true } : { ok: false, reason: 'FX: riskUsd>0, sl>0, price>0, qty>0 required' };
  }
  const isHedge = order.meta?.hedge === true;
  const type = String(order.type || '').toLowerCase();
  const needsPrice = type !== 'market';
  const hasPrice = Number(order.price) > 0 || !needsPrice;
  const hasQty = isValidOrderQty(order.qty, order.instrumentType, order.meta);
  const hasRiskShape = (order.meta?.riskUsd > 0) && order.sl > 0 && Number(order.price) > 0;
  const ok = hasQty && (isHedge ? hasPrice : hasRiskShape);
  return ok ? { ok: true } : { ok: false, reason: 'EQ: riskUsd>0, sl>0, price>0, valid qty required (or hedge qty with price/market)' };
}

function normalizeQuoteForValidation(quote) {
  if (!quote || typeof quote !== 'object') return quote;
  if (Number.isFinite(Number(quote.price))) return quote;
  const bid = Number(quote.bid);
  const ask = Number(quote.ask);
  if (Number.isFinite(bid) && Number.isFinite(ask)) return { ...quote, price: (bid + ask) / 2 };
  if (Number.isFinite(bid)) return { ...quote, price: bid };
  if (Number.isFinite(ask)) return { ...quote, price: ask };
  return quote;
}

function normalizeEquityOrderForExecution(order) {
  if (!['EQ', 'FX', 'CX'].includes(String(order.instrumentType))) return order;

  const action = String(order.side || '').toUpperCase();
  const alreadySide = String(order.side || '').toLowerCase();
  if (alreadySide === 'buy' || alreadySide === 'sell') {
    const type = String(order.type || 'limit').toLowerCase();
    const norm = { ...order, side: alreadySide, type };
    if ((type === 'limit' || type === 'stoplimit') && Number.isFinite(Number(order.price))) {
      norm.limitPrice = Number(order.price);
    }
    if ((type === 'stop' || type === 'stoplimit') && Number.isFinite(Number(order.price))) {
      norm.stopPrice = Number(order.price);
    }
    return norm;
  }

  let side, type, limitPrice, stopPrice;
  switch (action) {
    case 'BL':
      side = 'buy'; type = 'limit'; limitPrice = Number(order.price); break;
    case 'SL':
      side = 'sell'; type = 'limit'; limitPrice = Number(order.price); break;
    case 'BSL':
      side = 'buy'; type = 'stoplimit'; stopPrice = Number(order.price); limitPrice = Number(order.price); break;
    case 'SSL':
      side = 'sell'; type = 'stoplimit'; stopPrice = Number(order.price); limitPrice = Number(order.price); break;
    default:
      return order;
  }

  const norm = { ...order, side, type };
  if (type === 'limit' || type === 'stoplimit') norm.limitPrice = limitPrice;
  if (type === 'stop' || type === 'stoplimit') norm.stopPrice = stopPrice;
  return norm;
}

module.exports = {
  CID_IN_COMMENT_RE,
  normalizeCid,
  generateCid,
  ensureCommentHasCid,
  ensureOrderCid,
  normalizeOrderPayload,
  validateOrder,
  normalizeQuoteForValidation,
  normalizeEquityOrderForExecution
};
