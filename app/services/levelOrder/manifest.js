const path = require('path');
const settings = require('../settings');
const { LevelOrderCommand, LevelOrderPlaceCommand } = require('./command');

settings.register(
  'level-order',
  path.join(__dirname, 'config', 'level-order.json'),
  path.join(__dirname, 'config', 'level-order-settings-descriptor.json')
);

function initService(servicesApi = {}) {
  if (!Array.isArray(servicesApi.commands)) servicesApi.commands = [];
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
