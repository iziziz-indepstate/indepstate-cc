const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');
const events = require('../events');
const { createOutboundWebhooksService } = require('.');
const { WebhookCommand } = require('./command');

settings.register(
  'outbound-webhooks',
  path.join(__dirname, 'config', 'outbound-webhooks.json'),
  path.join(__dirname, 'config', 'outbound-webhooks-settings-descriptor.json')
);

const LIFECYCLE_EVENTS = [
  'order:placed',
  'order:closed',
  'position:opened',
  'position:closed',
  'order:cancelled',
  'execution:order-message'
];

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

function firstValue(...values) {
  for (const value of values) {
    if (value != null && value !== '') return value;
  }
  return undefined;
}

function enrichLifecyclePayload(eventName, payload) {
  const base = payload && typeof payload === 'object' ? payload : {};
  const order = base.order && typeof base.order === 'object' ? base.order : {};
  const origOrder = base.origOrder && typeof base.origOrder === 'object' ? base.origOrder : {};
  const result = base.result && typeof base.result === 'object' ? base.result : {};
  const trade = base.trade && typeof base.trade === 'object' ? base.trade : {};
  const meta = order.meta && typeof order.meta === 'object' ? order.meta : {};
  const origMeta = origOrder.meta && typeof origOrder.meta === 'object' ? origOrder.meta : {};
  const legs = firstValue(base.legs, order.legs, order.legsLabel, order.name, origOrder.legs, origOrder.legsLabel, origOrder.name);
  const out = {
    event: eventName,
    cardId: firstValue(base.cardId, base.cid, result.cid, order.cid, meta.cid, meta.requestId, origOrder.cid, origMeta.cid, origMeta.requestId, base.ticket),
    cid: firstValue(base.cid, result.cid, order.cid, meta.cid, origOrder.cid, origMeta.cid),
    symbol: firstValue(base.symbol, order.symbol, order.ticker, origOrder.symbol, origOrder.ticker, trade.symbol),
    legs,
    legsText: formatOptionLegs(legs),
    legsPair: formatOptionLegPair(legs),
    qty: firstValue(base.qty, order.qty, order.quantity, order.size, origOrder.qty, origOrder.quantity, origOrder.size),
    price: firstValue(base.price, order.price, order.fillPrice, order.entryPrice, origOrder.price, origOrder.fillPrice, trade.price, trade.closePrice),
    ...base
  };
  const openLegs = eventName === 'order:placed' ? normalizeOpenOptionLegs(result) : [];
  if (openLegs.length) {
    out.optionOpenLegs = openLegs;
    out.optionOpenLegsText = formatOptionLegPrices(openLegs, 'basis');
    out.optionOpenNetPrice = netOptionLegPrice(openLegs, 'basis');
  }
  const closeLegs = eventName === 'order:closed' ? normalizeCloseOptionLegs(result) : [];
  if (closeLegs.length) {
    out.optionCloseLegs = closeLegs;
    out.optionCloseLegsText = formatOptionLegPrices(closeLegs, 'close') || formatOptionLegPrices(closeLegs, 'current');
    out.optionCloseNetPrice = netOptionLegPrice(closeLegs, closeLegs.some(leg => leg.close != null) ? 'close' : 'current');
    const pnl = finiteNumber(result?.valuation?.change);
    if (pnl != null) out.optionPnl = pnl;
  }
  return out;
}

function bridgeLifecycleEvents(actionBus) {
  if (!actionBus || typeof actionBus.emit !== 'function') return;
  if (actionBus.__outboundWebhooksLifecycleBridge) return;
  actionBus.__outboundWebhooksLifecycleBridge = true;
  for (const eventName of LIFECYCLE_EVENTS) {
    events.on(eventName, payload => actionBus.emit(eventName, enrichLifecyclePayload(eventName, payload)));
  }
}

function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('../services/outboundWebhooks/config/outbound-webhooks.json');
  } catch {
    cfg = {};
  }

  const sender = createOutboundWebhooksService(cfg);
  servicesApi.outboundWebhooks = sender;
  settings.onApply('outbound-webhooks', ({ config }) => {
    sender.config = config || {};
  });

  if (servicesApi.actionBus) {
    bridgeLifecycleEvents(servicesApi.actionBus);
    if (typeof servicesApi.actionBus.registerCommandRunner === 'function') {
      servicesApi.actionBus.registerCommandRunner('webhook', (cmd, entry, payload) => sender.runAction(cmd, entry, payload));
    }
  }

  if (!Array.isArray(servicesApi.commands)) servicesApi.commands = [];
  servicesApi.commands.push(new WebhookCommand({ sender }));
}

module.exports = { initService, bridgeLifecycleEvents, enrichLifecyclePayload, formatOptionLegs, formatOptionLegPair };
