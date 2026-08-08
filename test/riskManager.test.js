const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
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
    ticket: 'casing',
    origOrder: { symbol: 'ADAUSDT.cfd', side: 'buy', price: 0.1648, sl: 1, tickSize: 0.0001, qty: 1 }
  });
  assert.strictEqual(service.snapshot().positions[0].symbol, 'ADAUSDT.cfd');
  service.untrackPosition({ provider: 'dwx', ticket: 'casing' });

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
  const stopTrigger = afterBreach.logs.find(row => row.type === 'trigger' && row.check === 'maxStopRiskUsd');
  assert.strictEqual(stopTrigger.itemKind, 'position');
  assert.strictEqual(stopTrigger.action, 'close position');
  assert.strictEqual(stopTrigger.checkLabel, 'Stop size');

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

  let stoppedPendingId = null;
  const pendingService = createRiskManagerService({
    config: { providers: { dwx: { maxStopRiskUsd: 1 } } },
    brokerage: {
      getAdapter: () => ({
        stopOpenOrder(pendingId) { stoppedPendingId = pendingId; }
      })
    }
  });
  pendingService.trackOrder({
    order: { symbol: 'ADAUSDT.cfd', side: 'buy', type: 'limit', price: 0.1648, sl: 100, tickSize: 0.0001, qty: 200 },
    result: { status: 'ok', provider: 'dwx', providerOrderId: 'pending:cid-pending', cid: 'cid-pending' }
  });
  await pendingService.refreshAll();
  let pendingSnapshot = pendingService.snapshot();
  assert.strictEqual(stoppedPendingId, 'cid-pending');
  assert.strictEqual(pendingSnapshot.positions[0].kind, 'order');
  assert.strictEqual(pendingSnapshot.positions[0].status, 'cancelling');
  const pendingTrigger = pendingSnapshot.logs.find(row => row.type === 'trigger');
  assert.strictEqual(pendingTrigger.itemKind, 'order');
  assert.strictEqual(pendingTrigger.action, 'cancel pending');
  assert.strictEqual(pendingTrigger.checkLabel, 'Stop size');
  await pendingService.refreshAll();
  assert.strictEqual(stoppedPendingId, 'cid-pending', 'pending cancel must be idempotent while cancelling');

  let cancelledTicket = null;
  const confirmedService = createRiskManagerService({
    config: { providers: { dwx: { maxStopRiskUsd: 1 } } },
    brokerage: {
      getAdapter: () => ({
        async cancelOrder(ticket, symbol) {
          cancelledTicket = `${ticket}:${symbol}`;
          return { status: 'ok', provider: 'dwx' };
        }
      })
    }
  });
  confirmedService.trackOrder({
    order: { symbol: 'ADAUSDT.cfd', side: 'buy', type: 'limit', price: 0.1648, sl: 100, tickSize: 0.0001, qty: 200 },
    result: { status: 'ok', provider: 'dwx', providerOrderId: 'pending:cid-working', cid: 'cid-working' }
  });
  confirmedService.confirmOrder({
    provider: 'dwx',
    pendingId: 'cid-working',
    ticket: '777',
    order: { symbol: 'ADAUSDT.cfd', side: 'buy', type: 'limit', price: 0.1648, sl: 100, tickSize: 0.0001, qty: 200 }
  });
  assert.strictEqual(confirmedService.snapshot().positions[0].ticket, '777');
  await confirmedService.refreshAll();
  assert.strictEqual(cancelledTicket, '777:ADAUSDT.cfd');
  assert.strictEqual(confirmedService.snapshot().logs.find(row => row.type === 'trigger').action, 'cancel order');

  let openLossClosed = false;
  const openLossService = createRiskManagerService({
    config: { providers: { dwx: { maxOpenLossUsd: 5 } } },
    brokerage: {
      getAdapter: () => ({
        async getRiskPositionSnapshot() {
          return { symbol: 'EURUSD', side: 'buy', qty: 1, entryPrice: 100, stopLossPrice: 95, unrealizedPnl: -6 };
        },
        async closePosition() {
          openLossClosed = true;
          return { status: 'ok', provider: 'dwx' };
        }
      })
    }
  });
  openLossService.trackPosition({ provider: 'dwx', ticket: 'loss-1', origOrder: { symbol: 'EURUSD', side: 'buy' } });
  await openLossService.refreshAll();
  const openLossTrigger = openLossService.snapshot().logs.find(row => row.type === 'trigger');
  assert.strictEqual(openLossClosed, true);
  assert.strictEqual(openLossTrigger.itemKind, 'position');
  assert.strictEqual(openLossTrigger.action, 'close position');
  assert.strictEqual(openLossTrigger.checkLabel, 'Open loss');
  assert.strictEqual(openLossTrigger.check, 'maxOpenLossUsd');

  const snapshotsForClose = [
    { symbol: 'EURUSD', side: 'buy', qty: 1, entryPrice: 100, stopLossPrice: 90, unrealizedPnl: -6 },
    { symbol: 'EURUSD', side: 'sell', qty: 2, entryPrice: 100, stopLossPrice: 105, unrealizedPnl: -6 }
  ];
  let snapshotPassedToClose = null;
  const freshCloseService = createRiskManagerService({
    config: { providers: { dwx: { maxOpenLossUsd: 5 } } },
    brokerage: {
      getAdapter: () => ({
        async getRiskPositionSnapshot() {
          return snapshotsForClose.shift();
        },
        async closePosition(position) {
          snapshotPassedToClose = position.snapshot;
          return { status: 'ok', provider: 'dwx' };
        }
      })
    }
  });
  freshCloseService.trackPosition({ provider: 'dwx', ticket: 'fresh-1', origOrder: { symbol: 'EURUSD', side: 'buy' } });
  await freshCloseService.refreshAll();
  assert.strictEqual(snapshotPassedToClose.side, 'sell');
  assert.strictEqual(snapshotPassedToClose.qty, 2);

  const transitionService = createRiskManagerService({
    config: { providers: { dwx: { maxStopRiskUsd: 100 } } },
    brokerage: { getAdapter: () => ({ async getRiskPositionSnapshot() { return null; } }) }
  });
  transitionService.trackOrder({
    order: { symbol: 'ADAUSDT.cfd', side: 'buy', type: 'limit', price: 0.1648, sl: 10, tickSize: 0.0001, qty: 1 },
    result: { status: 'ok', provider: 'dwx', providerOrderId: '123' }
  });
  transitionService.trackPosition({
    provider: 'dwx',
    ticket: '123',
    origOrder: { symbol: 'ADAUSDT.cfd', side: 'buy', price: 0.1648, sl: 10, tickSize: 0.0001, qty: 1 }
  });
  const transitioned = transitionService.snapshot().positions[0];
  assert.strictEqual(transitioned.kind, 'position');
  assert.strictEqual(transitioned.status, 'open');

  const simulated = new SimulatedAdapter({ latencyMs: [0, 0] });
  let simulatedClosed = false;
  simulated.on('position:closed', () => { simulatedClosed = true; });
  const simulatedClose = await simulated.closePosition({ ticket: 'SIM-1' }, 'test');
  assert.strictEqual(simulatedClose.status, 'simulated');
  assert.strictEqual(simulatedClosed, true);

  let dwxClosedTicket = null;
  let dwxRejected = null;
  const dwxPending = new Map([
    ['rm-cid', { order: { symbol: 'ADAUSDT.cfd' } }],
    ['silent-cid', { order: { symbol: 'ADAUSDT.cfd' } }]
  ]);
  DWXAdapter.prototype.stopOpenOrder.call({
    pending: dwxPending,
    events: { emit(eventName, payload) { dwxRejected = { eventName, payload }; } }
  }, 'silent-cid');
  assert.strictEqual(dwxRejected, null);
  DWXAdapter.prototype.stopOpenOrder.call({
    pending: dwxPending,
    events: { emit(eventName, payload) { dwxRejected = { eventName, payload }; } }
  }, 'rm-cid', 'risk breach');
  assert.strictEqual(dwxRejected.eventName, 'order:rejected');
  assert.strictEqual(dwxRejected.payload.reason, 'risk breach');

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

  const descriptor = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'app', 'services', 'riskManager', 'config', 'risk-manager-settings-descriptor.json'),
    'utf8'
  ));
  assert.strictEqual(descriptor.options.providers.__allowUnknown, true);
  assert.strictEqual(descriptor.options.providers.__replace, true);
  const defaultRiskManagerConfig = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'app', 'services', 'riskManager', 'config', 'risk-manager.json'),
    'utf8'
  ));
  assert.strictEqual(defaultRiskManagerConfig.providers.optionstrat, undefined);

  const loadConfig = require('../app/config/load');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-manager-config-'));
  const originalRoots = loadConfig.CONFIG_ROOTS.slice();
  try {
    const defaultsRoot = path.join(tempRoot, 'defaults');
    const overrideRoot = path.join(tempRoot, 'override');
    fs.mkdirSync(defaultsRoot, { recursive: true });
    fs.mkdirSync(overrideRoot, { recursive: true });
    loadConfig.CONFIG_ROOTS.length = 0;
    loadConfig.CONFIG_ROOTS.push(overrideRoot);
    const defaultsPath = path.join(defaultsRoot, 'risk-manager.json');
    fs.writeFileSync(defaultsPath, JSON.stringify({
      providers: {
        dwx: { enabled: true, maxStopRiskUsd: 10, symbols: {} }
      }
    }));
    fs.writeFileSync(path.join(defaultsRoot, 'risk-manager-settings-descriptor.json'), JSON.stringify({
      options: {
        providers: { __allowUnknown: true, __replace: true }
      }
    }));
    fs.writeFileSync(path.join(overrideRoot, 'risk-manager.json'), JSON.stringify({
      providers: {
        dwx: { enabled: true, maxStopRiskUsd: 22, symbols: { 'ADAUSDT.cfd': { maxOpenLossUsd: 7 } } },
        optionstrat: { enabled: true, maxStopRiskUsd: 50, symbols: { SPY: { maxOpenLossUsd: 25 } } },
        custom: { enabled: true, maxStopRiskUsd: 3, symbols: { TEST: { maxOpenLossUsd: 1 } } }
      }
    }));
    const loaded = loadConfig(defaultsPath);
    assert.strictEqual(loaded.providers.dwx.maxStopRiskUsd, 22);
    assert.strictEqual(loaded.providers.dwx.symbols['ADAUSDT.cfd'].maxOpenLossUsd, 7);
    assert.strictEqual(loaded.providers.optionstrat.maxStopRiskUsd, 50);
    assert.strictEqual(loaded.providers.optionstrat.symbols.SPY.maxOpenLossUsd, 25);
    assert.strictEqual(loaded.providers.custom.maxStopRiskUsd, 3);
  } finally {
    loadConfig.CONFIG_ROOTS.length = 0;
    originalRoots.forEach(root => loadConfig.CONFIG_ROOTS.push(root));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

run()
  .then(() => console.log('riskManager tests passed'))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
