const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');
const { createOrderCardService, createOrderCardsApplicationService } = require('./index');
const { createOrderCardsRenderer } = require('./renderer');
const { createLegacyOrderListRuntime } = require('./legacyOrderListRuntime');
const { registerOrderCardsIpcHandlers } = require('./infrastructure/ipc');

settings.register(
  'order-cards',
  path.join(__dirname, 'config', 'order-cards.json'),
  path.join(__dirname, 'config', 'order-cards-settings-descriptor.json')
);

const rendererHandlers = [{
  cardType: 'regular',
  register(context = {}) {
    const orderCardsRenderer = createOrderCardsRenderer(context.orderCardsDeps || {});
    const legacyOrderListRuntime = createLegacyOrderListRuntime({
      ...(context.legacyOrderListDeps || {}),
      matchesExistingOrderRow: (...args) => orderCardsRenderer.matchesExistingRow(...args),
      orderCardHandlerForRow: (...args) => orderCardsRenderer.handlerFor(...args),
      orderCardHandlerForKey: (...args) => orderCardsRenderer.handlerForKey(...args),
      scheduleOrderCardInstantExecution: (...args) => orderCardsRenderer.scheduleInstantExecution(...args)
    });
    context.registerLegacyOrderCardsRuntime?.({
      runtime: legacyOrderListRuntime,
      createCard: (row, index) => orderCardsRenderer.createLegacyOrderCard({ row, index }),
      registerInstrumentHandler: (...args) => orderCardsRenderer.registerInstrumentHandler(...args),
      registerCardTypeHandler: (...args) => orderCardsRenderer.registerCardTypeHandler(...args),
      handlerFor: (...args) => orderCardsRenderer.handlerFor(...args),
      handlerForKey: (...args) => orderCardsRenderer.handlerForKey(...args),
      matchesExistingRow: (...args) => orderCardsRenderer.matchesExistingRow(...args),
      scheduleInstantExecution: (...args) => orderCardsRenderer.scheduleInstantExecution(...args),
      place: (...args) => orderCardsRenderer.place(...args),
      instrumentTypeHandlers: orderCardsRenderer.instrumentTypeHandlers,
      cardTypeHandlers: orderCardsRenderer.cardTypeHandlers
    });

    const {
      positionKey,
      positionCardTitle,
      btn,
      dispatchPositionAction,
      requestRemovePosition
    } = context;
    if (!orderCardsRenderer?.createRegularPositionCard) return;
    context.registerPositionCardRenderer?.('regular', (position) => {
      return orderCardsRenderer.createRegularPositionCard({
        position,
        key: positionKey(position),
        title: positionCardTitle(position),
        createActionButton: ({ label, kind, className, onClick }) => {
          const button = btn(label, className, onClick);
          button.dataset.kind = kind;
          return button;
        },
        dispatchPositionAction,
        requestRemove: requestRemovePosition
      });
    });
  }
}];

function resolveWebhookPort(candidate, fallback) {
  const num = Number(candidate);
  if (!Number.isFinite(num)) return fallback;
  const port = Math.trunc(num);
  if (port <= 0 || port > 65535) return fallback;
  return port;
}

function normalizeSourceConfig(src) {
  const normalized = (src && typeof src === 'object' && !Array.isArray(src))
    ? src
    : { type: typeof src === 'string' ? src : 'webhook' };
  return {
    ...normalized,
    type: normalized.type || 'webhook'
  };
}

function registerMainApplicationServices(context = {}) {
  const { servicesApi = {} } = context;
  if (servicesApi.orderCards) return servicesApi.orderCards;

  const config = context.orderCardsConfig || loadConfig('../services/orderCards/config/order-cards.json');
  const sourcesCfg = Array.isArray(config?.sources) && config.sources.length
    ? config.sources
    : [{ type: 'webhook' }];
  const sourceServices = [];
  let applicationService;

  for (const src of sourcesCfg) {
    const normalized = normalizeSourceConfig(src);
    const type = normalized.type;
    const opts = {
      ...normalized,
      type,
      nowTs: context.nowTs,
      onRow(row) {
        applicationService?.ingestRow?.(row, { source: type });
      }
    };
    if (type === 'webhook') {
      opts.port = resolveWebhookPort(normalized.port, context.defaultWebhookPort);
      opts.logFile = path.join(context.logDir || '.', normalized.logFile || 'webhooks.jsonl');
      opts.truncateOnStart = normalized.truncateOnStart ?? true;
    }
    sourceServices.push(createOrderCardService(opts));
  }

  applicationService = createOrderCardsApplicationService({
    positions: context.positions || servicesApi.positions,
    resolveProviderName: context.resolveProviderName,
    getSourceServices: () => sourceServices,
    publish: context.publish || context.sendToRenderer
  });
  servicesApi.orderCards = applicationService;

  for (const service of sourceServices) {
    service?.start?.();
  }

  return applicationService;
}

function initService() {}

function registerMainIpcHandlers({ ipcMain, servicesApi } = {}) {
  registerOrderCardsIpcHandlers({ ipcMain, servicesApi });
}

module.exports = { initService, rendererHandlers, registerMainApplicationServices, registerMainIpcHandlers };
