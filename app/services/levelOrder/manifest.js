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
const { createLevelOrderLegacyGuard } = require('./legacyGuard');
const { createLevelOrderRenderer } = require('./infrastructure/renderer/renderer');

settings.register(
  'level-order',
  path.join(__dirname, 'config', 'level-order.json'),
  path.join(__dirname, 'config', 'level-order-settings-descriptor.json')
);

const levelOrderPositionMonitors = new Map();
const levelOrderIntentRegistry = new Map();
let levelOrderService = null;

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
  if (!Array.isArray(servicesApi.commands)) servicesApi.commands = [];
  if (!Array.isArray(servicesApi.executionCardControllers)) servicesApi.executionCardControllers = [];
  servicesApi.positions?.registerBehavior?.(createLevelOrderPositionBehavior());
  servicesApi.positions?.registerOpeningPolicy?.('levelOrder', createLevelOrderOpeningPolicy);
  servicesApi.positions?.registerLegacyGuard?.(createLevelOrderLegacyGuard());
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
  servicesApi.commands.push(new LevelOrderCommand({ onAdd: createOrderCardAddHandler(servicesApi) }));
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
      legacyOrderStateApi,
      cardByKey,
      setCardState,
      toast,
      shakeCard,
      render,
      btn,
      dispatchPositionAction,
      requestRemovePosition
    } = context;

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
      legacyOrderStateApi,
      cardByKey,
      setCardState,
      toast,
      shakeCard,
      render
    });

    context.registerPositionActionHandler?.(
      'levelOrder',
      levelOrderRenderer.createSnapshotActionHandler({
        placePositionAction: placeLevelOrderPositionAction
      })
    );

    context.registerPositionCardRenderer?.('levelOrder', (position) => {
      return levelOrderRenderer.createLevelOrderPositionCard({
        position,
        key: positionKey(position),
        title: positionCardTitle(position),
        createActionButton: ({ label, kind, className, onClick }) => {
          const button = btn(label, className, onClick);
          button.dataset.kind = kind;
          return button;
        },
        createActionsFromSnapshot: (snapshot, action, validated) => dispatchPositionAction(snapshot, action, validated),
        requestRemove: (snapshot) => requestRemovePosition(snapshot)
      });
    });

    context.registerPositionRemovalHandler?.(
      'levelOrder',
      position => levelOrderRenderer.onPositionRemoved(position)
    );
  }
}];

const rendererLegacyGuards = [createLevelOrderLegacyGuard()];

module.exports = {
  initService,
  registerMainApplicationServices,
  registerMainIpcHandlers,
  rendererPositionHandlers,
  rendererLegacyGuards
};
