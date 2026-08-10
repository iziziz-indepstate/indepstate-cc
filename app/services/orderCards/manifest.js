const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');
const { createOrderCardsRenderer } = require('./renderer');
const { createOrderCardsRendererConfigRuntime } = require('./rendererConfigRuntime');
const { createLegacyOrderListRuntime } = require('./legacyOrderListRuntime');
const { registerOrderCardsIpcHandlers } = require('./infrastructure/ipc');
const { AddCommand } = require('../commands/add');
const { RemoveCommand } = require('../commands/remove');

settings.register(
  'order-cards',
  path.join(__dirname, 'config', 'order-cards.json'),
  path.join(__dirname, 'config', 'order-cards-settings-descriptor.json')
);

const rendererHandlers = [{
  cardType: 'regular',
  register(context = {}) {
    let legacyOrderListRuntime;
    const orderCardsRuntime = createOrderCardsRendererConfigRuntime({
      loadConfig: context.loadConfig || loadConfig,
      settingsRuntime: context.settingsRuntime,
      env: context.env || process.env,
      render: context.render,
      onConfigApplied: (runtime) => {
        legacyOrderListRuntime?.setClosedCardEventStrategy(runtime.getClosedCardEventStrategy());
      }
    });
    context.registerInstrumentDisplayPolicy?.({
      getInstrumentRefreshMs: () => orderCardsRuntime.getInstrumentRefreshMs(),
      shouldShowBidAsk: () => orderCardsRuntime.shouldShowBidAsk(),
      shouldShowSpread: () => orderCardsRuntime.shouldShowSpread()
    });
    context.registerCardStateHook?.(({ card, updateSpreadForTicker }) => {
      if (orderCardsRuntime.shouldShowSpread()) updateSpreadForTicker?.(card?.dataset?.ticker);
    });
    const orderCardsRenderer = createOrderCardsRenderer({
      ...(context.orderCardsDeps || {}),
      shouldShowBidAsk: () => orderCardsRuntime.shouldShowBidAsk(),
      shouldShowSpread: () => orderCardsRuntime.shouldShowSpread(),
      getCardButtons: () => orderCardsRuntime.getCardButtons(),
      getButtonRows: () => orderCardsRuntime.getButtonRows()
    });
    legacyOrderListRuntime = createLegacyOrderListRuntime({
      ...(context.legacyOrderListDeps || {}),
      matchesExistingOrderRow: (...args) => orderCardsRenderer.matchesExistingRow(...args),
      orderCardHandlerForRow: (...args) => orderCardsRenderer.handlerFor(...args),
      orderCardHandlerForKey: (...args) => orderCardsRenderer.handlerForKey(...args),
      scheduleOrderCardInstantExecution: (...args) => orderCardsRenderer.scheduleInstantExecution(...args)
    });
    legacyOrderListRuntime?.setClosedCardEventStrategy?.(orderCardsRuntime.getClosedCardEventStrategy?.() || 'ignore');
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
      orderCardsRuntime,
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

function registerOrderCardCommands(servicesApi = {}) {
  if (!Array.isArray(servicesApi.commands)) servicesApi.commands = [];
  if (servicesApi.__orderCardsCommandsRegistered) return;
  servicesApi.__orderCardsCommandsRegistered = true;

  servicesApi.commands.push(
    new AddCommand({
      onAdd(row) {
        const orderCards = servicesApi.orderCards;
        if (typeof orderCards?.ingestRow === 'function') {
          return orderCards.ingestRow(row, { source: 'commandLine' });
        }
        return { ok: false, error: 'Order cards service unavailable' };
      }
    }),
    new RemoveCommand({
      onRemove(filter) {
        if (!filter || typeof filter !== 'object') return { ok: false, error: 'Invalid remove payload' };
        const orderCards = servicesApi.orderCards;
        if (typeof orderCards?.remove === 'function') {
          return orderCards.remove(filter);
        }
        return { ok: false, error: 'Order cards service unavailable' };
      }
    })
  );
}

function registerMainApplicationServices(context = {}) {
  const { servicesApi = {} } = context;
  registerOrderCardCommands(servicesApi);
  if (servicesApi.orderCards) return servicesApi.orderCards;
  const { createOrderCardService, createOrderCardsApplicationService } = require('./index');

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

function initService(servicesApi = {}) {
  registerOrderCardCommands(servicesApi);
}

function registerMainIpcHandlers({ ipcMain, servicesApi } = {}) {
  registerOrderCardsIpcHandlers({ ipcMain, servicesApi });
}

module.exports = {
  initService,
  mainApplicationServicePhase: 'before-window',
  rendererHandlers,
  registerOrderCardCommands,
  registerMainApplicationServices,
  registerMainIpcHandlers
};
