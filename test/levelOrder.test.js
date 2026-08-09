const assert = require('assert');
const { LevelOrderCommand, LevelOrderPlaceCommand, buildLevelOrderRow } = require('../app/services/levelOrder/command');
const {
  resolveLevelOrderDefaults,
  splitQuantity,
  roundQtyToStep,
  calculateLimitBidTradePlan
} = require('../app/services/levelOrder/domain/strategy');

const orderCalculator = {
  qty({ riskUsd, stopPts, tickSize, instrumentType }) {
    const raw = riskUsd / (stopPts * tickSize);
    return instrumentType === 'EQ' ? Math.floor(raw) : Number(raw.toFixed(3));
  }
};

(function testCommand() {
  let row;
  const onAddResult = { ok: true, position: { card: { type: 'levelOrder' } } };
  const cmd = new LevelOrderCommand({ now: () => 123, onAdd: r => { row = r; return onAddResult; } });
  const res = cmd.run(['spx.cfd', '7500']);
  assert.strictEqual(res, onAddResult);
  assert.strictEqual(res.position.card.type, 'levelOrder');
  assert.deepStrictEqual(row, {
    cardType: 'levelOrder',
    ticker: 'spx.cfd',
    level: 7500,
    event: 'levelOrder',
    time: 123
  });
  assert.strictEqual(buildLevelOrderRow(['SPX']).ok, false);
})();

(async function testCommandAwaitsAsyncOnAdd() {
  const cmd = new LevelOrderCommand({
    now: () => 123,
    onAdd: async (row) => ({ ok: true, position: { ticker: row.ticker, card: { type: row.cardType } } })
  });
  const res = await cmd.run(['spx.cfd', '7500']);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.position.ticker, 'spx.cfd');
  assert.strictEqual(res.position.card.type, 'levelOrder');

  const failing = new LevelOrderCommand({
    now: () => 123,
    onAdd: async () => { throw new Error('async add failed'); }
  });
  const failed = await failing.run(['spx.cfd', '7500']);
  assert.deepStrictEqual(failed, { ok: false, error: 'async add failed' });
})().catch(err => {
  console.error(err);
  process.exit(1);
});

(function testCommandRequiresAddHandler() {
  const cmd = new LevelOrderCommand({ now: () => 123 });
  const res = cmd.run(['spx.cfd', '7500']);
  assert.deepStrictEqual(res, { ok: false, error: 'Order add handler unavailable' });
})();

(function testCommandProps() {
  let row;
  const cmd = new LevelOrderCommand({ now: () => 123, onAdd: r => { row = r; } });
  let res = cmd.run(['spx.cfd', '7500', 'props=producingLineId:foo']);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(row.producingLineId, 'foo');

  res = cmd.run(['spx.cfd', '7500', 'props=producingLineId:foo;source:tv;note:line']);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(row.producingLineId, 'foo');
  assert.strictEqual(row.source, 'tv');
  assert.strictEqual(row.note, 'line');

  res = cmd.run(['spx.cfd', '7500', 'props=ticker:BAD;level:1;event:bad;time:999;cardType:bad;producingLineId:foo']);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(row, {
    cardType: 'levelOrder',
    ticker: 'spx.cfd',
    level: 7500,
    event: 'levelOrder',
    time: 123,
    producingLineId: 'foo'
  });

  assert.strictEqual(buildLevelOrderRow(['SPX', '7500', 'props=bad']).ok, false);
  assert.strictEqual(buildLevelOrderRow(['SPX', '7500', 'props=bad:']).ok, false);
  assert.strictEqual(buildLevelOrderRow(['SPX', '7500', 'props=bad-key:value']).ok, false);
  assert.strictEqual(buildLevelOrderRow(['SPX', '7500', 'extra']).ok, false);
})();

(async function testImmediateCommand() {
  const queued = [];
  const servicesApi = {
    execution: {
      async queueLevelOrder(payload) {
        queued.push(payload);
        return { status: 'ok', provider: 'simulated', providerOrderId: 'level:test' };
      }
    }
  };
  const cfg = {
    defaults: { maxLot: 10, minLot: 1, stopOffsetPts: 3, takeProfitPts: 20, buyPriceSource: 'ask', sellPriceSource: 'bid' }
  };
  const buy = new LevelOrderPlaceCommand('LB', {
    servicesApi,
    getConfig: () => cfg,
    now: () => 123456
  });
  let res = await buy.run(['upRo', '100', '4', '50']);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(queued.length, 1);
  assert.strictEqual(queued[0].ticker, 'upRo');
  assert.strictEqual(queued[0].action, 'LB');
  assert.strictEqual(queued[0].level, 100);
  assert.strictEqual(queued[0].stopOffsetPts, 4);
  assert.strictEqual(queued[0].riskUsd, 50);
  assert.strictEqual(queued[0].maxLot, 10);
  assert.strictEqual(queued[0].takeProfitPts, 20);
  assert.strictEqual(queued[0].buyPriceSource, 'ask');
  assert.strictEqual(queued[0].requestId.startsWith('123456_'), true);
  assert.strictEqual(queued[0].strategyId.endsWith('_lb'), true);
  assert.strictEqual(queued[0].meta.source, 'commandLine');

  const sell = new LevelOrderPlaceCommand('LS', { servicesApi, getConfig: () => cfg, now: () => 123457 });
  res = await sell.run(['MNQ', '101', '5', '60']);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(queued[1].ticker, 'MNQ');
  assert.strictEqual(queued[1].action, 'LS');
  assert.strictEqual(queued[1].strategyId.endsWith('_ls'), true);

  servicesApi.levelOrder = {
    getLevelResolver(name) {
      if (name !== 'levelTrack') return null;
      return async ({ key, ticker, action }) => {
        assert.strictEqual(key, 'spx-main');
        assert.strictEqual(ticker, 'SPX');
        assert.strictEqual(action, 'LB');
        return { ok: true, level: 7500 };
      };
    }
  };
  res = await buy.run(['SPX', 'f:levelTrack:spx-main', '10', '500']);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(queued[2].ticker, 'SPX');
  assert.strictEqual(queued[2].level, 7500);

  servicesApi.levelOrder = {
    getLevelResolver() {
      return async () => ({ ok: false, error: 'No active level' });
    }
  };
  res = await buy.run(['SPX', 'f:levelTrack:spx-main', '10', '500']);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'No active level');

  servicesApi.levelOrder = { getLevelResolver: () => null };
  res = await buy.run(['SPX', 'f:missing:spx-main', '10', '500']);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'Level resolver is not registered: missing');

  res = await buy.run(['UPRO', '100', '0', '50']);
  assert.strictEqual(res.ok, false);

  res = await buy.run(['100', '4', '50']);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'Usage: levelOrder-{buy|sell} {ticker} {level} {levelOffset} {risk}');
})().catch(err => {
  console.error(err);
  process.exit(1);
});

(function testDefaults() {
  const cfg = {
    defaults: { maxLot: 0, minLot: 1, stopOffsetPts: 10, takeProfitPts: null, buyPriceSource: 'bid', sellPriceSource: 'bid' },
    symbols: [{ ticker: 'SPX.cfd', maxLot: 3, minLot: 0.01, stopOffsetPts: 5, takeProfitPts: 30, buyPriceSource: 'mid', sellPriceSource: 'ask' }]
  };
  assert.deepStrictEqual(resolveLevelOrderDefaults(cfg, 'SPX.cfd'), {
    maxLot: 3,
    minLot: 0.01,
    stopOffsetPts: 5,
    takeProfitPts: 30,
    buyPriceSource: 'mid',
    sellPriceSource: 'ask'
  });
  assert.deepStrictEqual(resolveLevelOrderDefaults(cfg, 'AAPL'), {
    maxLot: 0,
    minLot: 1,
    stopOffsetPts: 10,
    takeProfitPts: null,
    buyPriceSource: 'bid',
    sellPriceSource: 'bid'
  });
  assert.deepStrictEqual(resolveLevelOrderDefaults({
    defaults: { buyPriceSource: 'bad', sellPriceSource: '' },
    symbols: [{ ticker: 'BAD', buyPriceSource: 'nope', sellPriceSource: 'MID' }]
  }, 'BAD'), {
    maxLot: 0,
    minLot: 1,
    stopOffsetPts: null,
    takeProfitPts: null,
    buyPriceSource: 'bid',
    sellPriceSource: 'mid'
  });
})();

(function testSideValidationAndMath() {
  const buy = calculateLimitBidTradePlan({
    action: 'LB',
    ticker: 'TST',
    instrumentType: 'EQ',
    level: 100,
    riskUsd: 110,
    stopOffsetPts: 2,
    maxLot: 5,
    takeProfitPts: 9,
    bid: 100,
    ask: 101,
    buyPriceSource: 'ask',
    tickSize: 0.5,
    orderCalculator
  });
  assert.strictEqual(buy.ok, true);
  assert.strictEqual(buy.orderKind, 'BL');
  assert.strictEqual(buy.priceSource, 'ask');
  assert.strictEqual(buy.referencePrice, 101);
  assert.strictEqual(buy.levelDistancePts, 2);
  assert.strictEqual(buy.stopPts, 4);
  assert.strictEqual(buy.stopPrice, 99);
  assert.strictEqual(buy.totalQty, 55);
  assert.deepStrictEqual(buy.childQtys, [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
  assert.strictEqual(buy.takeProfitPts, 9);

  const sell = calculateLimitBidTradePlan({
    action: 'LS',
    ticker: 'TST',
    instrumentType: 'EQ',
    level: 100,
    riskUsd: 110,
    stopOffsetPts: 2,
    maxLot: 0,
    bid: 99,
    ask: 100,
    sellPriceSource: 'bid',
    tickSize: 0.5,
    orderCalculator
  });
  assert.strictEqual(sell.ok, true);
  assert.strictEqual(sell.orderKind, 'SL');
  assert.strictEqual(sell.priceSource, 'bid');
  assert.strictEqual(sell.referencePrice, 99);
  assert.strictEqual(sell.stopPrice, 101);
  assert.deepStrictEqual(sell.childQtys, [55]);

  assert.strictEqual(calculateLimitBidTradePlan({
    action: 'LB', level: 100, riskUsd: 1, stopOffsetPts: 1, bid: 99, ask: 99, buyPriceSource: 'ask', tickSize: 1, orderCalculator
  }).ok, false);
  assert.strictEqual(calculateLimitBidTradePlan({
    action: 'LS', level: 100, riskUsd: 1, stopOffsetPts: 1, bid: 101, ask: 101, sellPriceSource: 'bid', tickSize: 1, orderCalculator
  }).ok, false);
})();

(function testPriceSources() {
  const mid = calculateLimitBidTradePlan({
    action: 'LB',
    ticker: 'TST',
    instrumentType: 'EQ',
    level: 100,
    riskUsd: 100,
    stopOffsetPts: 1,
    maxLot: 0,
    bid: 100,
    ask: 102,
    buyPriceSource: 'mid',
    tickSize: 1,
    orderCalculator
  });
  assert.strictEqual(mid.ok, true);
  assert.strictEqual(mid.priceSource, 'mid');
  assert.strictEqual(mid.referencePrice, 101);
  assert.strictEqual(mid.levelDistancePts, 1);

  const missingMid = calculateLimitBidTradePlan({
    action: 'LB',
    level: 100,
    riskUsd: 1,
    stopOffsetPts: 1,
    bid: 100,
    buyPriceSource: 'mid',
    tickSize: 1,
    orderCalculator
  });
  assert.strictEqual(missingMid.ok, false);
  assert.strictEqual(missingMid.reason, 'Bid/Ask quote required');

  const fallback = calculateLimitBidTradePlan({
    action: 'LB',
    ticker: 'TST',
    instrumentType: 'EQ',
    level: 98,
    riskUsd: 100,
    stopOffsetPts: 1,
    maxLot: 0,
    bid: 99,
    ask: 101,
    buyPriceSource: 'last',
    tickSize: 1,
    orderCalculator
  });
  assert.strictEqual(fallback.ok, true);
  assert.strictEqual(fallback.priceSource, 'bid');
  assert.strictEqual(fallback.referencePrice, 99);
})();

(function testSplitRemainder() {
  assert.strictEqual(roundQtyToStep(12.349, 0.01), 12.34);
  assert.deepStrictEqual(splitQuantity(12.3, 5, 'CX'), [5, 5, 2]);
  assert.deepStrictEqual(splitQuantity(12.3, 0, 'CX'), [12]);
  assert.deepStrictEqual(splitQuantity(12.34, 5, 'CX', 0.01), [5, 5, 2.34]);
  assert.deepStrictEqual(splitQuantity(12.34, 0, 'CX', 0.01), [12.34]);
  assert.deepStrictEqual(splitQuantity(12.3, 5, 'EQ'), [5, 5, 2]);
})();

(function testFractionalMinLotPlan() {
  const plan = calculateLimitBidTradePlan({
    action: 'LB',
    ticker: 'TST',
    instrumentType: 'EQ',
    level: 100,
    riskUsd: 100.03,
    stopOffsetPts: 1,
    maxLot: 50,
    minLot: 0.01,
    bid: 100,
    ask: 100,
    tickSize: 1,
    orderCalculator: {
      qty() { return 100.03; }
    }
  });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.minLot, 0.01);
  assert.deepStrictEqual(plan.childQtys, [50, 50, 0.03]);
})();

console.log('levelOrder tests passed');
