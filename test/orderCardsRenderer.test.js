const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createOrderCardsRenderer } = require('../app/services/orderCards/renderer');

function createRenderer(overrides = {}) {
  return createOrderCardsRenderer({
    el: () => ({}),
    inputNumber: () => ({ addEventListener() {}, classList: { toggle() {} }, value: '' }),
    uiState: new Map(),
    orderCalc: {
      defaultRiskUsd: () => 10,
      qty: () => 1,
      takePts: value => value * 3
    },
    priceToPoints: () => 1,
    normNum: value => Number(value),
    isPos: value => Number.isFinite(value) && value > 0,
    isSL: value => Number.isFinite(value) && value > 0,
    tickSize: () => 0.01,
    instrumentInfoFor: () => ({}),
    tradeRules: { validate: () => ({ ok: true }) },
    markTouched: () => {},
    detectInstrumentType: () => 'EQ',
    rowKey: row => `${row.ticker}|${row.event}|${row.time}|${row.price}`,
    ipcRenderer: { invoke: async () => ({ status: 'ok' }) },
    pendingByReqId: new Map(),
    pendingIdByReqId: new Map(),
    retryCounts: new Map(),
    pendingExecLabels: new Map(),
    cardByKey: () => null,
    setCardState: () => {},
    pendingActionInfo: () => null,
    toast: () => {},
    shakeCard: () => {},
    render: () => {},
    ...overrides
  });
}

function run() {
  const scheduleCalls = [];
  const typeHandler = {
    shouldScheduleInstantExecution: ({ row }) => row.instantExecution === true,
    scheduleInstantExecution: ({ row, place, instrumentType }) => {
      scheduleCalls.push({ row, place, instrumentType });
      return true;
    }
  };
  const cardTypeHandler = {
    createBody: () => ({ type: 'custom' })
  };

  const renderer = createRenderer({
    instrumentTypeHandlers: { CUSTOM: typeHandler },
    cardTypeHandlers: { customCard: cardTypeHandler }
  });

  assert.strictEqual(renderer.handlerFor({ instrumentType: 'CUSTOM' }), typeHandler);
  assert.strictEqual(renderer.handlerFor({ cardType: 'customCard' }), cardTypeHandler);
  assert.strictEqual(renderer.scheduleInstantExecution({ ticker: 'AAPL', instrumentType: 'CUSTOM', instantExecution: false }, () => {}, 'CUSTOM'), false);
  assert.strictEqual(scheduleCalls.length, 0);
  assert.strictEqual(renderer.scheduleInstantExecution({ ticker: 'AAPL', instrumentType: 'CUSTOM', instantExecution: true }, () => {}, 'CUSTOM'), true);
  assert.strictEqual(scheduleCalls.length, 1);
  assert.strictEqual(scheduleCalls[0].instrumentType, 'CUSTOM');
  assert.strictEqual(renderer.scheduleInstantExecution({ ticker: 'AAPL', instrumentType: 'EQ', instantExecution: true }, () => {}, 'EQ'), false);

  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
  [
    'createOptionStratRenderer',
    'optionStratRenderer',
    'optionstrat/renderer',
    'emitOptionStratButtonEvent',
    'ensureOptionPayoff',
    "instrumentType === 'OPT'",
    "instrumentType !== 'OPT'"
  ].forEach(pattern => {
    assert.strictEqual(rendererSource.includes(pattern), false, `app/renderer.js still contains ${pattern}`);
  });

  console.log('orderCardsRenderer tests passed');
}

run();
