const path = require('path');
const settings = require('../settings');
const { LevelOrderCommand, LevelOrderPlaceCommand } = require('./command');
const {
  createLevelOrderApplicationService,
  createLevelOrderExecutionController,
  createLevelOrderRuntime
} = require('./application');
const { createLevelOrderPositionBehavior } = require('./domain/positionBehavior');
const { createLevelOrderOpeningPolicy } = require('./domain/openingPolicy');
const { createLevelOrderPositionInputAdapter } = require('./positionInputAdapter');
const { createLevelOrderRenderer } = require('./infrastructure/renderer/renderer');

settings.register(
  'level-order',
  path.join(__dirname, 'config', 'level-order.json'),
  path.join(__dirname, 'config', 'level-order-settings-descriptor.json')
);

const levelOrderPositionMonitors = new Map();
const levelOrderIntentRegistry = new Map();
let levelOrderService = null;

function createPositionAddHandler(servicesApi = {}) {
  return (row) => {
    const positions = servicesApi.positions;
    if (typeof positions?.createFromInput === 'function') {
      return positions.createFromInput(row, { source: 'commandLine' });
    }
    return { ok: false, error: 'Position input ingestion unavailable' };
  };
}

function initService(servicesApi = {}) {
  if (!Array.isArray(servicesApi.commands)) servicesApi.commands = [];
  if (!Array.isArray(servicesApi.executionCardControllers)) servicesApi.executionCardControllers = [];
  servicesApi.positions?.registerBehavior?.(createLevelOrderPositionBehavior());
  servicesApi.positions?.registerOpeningPolicy?.('levelOrder', createLevelOrderOpeningPolicy);
  servicesApi.positions?.registerPositionInputAdapter?.(createLevelOrderPositionInputAdapter());
  const resolvers = new Map();
  servicesApi.levelOrder = {
    registerLevelResolver(name, fn) {
      const key = String(name || '').trim();
      if (!key || typeof fn !== 'function') return false;
      resolvers.set(key, fn);
      return () => resolvers.delete(key);
    },
    getLevelResolver(name) {
      return resolvers.get(String(name || '').trim());
    }
  };
  servicesApi.commands.push(new LevelOrderCommand({ onAdd: createPositionAddHandler(servicesApi) }));
  const commandOpts = {
    servicesApi,
    getConfig() {
      return (settings.readConfig('level-order') || {}).config || {};
    }
  };
  servicesApi.commands.push(
    new LevelOrderPlaceCommand('LB', commandOpts),
    new LevelOrderPlaceCommand('LS', commandOpts)
  );
  if (!servicesApi.executionCardControllers.some(controller => controller?.id === 'levelOrder')) {
    servicesApi.executionCardControllers.push(createLevelOrderExecutionController({ levelOrderPositionMonitors }));
  }
}

function registerMainApplicationServices({
  servicesApi = {},
  getAdapter,
  wireAdapter,
  instrumentInfo,
  orderCalc,
  appendJsonl,
  execLog,
  nowTs,
  sendToRenderer,
  resolveProviderName,
  executionService,
  pendingIndex,
  trackerPending,
  groupedOrderLifecycles
} = {}) {
  if (!servicesApi.execution) servicesApi.execution = {};
  const runtime = createLevelOrderRuntime({
    getAdapter,
    wireAdapter,
    groupedOrderLifecycles,
    levelOrderPositionMonitors,
    appendJsonl,
    execLog,
    nowTs,
    sendToRenderer
  });
  levelOrderService = createLevelOrderApplicationService({
    getAdapter,
    wireAdapter,
    instrumentInfo,
    orderCalc,
    appendJsonl,
    execLog,
    nowTs,
    sendToRenderer,
    resolveProviderName,
    queuePlaceOrder: (payload) => executionService.queuePlaceOrder(payload),
    positions: servicesApi.positions,
    pendingIndex,
    trackerPending,
    levelOrderIntentRegistry,
    runtime
  });
  servicesApi.execution.queueLevelOrder = (payload) => levelOrderService.queueLevelOrder(payload);
  servicesApi.execution.previewLevelOrder = (payload) => levelOrderService.previewLevelOrder(payload);
  servicesApi.levelOrder = {
    ...(servicesApi.levelOrder || {}),
    applicationService: levelOrderService
  };
  return levelOrderService;
}

function registerMainIpcHandlers({
  ipcMain,
  servicesApi = {}
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('ipcMain with handle() is required');
  }
  const service = levelOrderService || servicesApi.levelOrder?.applicationService;
  if (!service) {
    throw new Error('LevelOrder application service is not registered; call registerMainApplicationServices before registerMainIpcHandlers');
  }

  ipcMain.handle('level-order:place', async (_evt, payload = {}) => service.queueLevelOrder(payload));
  ipcMain.handle('level-order:preview-place', async (_evt, payload = {}) => service.previewLevelOrder(payload));
  ipcMain.handle('execution:stop-retry', async (_evt, reqId) => service.stopRetry(reqId));
  ipcMain.handle('execution:close-level-order-positions', async (_evt, payload = {}) => service.closeLevelOrderPositions(payload));
}

const rendererPositionHandlers = [{
  cardType: 'levelOrder',
  register(context = {}) {
    const {
      loadConfig,
      settingsRuntime,
      el,
      inputNumber,
      normNum,
      instrumentInfoFor,
      tickSize,
      isPos,
      isSL,
      markTouched,
      uiState,
      orderCalc,
      detectInstrumentType,
      createPositionDataGrid,
      ipcRenderer,
      trackInstrument,
      untrackInstrument,
      positionKey,
      positionCardTitle,
      pendingRequestLabels,
      cardByKey,
      setCardState,
      toast,
      shakeCard,
      render
    } = context;
    const cardRuntime = context.cardRuntime || context;

    let levelOrderCfg = typeof loadConfig === 'function'
      ? loadConfig('../services/levelOrder/config/level-order.json')
      : {};
    settingsRuntime?.onApply?.('level-order', ({ config }) => {
      levelOrderCfg = config || {};
      render?.();
    });

    const levelOrderRenderer = createLevelOrderRenderer({
      getConfig: () => levelOrderCfg,
      el,
      inputNumber,
      normNum,
      instrumentInfoFor,
      tickSize,
      isPos,
      isSL,
      markTouched,
      uiState,
      orderCalc,
      detectInstrumentType,
      createPositionDataGrid,
      ipcRenderer,
      trackInstrument,
      untrackInstrument
    });
    const placeLevelOrderPositionAction = levelOrderRenderer.createPositionActionDispatcher({
      positionKey,
      positionCardTitle,
      pendingRequestLabels,
      cardByKey,
      setCardState,
      toast,
      shakeCard,
      render
    });

    const handleLevelOrderSnapshotAction = levelOrderRenderer.createSnapshotActionHandler({
      placePositionAction: placeLevelOrderPositionAction
    });

    cardRuntime.registerCardView?.(
      'level-order-body',
      levelOrderRenderer.createLevelOrderPositionView
    );
    cardRuntime.registerCardControl?.(
      'level-order-actions',
      composition => levelOrderRenderer.createLevelOrderActionsControl({
        ...composition,
        handleAction: handleLevelOrderSnapshotAction
      })
    );
    cardRuntime.registerCardShape?.(
      'level-order-position-card',
      levelOrderRenderer.createLevelOrderPositionCard
    );

    cardRuntime.registerCardType?.({
      type: 'levelOrder',
      match: position => String(position?.card?.type || position?.source?.cardType || '') === 'levelOrder',
      view: 'level-order-body',
      controls: ['level-order-actions'],
      shape: 'level-order-position-card',
      onRemovePosition: levelOrderRenderer.onPositionRemoved
    });
  }
}];

module.exports = {
  initService,
  registerMainApplicationServices,
  registerMainIpcHandlers,
  rendererPositionHandlers
};
