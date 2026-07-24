const assert = require('assert');
const { EventEmitter } = require('events');
const { CCXTExecutionAdapter } = require('../app/services/brokerage-adapter-ccxt/comps/ccxt');

function initializeLifecycleState(adapter) {
  adapter.events = new EventEmitter();
  adapter.pending = new Map();
  adapter._ticketToSymbol = new Map();
  adapter._ticketOpened = new Set();
  adapter._positionClosedTickets = new Set();
  return adapter;
}

function makeProtectionAdapter(markPrice = 100) {
  const adapter = initializeLifecycleState(Object.create(CCXTExecutionAdapter.prototype));
  adapter.provider = 'ccxt:binance';
  adapter.exchange = { options: {} };
  adapter._algoClientToBracket = new Map();
  adapter.requests = [];
  adapter._binanceSignedRequest = async (method, endpoint, request = {}) => {
    if (method === 'GET' && endpoint === '/fapi/v1/openAlgoOrders') return [];
    if (method === 'POST' && endpoint === '/fapi/v1/algoOrder') {
      adapter.requests.push(request);
      return { clientAlgoId: request.clientAlgoId };
    }
    throw new Error(`unexpected request ${method} ${endpoint}`);
  };
  adapter._binancePublicRequest = async () => ({ markPrice: String(markPrice) });
  return adapter;
}

function makeBracket(overrides = {}) {
  return {
    bracketId: 'stop-only',
    symbol: 'BTCUSDT',
    positionSide: 'BOTH',
    direction: 'LONG',
    entryPrice: '100',
    expectedQty: '2',
    actualQty: '2',
    takeProfitPrice: undefined,
    stopLossPrice: '99',
    protectionPriceSource: 'points',
    tickSize: '0.1',
    tpClientAlgoId: null,
    slClientAlgoId: null,
    status: 'ENTRY_FILLED',
    ...overrides
  };
}

async function testStopOnlyLevelOrderKeepsTakeProfitAbsent() {
  const adapter = initializeLifecycleState(Object.create(CCXTExecutionAdapter.prototype));
  adapter.provider = 'ccxt:binance';
  adapter.exchange = { options: {} };
  adapter._brackets = new Map();
  adapter._entryClientToBracket = new Map();
  adapter._algoClientToBracket = new Map();
  adapter.normalizeBinanceUsdmSymbol = async () => 'FILUSDT';
  adapter._getBinanceSymbolFilters = async () => ({ tickSize: 0.0001, stepSize: 0.1, minNotional: 0 });
  adapter._binanceSignedRequest = async (method, endpoint) => {
    assert.strictEqual(method, 'POST');
    assert.strictEqual(endpoint, '/fapi/v1/order');
    return { orderId: 123 };
  };
  adapter._startBracketEntryWatcher = async () => {};

  const result = await adapter._placeBinanceBracketEntry({
    order: {
      sl: 10,
      tp: undefined,
      meta: {
        stopPts: 10,
        takePts: null,
        fixedQty: true,
        strategy: 'limitBidTrade'
      }
    },
    symbol: 'FIL/USDT:USDT',
    side: 'buy',
    amount: 444.4,
    price: 0.7445,
    params: {},
    cid: 'level-order-child'
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.strictEqual(result.status, 'ok');
  const bracket = adapter._brackets.get('level-order-child');
  assert(bracket);
  assert.strictEqual(bracket.takeProfitPrice, undefined);
  assert.strictEqual(bracket.stopLossPrice, '0.7435');
  assert.strictEqual(bracket.tpClientAlgoId, null);
}

async function testPlacesOnlyStopLoss() {
  const adapter = makeProtectionAdapter();
  const bracket = makeBracket();

  await adapter._placeBracketProtection(bracket);

  assert.strictEqual(adapter.requests.length, 1);
  assert.strictEqual(adapter.requests[0].type, 'STOP_MARKET');
  assert.strictEqual(adapter.requests[0].triggerPrice, '99');
  assert.strictEqual(bracket.tpClientAlgoId, null);
  assert.strictEqual(adapter._algoClientToBracket.has('br_stop-only_tp'), false);
  assert.strictEqual(bracket.slClientAlgoId, 'br_stop-only_sl');
  assert.strictEqual(adapter._algoClientToBracket.get('br_stop-only_sl'), 'stop-only');
  assert.strictEqual(bracket.status, 'PROTECTED');
}

async function testExistingTpAndSlBehaviorIsPreserved() {
  const adapter = makeProtectionAdapter();
  const bracket = makeBracket({ takeProfitPrice: '103' });

  await adapter._placeBracketProtection(bracket);

  assert.deepStrictEqual(adapter.requests.map(request => request.type), ['TAKE_PROFIT_MARKET', 'STOP_MARKET']);
  assert.strictEqual(bracket.tpClientAlgoId, 'br_stop-only_tp');
  assert.strictEqual(bracket.slClientAlgoId, 'br_stop-only_sl');
  assert.strictEqual(bracket.status, 'PROTECTED');
}

async function testConcurrentProtectionPlacementIsDeduplicated() {
  const adapter = makeProtectionAdapter();
  const bracket = makeBracket();

  await Promise.all([
    adapter._placeBracketProtection(bracket),
    adapter._placeBracketProtection(bracket)
  ]);
  await adapter._placeBracketProtection(bracket);

  assert.strictEqual(adapter.requests.length, 1);
  assert.strictEqual(bracket.status, 'PROTECTED');
}

async function testReconcileDoesNotRecreateAbsentTakeProfit() {
  const adapter = initializeLifecycleState(Object.create(CCXTExecutionAdapter.prototype));
  adapter.provider = 'ccxt:binance';
  adapter.protectiveOrders = { manualModificationStrategy: 'adopt' };
  adapter._brackets = new Map();
  const bracket = makeBracket({
    status: 'PROTECTED',
    slClientAlgoId: 'br_stop-only_sl'
  });
  adapter._brackets.set(bracket.bracketId, bracket);
  let placementCalls = 0;
  adapter._placeBracketProtection = async () => { placementCalls += 1; };
  adapter.cancelBracketProtection = async () => {};
  adapter._binanceSignedRequest = async (method, endpoint) => {
    if (endpoint === '/fapi/v2/positionRisk') {
      return [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '2' }];
    }
    if (endpoint === '/fapi/v1/openAlgoOrders') {
      return [{ clientAlgoId: 'br_stop-only_sl', triggerPrice: '99' }];
    }
    throw new Error(`unexpected request ${method} ${endpoint}`);
  };

  await adapter._reconcileBrackets();

  assert.strictEqual(placementCalls, 0);
  assert.strictEqual(bracket.tpClientAlgoId, null);
  assert.strictEqual(bracket.status, 'PROTECTED');
}

async function run() {
  await testStopOnlyLevelOrderKeepsTakeProfitAbsent();
  await testPlacesOnlyStopLoss();
  await testExistingTpAndSlBehaviorIsPreserved();
  await testConcurrentProtectionPlacementIsDeduplicated();
  await testReconcileDoesNotRecreateAbsentTakeProfit();
  console.log('binanceStopOnlyProtection.test passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
