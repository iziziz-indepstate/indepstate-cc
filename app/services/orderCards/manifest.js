const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');
const { createOrderCardsRenderer } = require('./renderer');
const { createOrderCardsRendererConfigRuntime } = require('./rendererConfigRuntime');
const { createCardRuntimeLibrary } = require('../../infrastructure/renderer/cardRuntime/library');
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
    const orderCardsRuntime = createOrderCardsRendererConfigRuntime({
      loadConfig: context.loadConfig || loadConfig,
      settingsRuntime: context.settingsRuntime,
      env: context.env || process.env,
      render: context.render
    });
    context.registerInstrumentDisplayPolicy?.({
      getInstrumentRefreshMs: () => orderCardsRuntime.getInstrumentRefreshMs(),
      shouldShowBidAsk: () => orderCardsRuntime.shouldShowBidAsk(),
      shouldShowSpread: () => orderCardsRuntime.shouldShowSpread()
    });
    context.registerCardStateHook?.(({ card, updateSpreadForTicker }) => {
      if (orderCardsRuntime.shouldShowSpread()) updateSpreadForTicker?.(card?.dataset?.ticker);
    });
    const rowKey = context.rowKey || (row => `${row.ticker}|${row.event}|${row.time}|${row.price}`);
    const cardRuntimeLibrary = createCardRuntimeLibrary({
      el: context.el,
      btn: context.btn,
      document: context.document || (typeof document !== 'undefined' ? document : null),
      createActionButton: context.createActionButton
    });
    context.cardRuntime?.registerCardView?.(
      'position-data-grid',
      cardRuntimeLibrary.views.createDataGridView
    );
    const orderCardsRenderer = createOrderCardsRenderer({
      el: context.el,
      inputNumber: context.inputNumber,
      uiState: context.uiState,
      orderCalc: context.orderCalc,
      priceToPoints: context.priceToPoints,
      normNum: context.normNum,
      isPos: context.isPos,
      isSL: context.isSL,
      tickSize: context.tickSize,
      ensureInstrument: context.ensureInstrument,
      instrumentInfoFor: context.instrumentInfoFor,
      markTouched: context.markTouched,
      detectInstrumentType: context.detectInstrumentType,
      rowKey,
      ipcRenderer: context.ipcRenderer,
      orderStateApi: context.cardStateApi || context.cardRuntime?.stateApi,
      cardByKey: context.cardByKey,
      setCardState: context.setCardState,
      pendingActionInfo: context.pendingActionInfo,
      toast: context.toast,
      shakeCard: context.shakeCard,
      render: context.render,
      btn: context.btn,
      formatBidAskText: context.formatBidAskText,
      formatSpreadTriple: context.formatSpreadTriple,
      updateSpreadForTicker: context.updateSpreadForTicker,
      shouldShowBidAsk: () => orderCardsRuntime.shouldShowBidAsk(),
      shouldShowSpread: () => orderCardsRuntime.shouldShowSpread(),
      getCardButtons: () => orderCardsRuntime.getCardButtons(),
      getButtonRows: () => orderCardsRuntime.getButtonRows(),
      cardRuntimeLibrary
    });

    if (
      !orderCardsRenderer?.createRegularPositionView
      || !orderCardsRenderer?.createRegularPositionActionsControl
      || !orderCardsRenderer?.createRegularPositionCard
    ) return;
    context.cardRuntime?.registerCardView?.(
      'regular-position-view',
      orderCardsRenderer.createRegularPositionView
    );
    context.cardRuntime?.registerCardControl?.(
      'regular-position-actions',
      orderCardsRenderer.createRegularPositionActionsControl
    );
    context.cardRuntime?.registerCardShape?.(
      'regular-position-card',
      orderCardsRenderer.createRegularPositionCard
    );
    context.cardRuntime?.registerCardType?.({
      type: 'regular',
      view: 'regular-position-view',
      controls: ['regular-position-actions'],
      shape: 'regular-position-card'
    });
  }
}];

function normalizeSourceConfig(src) {
  const normalized = (src && typeof src === 'object' && !Array.isArray(src))
    ? src
    : { type: typeof src === 'string' ? src : '' };
  return {
    ...normalized,
    type: String(normalized.type || '').trim()
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
  const {
    createOrderCardService,
    createOrderCardsApplicationService,
    isOrderCardSourceType
  } = require('./index');

  const config = context.orderCardsConfig || loadConfig('../services/orderCards/config/order-cards.json');
  const sourcesCfg = Array.isArray(config?.sources) ? config.sources : [];
  const sourceServices = [];
  let applicationService;

  for (const src of sourcesCfg) {
    const normalized = normalizeSourceConfig(src);
    const type = normalized.type;
    if (!isOrderCardSourceType(type)) {
      const label = type || '<missing>';
      const warn = typeof context.warn === 'function' ? context.warn : console.warn;
      warn(`[orderCards] Ignoring unknown source type: ${label}`);
      continue;
    }
    const opts = {
      ...normalized,
      type,
      nowTs: context.nowTs,
      onRow(row) {
        applicationService?.ingestRow?.(row, { source: type });
      }
    };
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
