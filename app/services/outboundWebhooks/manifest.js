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

const lifecycleEnrichers = [];

function registerLifecycleEnricher(enricher) {
  if (typeof enricher !== 'function') return () => {};
  lifecycleEnrichers.push(enricher);
  return () => {
    const index = lifecycleEnrichers.indexOf(enricher);
    if (index >= 0) lifecycleEnrichers.splice(index, 1);
  };
}

function resetLifecycleEnrichers() {
  lifecycleEnrichers.length = 0;
}

function firstValue(...values) {
  for (const value of values) {
    if (value != null && value !== '') return value;
  }
  return undefined;
}

function enrichLifecyclePayload(eventName, payload, opts = {}) {
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
    qty: firstValue(base.qty, order.qty, order.quantity, order.size, origOrder.qty, origOrder.quantity, origOrder.size),
    price: firstValue(base.price, order.price, order.fillPrice, order.entryPrice, origOrder.price, origOrder.fillPrice, trade.price, trade.closePrice),
    ...base
  };
  for (const enricher of lifecycleEnrichers) {
    try {
      const patch = enricher({ eventName, payload: base, enriched: out });
      if (patch && typeof patch === 'object') Object.assign(out, patch);
    } catch (err) {
      const logger = opts.logger || console;
      logger?.error?.('[outbound-webhooks] lifecycle enricher failed', err);
    }
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
  sender.registerLifecycleEnricher = registerLifecycleEnricher;
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

module.exports = {
  initService,
  bridgeLifecycleEvents,
  enrichLifecyclePayload,
  registerLifecycleEnricher,
  resetLifecycleEnrichers
};
