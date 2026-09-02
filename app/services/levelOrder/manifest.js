const path = require('path');
const settings = require('../settings');
const { LevelOrderCommand, LevelOrderPlaceCommand } = require('./command');
const { createLevelProviderRegistry } = require('./provider');

settings.register(
  'level-order',
  path.join(__dirname, 'config', 'level-order.json'),
  path.join(__dirname, 'config', 'level-order-settings-descriptor.json')
);

function initService(servicesApi = {}) {
  if (!Array.isArray(servicesApi.commands)) servicesApi.commands = [];
  const resolvers = new Map();
  const providerRegistry = createLevelProviderRegistry();
  servicesApi.levelOrder = {
    registerLevelResolver(name, fn) {
      const key = String(name || '').trim();
      if (!key || typeof fn !== 'function') return false;
      resolvers.set(key, fn);
      return () => resolvers.delete(key);
    },
    getLevelResolver(name) {
      return resolvers.get(String(name || '').trim());
    },
    registerLevelProvider: providerRegistry.registerLevelProvider,
    getLevelProvider: providerRegistry.getLevelProvider
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
}

module.exports = { initService };
