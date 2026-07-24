const assert = require('assert');
const { EventEmitter } = require('events');
const { CCXTExecutionAdapter } = require('../app/services/brokerage-adapter-ccxt/comps/ccxt');

function makeAdapter(strategy = 'adopt') {
  const a = Object.create(CCXTExecutionAdapter.prototype);
  a.provider = 'ccxt:binance';
  a.protectiveOrders = { manualModificationStrategy: strategy };
  a.events = new EventEmitter();
  a.pending = new Map();
  a._ticketToSymbol = new Map();
  a._ticketOpened = new Set();
  a._positionClosedTickets = new Set();
  a._brackets = new Map();
  a._placeCalls = 0;
  a._placeBracketProtection = async () => { a._placeCalls += 1; };
  a.cancelBracketProtection = async () => {};
  a._binanceSignedRequest = async (method, endpoint) => {
    if (endpoint === '/fapi/v2/positionRisk') return [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '1' }];
    if (endpoint === '/fapi/v1/openAlgoOrders') return a._openAlgoOrders;
    throw new Error(`unexpected request ${method} ${endpoint}`);
  };
  return a;
}

function addBracket(a) {
  const b = {
    bracketId: 'b1',
    symbol: 'BTCUSDT',
    positionSide: 'BOTH',
    direction: 'LONG',
    tpClientAlgoId: 'br_b1_tp',
    slClientAlgoId: 'br_b1_sl',
    status: 'PROTECTED',
    takeProfitPrice: '110',
    stopLossPrice: '90',
    tickSize: '0.1',
    updatedAt: 1
  };
  a._brackets.set('b1', b);
  return b;
}

(async function testExpectedPriceNoAction() {
  const a = makeAdapter();
  const b = addBracket(a);
  let modified = 0;
  a.events.on('bracket:protection_modified', () => { modified += 1; });
  a._openAlgoOrders = [
    { clientAlgoId: 'br_b1_tp', triggerPrice: '110' },
    { clientAlgoId: 'br_b1_sl', triggerPrice: '90' }
  ];
  await a._reconcileBrackets();
  assert.strictEqual(b.takeProfitPrice, '110');
  assert.strictEqual(b.stopLossPrice, '90');
  assert.strictEqual(a._placeCalls, 0);
  assert.strictEqual(modified, 0);
})();

(async function testManualMoveAdoptsAndDoesNotRecreateOldPrice() {
  const a = makeAdapter('adopt');
  const b = addBracket(a);
  let evt;
  a.events.on('bracket:protection_modified', (e) => { evt = e; });
  a._openAlgoOrders = [
    { clientAlgoId: 'br_b1_tp', triggerPrice: '112' },
    { clientAlgoId: 'br_b1_sl', triggerPrice: '88' }
  ];
  await a._reconcileBrackets();
  assert.strictEqual(b.takeProfitPrice, '112');
  assert.strictEqual(b.stopLossPrice, '88');
  assert.strictEqual(a._placeCalls, 0);
  assert.ok(evt, 'manual modification event was not emitted');
  assert.strictEqual(evt.action, 'adopt');
  assert.strictEqual(evt.bracketId, 'b1');
  assert.ok(evt.leg === 'tp' || evt.leg === 'sl');
})();

(async function testMissingOrderPreservesExistingRecreateBehavior() {
  const a = makeAdapter('adopt');
  addBracket(a);
  a._openAlgoOrders = [
    { clientAlgoId: 'br_b1_tp', triggerPrice: '110' }
  ];
  await a._reconcileBrackets();
  assert.strictEqual(a._placeCalls, 1);
})();

(async function testStopManagingLogsStateAndDoesNotRecreateOldPrice() {
  const a = makeAdapter('stop-managing');
  const b = addBracket(a);
  let evt;
  a.events.on('bracket:protection_modified', (e) => { evt = e; });
  a._openAlgoOrders = [
    { clientAlgoId: 'br_b1_tp', triggerPrice: '111' },
    { clientAlgoId: 'br_b1_sl', triggerPrice: '90' }
  ];
  await a._reconcileBrackets();
  assert.strictEqual(b.status, 'EXTERNALLY_MODIFIED');
  assert.strictEqual(b.takeProfitPrice, '110');
  assert.strictEqual(a._placeCalls, 0);
  assert.ok(b.externalModification);
  assert.ok(evt, 'manual modification event was not emitted');
  assert.strictEqual(evt.action, 'stop-managing');
  assert.strictEqual(evt.brokerPrice, '111');
})();

console.log('binanceProtectiveManualModification.test passed');
