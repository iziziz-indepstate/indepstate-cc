const path = require('path');
const settings = require('../settings');
const { LevelOrderCommand } = require('./command');

settings.register(
  'level-order',
  path.join(__dirname, 'config', 'level-order.json'),
  path.join(__dirname, 'config', 'level-order-settings-descriptor.json')
);

function initService(servicesApi = {}) {
  if (!Array.isArray(servicesApi.commands)) servicesApi.commands = [];
  servicesApi.commands.push(new LevelOrderCommand());
}

module.exports = { initService };
