const assert = require('assert');
const { EventEmitter } = require('events');
const {
  createRiskManagerService,
  resolveLimits,
  calculateStopRiskUsd,
  calculateOpenLossUsd,
  deriveStopLossPrice
} = require('../app/services/riskManager');
const { SimulatedAdapter } = require('../app/services/brokerage-adapter-simulated/comps/simulated');
const { DWXAdapter } = require('../app/services/brokerage-adapter-dwx/comps/dwx');
const { J2TExecutionAdapter } = require('../app/services/brokerage-adapter-j2t/comps/j2t');

async function run() {
  const config = {
    enabled: true,
    providers: {
      dwx: {
        enabled: true,
        maxStopRiskUsd: 10,
        maxOpenLossUsd: 5,
        symbols: {
          EURUSD: { maxStopRiskUsd: 3 },
          DISABLED: { enabled: false, maxStopRiskUsd: 1 }
        }
      }
    }
  };

  assert.deepStrictEqual(resolveLimits(config, 'dwx', 'AAPL'), {
    enabled: true,
    maxStopRiskUsd: 10,
    maxOpenLossUsd: 5
  });
  assert.deepStrictEqual(resolveLimits(config, 'DWX', 'eurusd'), {
    enabled: true,
    maxStopRiskUsd: 3,
    maxOpenLossUsd: 5
  });
  assert.strictEqual(resolveLimits(config, 'dwx', 'disabled').enabled, false);
  assert.strictEqual(resolveLimits(config, 'unknown', 'AAPL').enabled, false);

  assert.strictEqual(deriveStopLossPrice({ side: 'buy', entryPrice: 100, sl: 5, tickSize: 0.5 }), 97.5);
  assert.strictEqual(deriveStopLossPrice({ side: 'sell', entryPrice: 100, sl: 5, tickSize: 0.5 }), 102.5);
  assert.strictEqual(calculateStopRiskUsd({ qty: 2, entryPrice: 100, stopLossPrice: 95, contractSize: 1 }), 10);
  assert.strictEqual(calculateStopRiskUsd({ qty: 2, entryPrice: 100, stopLossPrice: 95, contractSize: 100 }), 1000);
  assert.strictEqual(calculateOpenLossUsd({ side: 'buy', qty: 2, entryPrice: 100, currentPrice: 97 }), 6);
  assert.strictEqual(calculateOpenLossUsd({ side: 'sell', qty: 2, entryPrice: 100, currentPrice: 103 }), 6);
  assert.strictEqual(calculateOpenLossUsd({ unrealizedPnl: -5.01 }), 5.01);
  assert.strictEqual(calculateOpenLossUsd({ unrealizedPnl: 2 }), 0);

  let closeCalls = 0;
  const fakeAdapter = {
    provider: 'dwx',
    async getRiskPositionSnapshot() {
      return {
        symbol: 'EURUSD',
        side: 'buy',
        qty: 2,
        entryPrice: 100,
        stopLossPrice: 94,
        unrealizedPnl: -1,
        contractSize: 1
      };
    },
    async closePosition(_position, reason) {
      closeCalls += 1;
      return { status: 'ok', provider: 'dwx', reason };
    }
  };
  const service = createRiskManagerService({
    config,
    brokerage: { getAdapter: () => fakeAdapter },
    instrumentInfo: { get: async () => ({ tickSize: 1, contractSize: 1 }) },
    clock: () => 1000
  });
  service.trackPosition({
    provider: 'dwx',
    ticket: '1',
    origOrder: { symbol: 'EURUSD', side: 'buy', price: 100, sl: 1, tickSize: 1, qty: 1 }
  });
  await service.refreshAll();
  await service.refreshAll();
  assert.strictEqual(closeCalls, 1, 'risk manager should not duplicate close calls while closing');
  const afterBreach = service.snapshot();
  assert.strictEqual(afterBreach.positions[0].status, 'closing');
  assert.ok(afterBreach.logs.some(row => row.type === 'trigger' && row.check === 'maxStopRiskUsd'));

  let missingCloseCalls = 0;
  const missingService = createRiskManagerService({
    config,
    brokerage: {
      getAdapter: () => ({
        async getRiskPositionSnapshot() { return { symbol: 'EURUSD', side: 'buy' }; },
        async closePosition() { missingCloseCalls += 1; return { status: 'ok' }; }
      })
    }
  });
  missingService.trackPosition({ provider: 'dwx', ticket: '2', origOrder: { symbol: 'EURUSD', side: 'buy' } });
  await missingService.refreshAll();
  const missingSnapshot = missingService.snapshot().positions[0];
  assert.strictEqual(missingCloseCalls, 0, 'missing data must warn only');
  assert.strictEqual(missingSnapshot.riskStatus, 'warning');
  assert.ok(missingSnapshot.snapshot.warnings.includes('Missing qty'));

  const bus = new EventEmitter();
  const eventService = createRiskManagerService({
    config: { providers: { dwx: { maxOpenLossUsd: 5 } } },
    events: bus,
    brokerage: {
      getAdapter: () => ({
        async getRiskPositionSnapshot() {
          return { symbol: 'GBPUSD', side: 'sell', qty: 1, entryPrice: 100, stopLossPrice: 105, unrealizedPnl: -6 };
        },
        async closePosition() { return { status: 'ok' }; }
      })
    }
  });
  eventService.bindEvents();
  bus.emit('position:opened', { provider: 'dwx', ticket: '3', origOrder: { symbol: 'GBPUSD', side: 'sell' } });
  await eventService.refreshAll();
  assert.strictEqual(eventService.snapshot().positions[0].status, 'closing');
  bus.emit('position:closed', { provider: 'dwx', ticket: '3' });
  assert.strictEqual(eventService.snapshot().positions.length, 0);

  const simulated = new SimulatedAdapter({ latencyMs: [0, 0] });
  let simulatedClosed = false;
  simulated.on('position:closed', () => { simulatedClosed = true; });
  const simulatedClose = await simulated.closePosition({ ticket: 'SIM-1' }, 'test');
  assert.strictEqual(simulatedClose.status, 'simulated');
  assert.strictEqual(simulatedClosed, true);

  let dwxClosedTicket = null;
  const dwxClose = await DWXAdapter.prototype.closePosition.call({
    provider: 'dwx',
    client: {
      async close_order(ticket, lots) {
        dwxClosedTicket = `${ticket}:${lots}`;
      }
    }
  }, { ticket: '42' }, 'test');
  assert.strictEqual(dwxClose.status, 'ok');
  assert.strictEqual(dwxClosedTicket, '42:0');

  const j2tUnsupported = await J2TExecutionAdapter.prototype.closePosition.call({ provider: 'j2t' });
  assert.strictEqual(j2tUnsupported.status, 'unsupported');
}

run()
  .then(() => console.log('riskManager tests passed'))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
