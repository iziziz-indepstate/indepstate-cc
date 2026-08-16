const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');
const { createOrderCardsRenderer } = require('./renderer');
const { createOrderCardsRendererConfigRuntime } = require('./rendererConfigRuntime');
const { createLegacyOrderListRuntime } = require('./legacyOrderListRuntime');
const { createOrderStateFacades, createLegacyOrderStateCompatApi } = require('../../infrastructure/renderer/cardRuntime');
const { createCardRuntimeLibrary } = require('../../infrastructure/renderer/cardRuntime/library');
const { createLegacyRowPresentationAdapter } = require('../../infrastructure/renderer/cardRuntime/legacyRowPresentation');
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
    const legacyState = { uiState: context.uiState };
    const state = { rows: [], filter: '', autoscroll: true };
    let legacyOrderListRuntime;
    let orderCardsRenderer;
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
    const cardStateOrder = context.cardStateOrder || {pending: 1, 'pending-exec': 2, placed: 3, executing: 4, closed: 5, profit: 6, loss: 7};
    const rowKey = context.rowKey || (row => `${row.ticker}|${row.event}|${row.time}|${row.price}`);
    const cardByKey = context.cardByKey || (() => null);
    const ipcRenderer = context.ipcRenderer;
    const render = context.render || (() => {});
    const toast = context.toast || (() => {});
    const shakeCard = context.shakeCard || (() => {});
    const cardRuntimeLibrary = createCardRuntimeLibrary({
      el: context.el,
      btn: context.btn,
      document: context.document || (typeof document !== 'undefined' ? document : null),
      createActionButton: context.createActionButton
    });
    context.cardRuntime?.registerCardShape?.(
      'regular-order-legacy-card',
      cardRuntimeLibrary.shapes.createLegacyCardShape
    );
    context.cardRuntime?.registerCardShape?.(
      'regular-position-card',
      cardRuntimeLibrary.shapes.createPositionCardShape
    );
    context.cardRuntime?.registerCardControl?.(
      'standard-remove',
      cardRuntimeLibrary.controls.createRemoveControl
    );
    context.cardRuntime?.registerCardControl?.(
      'standard-retry',
      cardRuntimeLibrary.controls.createRetryControl
    );
    context.cardRuntime?.registerCardControl?.(
      'standard-action-buttons',
      cardRuntimeLibrary.controls.createActionButtonsControl
    );
    context.cardRuntime?.registerCardView?.(
      'position-data-grid',
      cardRuntimeLibrary.views.createDataGridView
    );
    const legacyOrderStateApi = {};
    for (const method of [
      'getCardState',
      'setCardState',
      'clearCardState',
      'setPendingExecLabel',
      'getPendingExecLabel',
      'clearPendingExecLabel',
      'markPendingRequest',
      'resolvePendingKey',
      'setPendingId',
      'getPendingId',
      'getRetryCount',
      'findPendingRequestIdByKey',
      'clearPendingRequest',
      'clearPendingByKey',
      'markPlacedOrder',
      'getPlacedOrder',
      'deletePlacedOrder',
      'resolveTicketKey',
      'bindTicket',
      'unbindTicket',
      'listPlacedOrders',
      'clearExecutionStateByKey'
    ]) {
      legacyOrderStateApi[method] = (...args) => legacyOrderListRuntime?.legacyOrderStateApi?.[method]?.(...args);
    }

    const rendererStateCompat = createLegacyOrderStateCompatApi({
      pendingRequestLabels: context.pendingRequestLabels,
      placedOrderLookup: context.placedOrderLookup,
      cardVisualState: context.cardVisualState,
      ticketBinding: context.ticketBinding
    });
    const orderStateFacades = createOrderStateFacades(legacyOrderStateApi, rendererStateCompat);

    function legacyRowByKey(key) {
      return state.rows.find(row => rowKey(row) === key);
    }

    function legacyCardHandlerForKey(key) {
      const row = legacyRowByKey(key) || {};
      return orderCardsRenderer?.handlerFor?.(row, row.instrumentType) || null;
    }

    const legacyPresentation = createLegacyRowPresentationAdapter({
      rowByKey: legacyRowByKey,
      cardByKey,
      rowKey,
      stateApi: legacyOrderStateApi,
      stateFacades: orderStateFacades,
      handlerForKey: legacyCardHandlerForKey,
      ipcRenderer,
      render,
      toast,
      shakeCard,
      notifyCardRestored: context.notifyCardRestored,
      updateSpreadForTicker: context.updateSpreadForTicker
    });

    function setLegacyCardState(key, stateName) {
      return legacyPresentation.setCardState(key, stateName);
    }

    orderCardsRenderer = createOrderCardsRenderer({
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
      tradeRules: context.tradeRules,
      markTouched: context.markTouched,
      detectInstrumentType: context.detectInstrumentType,
      rowKey,
      ipcRenderer,
      legacyOrderStateApi,
      cardByKey,
      setCardState: setLegacyCardState,
      pendingActionInfo: context.pendingActionInfo,
      toast,
      shakeCard,
      render,
      btn: context.btn,
      removeRow: row => legacyOrderListRuntime?.removeRow?.(row),
      formatBidAskText: context.formatBidAskText,
      formatSpreadTriple: context.formatSpreadTriple,
      updateSpreadForTicker: context.updateSpreadForTicker,
      getRows: () => state.rows,
      shouldShowBidAsk: () => orderCardsRuntime.shouldShowBidAsk(),
      shouldShowSpread: () => orderCardsRuntime.shouldShowSpread(),
      getCardButtons: () => orderCardsRuntime.getCardButtons(),
      getButtonRows: () => orderCardsRuntime.getButtonRows(),
      cardRuntimeLibrary
    });
    context.cardRuntime?.connectLegacyOrderCardRenderer?.({
      renderer: orderCardsRenderer,
      getRows: () => state.rows,
      rowKey,
      setCardState: setLegacyCardState
    });
    legacyOrderListRuntime = createLegacyOrderListRuntime({
      ipcRenderer,
      state,
      legacyState,
      rowKey,
      findKeyByTicker: context.findKeyByTicker,
      isTerminalCardState: context.isTerminalCardState,
      cardByKey,
      setCardState: setLegacyCardState,
      removePositionSnapshotsForLegacyRow: context.removePositionSnapshotsForRow,
      positionRemovalHandlerFor: context.positionRemovalHandlerFor,
      positionMatchesLegacyRow: context.positionMatchesLegacyRow,
      isRegularPositionSnapshot: context.isRegularPositionSnapshot,
      shouldFilterLegacyRow: context.shouldFilterLegacyRow,
      shouldIgnoreLegacyRowForExistingPosition: context.shouldIgnoreLegacyRowForExistingPosition,
      shouldIgnoreLegacyExecutionEvent: context.shouldIgnoreLegacyExecutionEvent,
      shouldIgnoreLegacyPositionEvent: context.shouldIgnoreLegacyPositionEvent,
      shouldRemoveLegacyRowForPosition: context.shouldRemoveLegacyRowForPosition,
      shouldResetLegacyRowForPosition: context.shouldResetLegacyRowForPosition,
      forgetInstrument: context.forgetInstrument,
      toast,
      shakeCard,
      render,
      matchesExistingOrderRow: (...args) => orderCardsRenderer.matchesExistingRow(...args),
      orderCardHandlerForRow: (...args) => orderCardsRenderer.handlerFor(...args),
      orderCardHandlerForKey: (...args) => orderCardsRenderer.handlerForKey(...args),
      scheduleOrderCardInstantExecution: (...args) => orderCardsRenderer.scheduleInstantExecution(...args)
    });
    legacyOrderListRuntime?.setClosedCardEventStrategy?.(orderCardsRuntime.getClosedCardEventStrategy?.() || 'ignore');

    context.pendingRequestLabels = orderStateFacades.pendingRequestLabels;
    context.placedOrderLookup = orderStateFacades.placedOrderLookup;
    context.cardVisualState = orderStateFacades.cardVisualState;
    context.ticketBinding = orderStateFacades.ticketBinding;
    context.registerTestingExtension?.('legacyOrderStateApi', legacyOrderStateApi);
    context.registerTestingExtension?.('pendingRequestLabels', orderStateFacades.pendingRequestLabels);
    context.registerTestingExtension?.('placedOrderLookup', orderStateFacades.placedOrderLookup);
    context.registerTestingExtension?.('cardVisualState', orderStateFacades.cardVisualState);
    context.registerTestingExtension?.('ticketBinding', orderStateFacades.ticketBinding);
    context.registerTestingExtension?.('orderCardInstrumentHandlers', orderCardsRenderer.instrumentTypeHandlers);
    context.registerTestingExtension?.('orderCardTypeHandlers', orderCardsRenderer.cardTypeHandlers);
    context.registerTestingExtension?.('orderCardsRows', {
      get length() { return state.rows.length; },
      some: (...args) => state.rows.some(...args),
      find: (...args) => state.rows.find(...args),
      filter: (...args) => state.rows.filter(...args),
      map: (...args) => state.rows.map(...args),
      push: (...args) => state.rows.push(...args),
      entries: () => state.rows.entries(),
      [Symbol.iterator]: () => state.rows[Symbol.iterator]()
    });

    context.registerRendererRowProvider?.(() => state.rows);
    context.registerRendererLayer?.(({ grid } = {}) => {
      legacyOrderListRuntime.renderLegacyCards((row, index) => {
        const card = orderCardsRenderer.createLegacyOrderCard({ row, index });
        if (card && grid) grid.appendChild(card);
        return card;
      }, cardStateOrder);
    });
    context.registerPositionSnapshotHook?.((position = {}) => {
      legacyOrderListRuntime.resetLegacyRowsForPosition(position);
      legacyOrderListRuntime.removeLegacyRowsForPosition(position);
      const cardType = position.card?.type || position.source?.cardType || 'regular';
      const shouldUseSnapshot = String(cardType || 'regular') === 'regular'
        || context.shouldFilterLegacyRow?.({ cardType })
        || state.rows.some(row => context.shouldRemoveLegacyRowForPosition?.(position, row));
      if (!shouldUseSnapshot) return;
      const key = context.positionKey?.(position);
      legacyOrderListRuntime.legacyOrderStateApi.clearCardState(key);
      legacyOrderListRuntime.legacyOrderStateApi.clearPendingExecLabel(key);
    });
    context.registerPositionRemovedHook?.((position = {}) => legacyOrderListRuntime.removeLegacyRowsForPosition(position));

    legacyOrderListRuntime.mount?.({ place: (...args) => orderCardsRenderer.place(...args) });

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
