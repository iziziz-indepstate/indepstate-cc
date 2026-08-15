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

    function legacyCardHandlerForKey(key) {
      const row = state.rows.find(r => rowKey(r) === key) || {};
      return orderCardsRenderer?.handlerFor?.(row, row.instrumentType) || null;
    }

    function setLegacyCardState(key, stateName) {
      const legacyOrderStateApi = legacyOrderListRuntime?.legacyOrderStateApi;
      if (stateName) legacyOrderStateApi?.setCardState?.(key, stateName);
      else legacyOrderStateApi?.clearCardState?.(key);

      const card = cardByKey(key);
      if (!card) return;
      const cardHandler = legacyCardHandlerForKey(key);
      const status = card.querySelector('.card__status');
      const close = card.querySelector('.card__close');
      const retryBtn = card.querySelector('.retry-btn');
      const spreadEl = card.querySelector('.card__spread');
      const btnsWrap = card.querySelector('.btns');
      if (!status) return;

      const inputs = card.querySelectorAll('input');
      const buttons = card.querySelectorAll('button.btn');

      if (stateName) {
        status.style.display = 'inline-block';
        status.className = `card__status card__status--${stateName}`;
        if (stateName === 'pending-exec') {
          const lbl = legacyOrderStateApi?.getPendingExecLabel?.(key);
          status.textContent = lbl ? `pe (${lbl})` : 'pe';
        } else {
          legacyOrderStateApi?.clearPendingExecLabel?.(key);
          status.textContent = '';
        }
        card.classList.toggle('card--pending', stateName === 'pending' || stateName === 'pending-exec');
        if (close) close.style.display = 'none';
        if (spreadEl) spreadEl.style.display = 'none';
        inputs.forEach(inp => { inp.disabled = true; });
        buttons.forEach(btn => { btn.disabled = true; });
        if (btnsWrap) btnsWrap.style.display = stateName === 'pending-exec' ? 'none' : '';

        const closePlacedOrder = async () => {
          const orderInfo = legacyOrderStateApi?.getPlacedOrder?.(key);
          const currentRow = state.rows.find(r => rowKey(r) === key);
          if (typeof cardHandler?.closePlacedOrder === 'function') {
            const handled = await cardHandler.closePlacedOrder({
              key,
              row: currentRow,
              orderInfo,
              legacyOrderStateApi,
              setCardState: setLegacyCardState,
              render,
              ipcRenderer,
              toast,
              shakeCard
            });
            if (handled) return;
          }
          if (orderInfo && orderInfo.ticket && orderInfo.provider) {
            await ipcRenderer?.invoke?.('execution:cancel-order', {
              provider: orderInfo.provider,
              ticket: orderInfo.ticket,
              symbol: orderInfo.symbol,
              name: orderInfo.name || currentRow?.name
            }).catch(() => null);
          }
          legacyOrderStateApi?.clearExecutionStateByKey?.(key);
          setLegacyCardState(key, null);
          render();
        };

        if (stateName === 'placed') {
          status.style.cursor = 'pointer';
          status.title = cardHandler?.placedStatusTitle || 'Return to ready to send';
          status.onclick = closePlacedOrder;
          if (cardHandler?.placedButton && btnsWrap) {
            const closeBtn = btnsWrap.querySelector('button.btn');
            if (closeBtn) {
              const replacement = closeBtn.cloneNode(true);
              replacement.textContent = cardHandler.placedButton.label || closeBtn.textContent;
              for (const cls of cardHandler.placedButton.removeClasses || []) replacement.classList.remove(cls);
              for (const cls of cardHandler.placedButton.addClasses || []) replacement.classList.add(cls);
              replacement.disabled = false;
              replacement.title = cardHandler.placedButton.title || status.title;
              replacement.addEventListener('click', closePlacedOrder);
              closeBtn.replaceWith(replacement);
            }
          }
        } else if (stateName === 'pending-exec') {
          status.style.cursor = 'pointer';
          status.title = 'Cancel pe';
          status.onclick = () => {
            const reqId = card.dataset.reqId;
            const pendingId = card.dataset.pendingId || (reqId ? legacyOrderStateApi?.getPendingId?.(reqId) : null);
            if (pendingId) ipcRenderer?.invoke?.('pending:cancel', pendingId).catch(() => {});
            if (reqId) {
              legacyOrderStateApi?.clearPendingRequest?.(reqId);
              delete card.dataset.reqId;
            }
            delete card.dataset.pendingId;
            setLegacyCardState(key, null);
            render();
          };
        } else {
          status.style.cursor = '';
          status.title = '';
          status.onclick = null;
          card.style.cursor = '';
          card.title = '';
          card.onclick = null;
        }

        const keepFullCard = stateName === 'pending'
          || stateName === 'pending-exec'
          || !!cardHandler?.shouldKeepFullCardOnState?.({ state: stateName, key, card });
        if (keepFullCard) {
          card.classList.remove('card--mini');
          if (card._removedParts) {
            for (const {node, next} of card._removedParts) {
              if (next && next.parentNode === card) card.insertBefore(node, next);
              else card.appendChild(node);
            }
            card._removedParts = null;
          }
          card.querySelectorAll('input').forEach(inp => { inp.disabled = true; });
          card.querySelectorAll('button.btn').forEach(btn => {
            btn.disabled = !cardHandler?.shouldEnableButtonOnState?.({ state: stateName, key, card });
          });
          if (btnsWrap && cardHandler?.shouldHideButtonsOnState?.({ state: stateName, key, card })) btnsWrap.style.display = 'none';
          if (retryBtn) {
            if (stateName === 'pending') {
              retryBtn.style.display = 'inline-block';
              const rid = card.dataset.reqId;
              const retryCount = rid ? legacyOrderStateApi?.getRetryCount?.(rid) : undefined;
              if (retryCount != null) retryBtn.textContent = String(retryCount);
            } else {
              retryBtn.style.display = 'none';
            }
          }
        } else {
          card.classList.add('card--mini');
          if (!card._removedParts) {
            card._removedParts = [];
            ['.meta', '.quad-line', '.extraRow', '.btns', '.card__note'].forEach(sel => {
              const n = card.querySelector(sel);
              if (n) {
                card._removedParts.push({node: n, next: n.nextSibling});
                n.remove();
              }
            });
          }
          if (retryBtn) retryBtn.style.display = 'none';
        }
        return;
      }

      card.classList.remove('card--mini');
      status.style.display = 'none';
      status.textContent = '';
      legacyOrderStateApi?.clearPendingExecLabel?.(key);
      status.style.cursor = '';
      status.title = '';
      status.onclick = null;
      card.style.cursor = '';
      card.title = '';
      card.onclick = null;
      card.classList.remove('card--pending');
      if (spreadEl) spreadEl.style.display = '';
      context.notifyCardRestored?.({ card, updateSpreadForTicker: context.updateSpreadForTicker });
      if (close) close.style.display = '';
      inputs.forEach(inp => { inp.disabled = false; });
      buttons.forEach(btn => { btn.disabled = false; });
      if (btnsWrap) btnsWrap.style.display = '';
      if (cardHandler?.resetButtons && btnsWrap) {
        const openBtn = btnsWrap.querySelector('button.btn');
        if (openBtn) cardHandler.resetButtons(openBtn);
      }
      if (retryBtn) retryBtn.style.display = 'none';
      if (card._removedParts) {
        for (const {node, next} of card._removedParts) {
          if (next && next.parentNode === card) card.insertBefore(node, next);
          else card.appendChild(node);
        }
        card._removedParts = null;
        card.querySelectorAll('input').forEach(inp => { inp.disabled = false; });
        card.querySelectorAll('button.btn').forEach(btn => { btn.disabled = false; });
      }
      legacyOrderStateApi?.deletePlacedOrder?.(key);
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
      getButtonRows: () => orderCardsRuntime.getButtonRows()
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

    context.legacyOrderStateApi = legacyOrderStateApi;
    context.orderCardsState = state;
    context.registerOrderCardInstrumentHandler = (...args) => orderCardsRenderer.registerInstrumentHandler(...args);
    context.registerOrderCardTypeHandler = (...args) => orderCardsRenderer.registerCardTypeHandler(...args);
    context.orderCardHandlerFor = (...args) => orderCardsRenderer.handlerFor(...args);
    context.orderCardHandlerForKey = (...args) => orderCardsRenderer.handlerForKey(...args);
    context.setLegacyOrderCardState = setLegacyCardState;
    context.registerTestingExtension?.('legacyOrderStateApi', legacyOrderStateApi);
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
