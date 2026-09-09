const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');
const { createOptionStratCommands } = require('./command');
const { optionLegs, optionLegPair } = require('./actionFunctions');

settings.register(
  'optionstrat',
  path.join(__dirname, 'config', 'optionstrat.json'),
  path.join(__dirname, 'config', 'optionstrat-settings-descriptor.json')
);

function registerActionFunctions(servicesApi = {}) {
  const bus = servicesApi.actionBus;
  if (!bus || typeof bus.registerActionFunction !== 'function') return [];
  return [
    bus.registerActionFunction('optionLegs', optionLegs),
    bus.registerActionFunction('optionLegPair', optionLegPair)
  ].filter(Boolean);
}

function initService(servicesApi = {}) {
  registerActionFunctions(servicesApi);
  let cfg = {};
  try {
    cfg = loadConfig('../services/optionstrat/config/optionstrat.json');
  } catch {
    cfg = {};
  }
  if (!Array.isArray(servicesApi.commands)) servicesApi.commands = [];
  const commandOpts = { executionApi: servicesApi };
  servicesApi.commands.push(...createOptionStratCommands(cfg, commandOpts));
  settings.onApply('optionstrat', ({ config }) => {
    const commands = createOptionStratCommands(config, commandOpts);
    for (let i = servicesApi.commands.length - 1; i >= 0; i -= 1) {
      if (servicesApi.commands[i]?.isOptionStratCommand) servicesApi.commands.splice(i, 1);
    }
    servicesApi.commands.push(...commands);
    servicesApi.commandLine?.replaceCommands?.(
      command => command?.isOptionStratCommand,
      commands
    );
  });
}

module.exports = { initService, registerActionFunctions };
