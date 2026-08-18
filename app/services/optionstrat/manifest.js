const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');
const { createOptionStratCommands } = require('./command');
const { optionLegs, optionLegPair } = require('./actionFunctions');
const { createOptionStratApplicationService } = require('./application');
const { createOptionStratPositionInputAdapter } = require('./positionInputAdapter');
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
  servicesApi.positions?.registerPositionInputAdapter?.(createOptionStratPositionInputAdapter());
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
      render,
      toast,
      shakeCard,
      settingsRuntime
    } = context;

    if (!ipcRenderer || !el) return;
    const cardRuntime = context.cardRuntime || context;
    let optionStratValuationRefreshMs = 5000;
    const optionStratRenderer = createOptionStratRenderer({
      ipcRenderer,
      el,
      render,
      toast,
      shakeCard,
      getPositions: context.getPositionSnapshots,
      positionKey: context.positionKey,
      getValuationRefreshMs: () => optionStratValuationRefreshMs
    });
    cardRuntime.registerCardView?.(
      'option-snapshot-payoff-valuation',
      optionStratRenderer.createOptionPositionView
    );
    cardRuntime.registerCardControl?.(
      'option-snapshot-actions',
      optionStratRenderer.createOptionSnapshotActionsControl
    );
    cardRuntime.registerCardShape?.(
      'option-snapshot-position-card',
      optionStratRenderer.createOptionPositionCard
    );
    const snapshotDefinition = type => ({
      type,
      match: (card, runtimeContext = {}) => {
        if (runtimeContext.kind && runtimeContext.kind !== 'position') return false;
        const cardType = String(card?.card?.type || card?.source?.cardType || card?.cardType || card?.type || '').toLowerCase();
        if (type === 'optionstrat') return cardType === 'optionstrat';
        return cardType === 'option'
          || (!cardType && String(card?.instrumentType || '').toUpperCase() === 'OPT');
      },
      view: 'option-snapshot-payoff-valuation',
      controls: ['option-snapshot-actions'],
      shape: 'option-snapshot-position-card'
    });
    cardRuntime.registerCardType?.(snapshotDefinition('option'));
    cardRuntime.registerCardType?.(snapshotDefinition('optionstrat'));
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

  }
}];

module.exports = {
  initService,
  registerActionFunctions,
  registerMainApplicationServices,
  registerMainIpcHandlers,
  rendererHandlers,
  optionStratExecutionExtension,
  createOptionStratLifecycleEnricher
};
