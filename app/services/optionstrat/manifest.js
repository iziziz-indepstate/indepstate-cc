const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');
const { createOptionStratCommands } = require('./command');
const { optionLegs, optionLegPair } = require('./actionFunctions');
const { createOptionStratApplicationService } = require('./application');
const { createOptionStratLegacyGuard } = require('./legacyGuard');

settings.register(
  'optionstrat',
  path.join(__dirname, 'config', 'optionstrat.json'),
  path.join(__dirname, 'config', 'optionstrat-settings-descriptor.json')
);

let optionStratService = null;

function registerActionFunctions(servicesApi = {}) {
  const bus = servicesApi.actionBus;
  if (!bus || typeof bus.registerActionFunction !== 'function') return [];
  return [
    bus.registerActionFunction('optionLegs', optionLegs),
    bus.registerActionFunction('optionLegPair', optionLegPair)
  ].filter(Boolean);
}

function initService(servicesApi = {}) {
  servicesApi.positions?.registerLegacyGuard?.(createOptionStratLegacyGuard());
  registerActionFunctions(servicesApi);
  let cfg = {};
  try {
    cfg = loadConfig('../services/optionstrat/config/optionstrat.json');
  } catch {
    cfg = {};
  }
  if (!Array.isArray(servicesApi.commands)) servicesApi.commands = [];
  servicesApi.commands.push(...createOptionStratCommands(cfg));
  settings.onApply('optionstrat', ({ config }) => {
    const commands = createOptionStratCommands(config);
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
  resolveProviderName,
  normalizeOrderPayload
} = {}) {
  optionStratService = createOptionStratApplicationService({
    servicesApi,
    getAdapter,
    wireAdapter,
    executionService,
    resolveProviderName,
    normalizeOrderPayload
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

module.exports = {
  initService,
  registerActionFunctions,
  registerMainApplicationServices,
  registerMainIpcHandlers,
  rendererLegacyGuards: [createOptionStratLegacyGuard()]
};
