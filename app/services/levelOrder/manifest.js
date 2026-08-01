const path = require('path');
const settings = require('../settings');
const { LevelOrderCommand, LevelOrderPlaceCommand } = require('./command');
const { createLevelOrderExecutionController } = require('./application');

settings.register(
  'level-order',
  path.join(__dirname, 'config', 'level-order.json'),
  path.join(__dirname, 'config', 'level-order-settings-descriptor.json')
);

function initService(servicesApi = {}) {
  if (!Array.isArray(servicesApi.commands)) servicesApi.commands = [];
  if (!Array.isArray(servicesApi.executionCardControllers)) servicesApi.executionCardControllers = [];
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
  servicesApi.commands.push(new LevelOrderCommand());
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
    servicesApi.executionCardControllers.push(createLevelOrderExecutionController());
  }
}

const rendererPositionHandlers = [{
  cardType: 'levelOrder',
  register(context = {}) {
    const {
      levelOrderRenderer,
      placeLevelOrderPositionAction,
      positionKey,
      positionCardTitle,
      btn,
      dispatchPositionAction,
      requestRemovePosition
    } = context;
    if (!levelOrderRenderer) return;

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

module.exports = { initService, rendererPositionHandlers };
