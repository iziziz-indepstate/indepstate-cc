const path = require('path');
const settings = require('../settings');
const points = require('./points');
const { createInstrumentInfoService } = require('.');
const { createInstrumentInfoActionFunctions } = require('./actionFunctions');

settings.register(
  'tick-sizes',
  path.join(__dirname, 'config', 'tick-sizes.json'),
  path.join(__dirname, 'config', 'tick-sizes-settings-descriptor.json')
);

settings.onApply('tick-sizes', ({ config }) => {
  points.configure(config);
});

function registerActionFunctions(servicesApi = {}) {
  const bus = servicesApi.actionBus;
  const instrumentInfo = servicesApi.instrumentInfo;
  if (!bus || typeof bus.registerActionFunction !== 'function' || !instrumentInfo) return [];
  const actionFunctions = createInstrumentInfoActionFunctions(instrumentInfo);
  return Object.entries(actionFunctions)
    .map(([name, fn]) => bus.registerActionFunction(name, fn))
    .filter(Boolean);
}

function bridgeUpdatedEvents(servicesApi = {}) {
  const bus = servicesApi.actionBus;
  const instrumentInfo = servicesApi.instrumentInfo;
  if (!bus || !instrumentInfo || typeof instrumentInfo.on !== 'function' || bus.__instrumentInfoBridge) return false;
  bus.__instrumentInfoBridge = instrumentInfo.on('updated', snapshot => bus.emit('instrument-info:updated', snapshot));
  return true;
}

function initService(servicesApi = {}) {
  if (!servicesApi.instrumentInfo) {
    servicesApi.instrumentInfo = createInstrumentInfoService({
      brokerage: servicesApi.brokerage,
      onError(err, context) {
        console.error('[instrumentInfo]', err?.message || err, context);
      }
    });
  }
  settings.onApply('tick-sizes', () => {
    servicesApi.instrumentInfo?.invalidateConfigTickSizes?.();
  });
  registerActionFunctions(servicesApi);
  bridgeUpdatedEvents(servicesApi);
}

module.exports = { initService, registerActionFunctions, bridgeUpdatedEvents };
