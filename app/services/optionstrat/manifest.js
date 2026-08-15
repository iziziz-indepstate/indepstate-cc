const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');
const { createOptionStratCommands } = require('./command');
const { optionLegs, optionLegPair } = require('./actionFunctions');
const { createOptionStratApplicationService } = require('./application');
const { createOptionStratLegacyGuard } = require('./legacyGuard');
const { createOptionStratCloseController } = require('./closeController');
const { createOptionStratRenderer } = require('./renderer');
const { createOptionStratExecutionPolicy } = require('./executionPolicy');
const { createOptionStratLifecycleEnricher } = require('./lifecycleEnricher');
const { OptionStratAdapter } = require('./infrastructure/adapter');

settings.register(
  'optionstrat',
  path.join(__dirname, 'config', 'optionstrat.json'),
  path.join(__dirname, 'config', 'optionstrat-settings-descriptor.json'),
  { livePaths: ['*'] }
);

let optionStratService = null;

const optionStratExecutionExtension = {
  routingDefaults: {
    byInstrumentType: {
      OPT: 'optionstrat'
    }
  },
  providers: {
    optionstrat: {
      adapter: 'optionstrat',
      baseURL: 'https://optionstrat.com/api',
      cookie: '${ENV:OPTIONSTRAT_COOKIE}',
      account: '${ENV:OPTIONSTRAT_ACCOUNT}',
      timeoutMs: 10000
    }
  },
  settingsDescriptor: {
    options: {
      byInstrumentType: {
        OPT: { type: 'string', description: 'Provider for option block instruments' }
      },
      providers: {
        optionstrat: {
          description: 'OptionStrat provider settings',
          adapter: { type: 'string', description: 'Adapter name' },
          baseURL: { type: 'string', description: 'API base URL' },
          cookie: { type: 'string', description: 'Full Cookie header value' },
          account: { type: 'string', description: 'Collection/account ID' },
          timeoutMs: { type: 'number', description: 'Request timeout ms' }
        }
      }
    }
  }
};

function registerActionFunctions(servicesApi = {}) {
  const bus = servicesApi.actionBus;
  if (!bus || typeof bus.registerActionFunction !== 'function') return [];
  return [
    bus.registerActionFunction('optionLegs', optionLegs),
    bus.registerActionFunction('optionLegPair', optionLegPair)
  ].filter(Boolean);
}

function createOrderCardAddHandler(servicesApi = {}) {
  return (row) => {
    const orderCards = servicesApi.orderCards;
    if (typeof orderCards?.ingestRow === 'function') {
      return orderCards.ingestRow(row, { source: 'commandLine' });
    }
    return { ok: false, error: 'Order cards service unavailable' };
  };
}

function initService(servicesApi = {}) {
  servicesApi.brokerage.registerAdapterFactory(
    'optionstrat',
    (cfg = {}, providerName) => new OptionStratAdapter(cfg, providerName)
  );
  servicesApi.brokerage.registerExecutionProviderDefaults?.(optionStratExecutionExtension);
  servicesApi.executionPayloadPolicies?.register?.(createOptionStratExecutionPolicy());
  servicesApi.outboundWebhooks?.registerLifecycleEnricher?.(createOptionStratLifecycleEnricher());
  if (!Array.isArray(servicesApi.executionCloseControllers)) servicesApi.executionCloseControllers = [];
  servicesApi.positions?.registerLegacyGuard?.(createOptionStratLegacyGuard());
  if (!servicesApi.executionCloseControllers.some(controller => controller?.id === 'optionstrat')) {
    servicesApi.executionCloseControllers.push(createOptionStratCloseController({
      positions: servicesApi.positions,
      events: servicesApi.events
    }));
  }
  registerActionFunctions(servicesApi);
  let cfg = {};
  try {
    cfg = loadConfig('../services/optionstrat/config/optionstrat.json');
  } catch {
    cfg = {};
  }
  if (!Array.isArray(servicesApi.commands)) servicesApi.commands = [];
  const commandOpts = { onAdd: createOrderCardAddHandler(servicesApi) };
  servicesApi.commands.push(...createOptionStratCommands(cfg, commandOpts));
  settings.onApply('optionstrat', ({ config }) => {
    const commands = createOptionStratCommands(config, commandOpts);
    for (let i = servicesApi.commands.length - 1; i >= 0; i -= 1) {
      if (servicesApi.commands[i]?.constructor?.name === 'OptionStratCommand') servicesApi.commands.splice(i, 1);
    }
    servicesApi.commands.push(...commands);
    servicesApi.commandLine?.replaceCommands?.(
      command => command?.constructor?.name === 'OptionStratCommand',
      commands
    );
  });
}

function registerMainApplicationServices({
  servicesApi = {},
  getAdapter,
  wireAdapter,
  executionService,
  resolveProviderName
} = {}) {
  optionStratService = createOptionStratApplicationService({
    servicesApi,
    getAdapter,
    wireAdapter,
    executionService,
    resolveProviderName
  });
  servicesApi.optionstrat = {
    ...(servicesApi.optionstrat || {}),
    applicationService: optionStratService
  };
  return optionStratService;
}

function registerMainIpcHandlers({
  ipcMain,
  servicesApi = {}
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('ipcMain with handle() is required');
  }
  const service = optionStratService || servicesApi.optionstrat?.applicationService;
  if (!service) {
    throw new Error('OptionStrat application service is not registered; call registerMainApplicationServices before registerMainIpcHandlers');
  }

  ipcMain.handle('optionstrat:button-event', async (_evt, payload = {}) => service.handleButtonEvent(payload));
  ipcMain.handle('optionstrat:estimate', async (_evt, payload = {}) => service.estimate(payload));
  ipcMain.handle('optionstrat:valuation', async (_evt, payload = {}) => service.valuation(payload));
}

const rendererHandlers = [{
  cardType: 'option',
  register(context = {}) {
    const {
      ipcRenderer,
      el,
      state,
      orderCardsState,
      rowKey,
      render,
      toast,
      shakeCard,
      pendingRequestLabels,
      placedOrderLookup,
      cardVisualState,
      ticketBinding,
      setCardState,
      setLegacyOrderCardState,
      settingsRuntime,
      positionKey,
      btn,
      dispatchPositionAction,
      requestRemovePosition
    } = context;

    if (!ipcRenderer || !el || !state || !rowKey) return;
    const cardRuntime = context.cardRuntime || context;
    let optionStratValuationRefreshMs = 5000;
    const optionStratRenderer = createOptionStratRenderer({
      ipcRenderer,
      el,
      state: orderCardsState || state,
      rowKey,
      render,
      toast,
      shakeCard,
      pendingRequestLabels,
      placedOrderLookup,
      cardVisualState,
      ticketBinding,
      setCardState: setLegacyOrderCardState || setCardState,
      getValuationRefreshMs: () => optionStratValuationRefreshMs
    });

    const optionOrderCardHandler = {
      ...optionStratRenderer.createOrderCardHandler(),
      title({ row } = {}) {
        return row?.name || row?.ticker;
      },
      matchesExistingRow({ incomingRow, existingRow, rowKey: keyForRow } = {}) {
        return typeof keyForRow === 'function'
          && keyForRow(incomingRow || {}) === keyForRow(existingRow || {});
      },
      shouldScheduleInstantExecution({ row } = {}) {
        return row?.instantExecution === true;
      },
      onExecutionResultOk({ row, openedAt } = {}) {
        if (row && openedAt) row.openedAt = row.openedAt || openedAt;
      },
      placedStatusTitle: 'Close OptionStrat position',
      placedButton: {
        label: 'CLOSE',
        title: 'Close OptionStrat position',
        removeClasses: ['bl'],
        addClasses: ['sl']
      },
      onCreateCard({ row } = {}) {
        optionStratRenderer.ensureOptionPayoff(row);
      },
      async closePlacedOrder({
        key,
        row,
        orderInfo,
        placedOrderLookup: placedOrders,
        ticketBinding: tickets,
        setCardState: setState,
        render: rerender,
        ipcRenderer: ipc,
        toast: showToast,
        shakeCard: shake
      } = {}) {
        const hedgeRow = row || (orderInfo ? {
          ...orderInfo,
          ticker: orderInfo.symbol,
          instrumentType: 'OPT'
        } : null);
        if (hedgeRow) optionStratRenderer.emitButtonEvent('close', hedgeRow);
        let result = null;
        if (orderInfo && orderInfo.ticket && orderInfo.provider) {
          try {
            result = await ipc.invoke('execution:cancel-order', {
              provider: orderInfo.provider,
              ticket: orderInfo.ticket,
              symbol: orderInfo.symbol,
              name: orderInfo.name || row?.name
            });
          } catch (err) {
            result = { status: 'error', reason: err?.message || String(err) };
          }
        }
        if (result && result.status !== 'ok') {
          showToast?.(`x ${orderInfo?.symbol || ''}: ${result.reason || 'Close failed'}`);
          shake?.(key);
          return true;
        }
        const finalValuation = result?.valuation || result?.raw?.valuation;
        if (finalValuation) {
          if (row) row.valuation = finalValuation;
          if (orderInfo) orderInfo.valuation = finalValuation;
        }
        if (orderInfo?.ticket) tickets?.unbindTicket?.(orderInfo.ticket);
        optionStratRenderer.markRowClosed(key);
        placedOrders?.deletePlacedOrder?.(key);
        optionStratRenderer.pendingOptionValuations.delete(key);
        setState?.(key, 'profit');
        rerender?.();
        return true;
      },
      shouldKeepFullCardOnState({ state } = {}) {
        return state === 'placed' || state === 'profit';
      },
      shouldEnableButtonOnState({ state } = {}) {
        return state === 'placed';
      },
      shouldHideButtonsOnState({ state } = {}) {
        return state === 'profit';
      },
      resetButtons(button) {
        button.textContent = 'OPEN';
        button.classList.remove('sl');
        button.classList.add('bl');
        button.title = '';
      },
      onPositionOpened({ key } = {}) {
        optionStratRenderer.markRowOpened(key);
      },
      onPositionClosed({ key } = {}) {
        optionStratRenderer.markRowClosed(key);
      }
    };

    cardRuntime.registerOrderCardInstrumentHandler?.('OPT', optionOrderCardHandler);
    cardRuntime.registerCardType?.({
      type: 'option',
      match: position => ['option', 'optionstrat'].includes(String(position?.card?.type || position?.source?.cardType || '').toLowerCase()),
      shape: 'option-position-card'
    });
    ipcRenderer.invoke('settings:get', 'optionstrat').then((res) => {
      const cfg = res?.config || res || {};
      const ms = Number(cfg.valuationRefreshMs);
      if (Number.isFinite(ms) && ms > 0) {
        optionStratValuationRefreshMs = optionStratRenderer.setValuationRefreshMs(ms);
      }
      optionStratRenderer.setDisplayFields(cfg.displayFields);
    }).catch(() => {});
    settingsRuntime?.onApply?.('optionstrat', ({ config }) => {
      const ms = Number(config?.valuationRefreshMs);
      if (Number.isFinite(ms) && ms > 0) {
        optionStratValuationRefreshMs = optionStratRenderer.setValuationRefreshMs(ms);
      }
      optionStratRenderer.setDisplayFields(config?.displayFields);
      render?.();
    });
    optionStratRenderer.startValuationRefresh();

    const register = cardType => cardRuntime.registerPositionCardRenderer?.(cardType, (position) => {
      return optionStratRenderer.createOptionPositionCard({
        position,
        key: positionKey(position),
        createActionButton: ({ label, kind, className, onClick }) => {
          const button = btn(label, className, onClick);
          button.dataset.kind = kind;
          return button;
        },
        createActionsFromSnapshot: (snapshot, action, validated) => dispatchPositionAction(snapshot, action, validated),
        requestRemove: (snapshot) => requestRemovePosition(snapshot)
      });
    });
    register('option');
    register('optionstrat');
  }
}];

module.exports = {
  initService,
  registerActionFunctions,
  registerMainApplicationServices,
  registerMainIpcHandlers,
  rendererHandlers,
  rendererLegacyGuards: [createOptionStratLegacyGuard()],
  optionStratExecutionExtension,
  createOptionStratLifecycleEnricher
};
