const assert = require('assert');
const Module = require('module');

async function run() {
  const calls = [];
  let eventHandler = null;
  const originalLoad = Module._load;

  Module._load = function(request, parent, isMain) {
    const parentFile = String(parent?.filename || '').replace(/\\/g, '/');
    if (request === './dwx_client' && parentFile.endsWith('app/services/brokerage-adapter-dwx/comps/dwx.js')) {
      return {
        dwx_client: class {
          constructor(opts = {}) {
            eventHandler = opts.event_handler;
            this.market_data = {};
            this.open_orders = {};
          }
          start() {}
          async open_order(...args) {
            calls.push(args);
          }
        }
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const { DWXAdapter } = require('../app/services/brokerage-adapter-dwx/comps/dwx');
    const adapter = new DWXAdapter({ metatraderDirPath: 'test', provider: 'mt5-j2t-dwx' });
    let retryCount = 0;
    let rejected = null;
    adapter.on('order:retry', () => { retryCount++; });
    adapter.on('order:rejected', (rec) => { rejected = rec; });
    const res = await adapter.placeOrder({
      instrumentType: 'EQ',
      symbol: 'UPRO',
      side: 'buy',
      type: 'market',
      qty: 40,
      meta: { hedge: true, retry: false, cid: 'abcdef01' }
    });
    assert.strictEqual(res.status, 'ok');
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(calls.length, 1);
    const [, orderType, qty, price, sl, tp] = calls[0];
    assert.strictEqual(orderType, 'buy');
    assert.strictEqual(qty, 40);
    assert.strictEqual(price, 0);
    assert.strictEqual(sl, 0);
    assert.strictEqual(tp, 0);

    eventHandler.on_message({
      type: 'ERROR',
      error_type: 'OPEN_ORDER',
      message: 'invalid params cid:abcdef01'
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(retryCount, 0);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(rejected.pendingId, 'abcdef01');
    assert.strictEqual(rejected.origOrder.meta.retry, false);
  } finally {
    Module._load = originalLoad;
  }

  calls.length = 0;
  eventHandler = null;
  Module._load = function(request, parent, isMain) {
    const parentFile = String(parent?.filename || '').replace(/\\/g, '/');
    if (request === './dwx_client' && parentFile.endsWith('app/services/brokerage-adapter-dwx/comps/dwx.js')) {
      return {
        dwx_client: class {
          constructor(opts = {}) {
            eventHandler = opts.event_handler;
            this.market_data = {};
            this.open_orders = {};
          }
          start() {}
          async open_order(...args) {
            calls.push(args);
          }
        }
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve('../app/services/brokerage-adapter-dwx/comps/dwx')];
    const { DWXAdapter } = require('../app/services/brokerage-adapter-dwx/comps/dwx');
    const adapter = new DWXAdapter({ metatraderDirPath: 'test', provider: 'mt5-j2t-dwx', openOrderRetryDelayMs: 1 });
    adapter.setExecutionRetryPolicy({ shouldRetry: () => true });
    let retryCount = 0;
    adapter.on('order:retry', () => { retryCount++; });
    await adapter.placeOrder({
      instrumentType: 'EQ',
      symbol: 'UPRO',
      side: 'buy',
      type: 'market',
      qty: 40,
      meta: { hedge: true, cid: 'abcdef02' }
    });
    await new Promise(resolve => setImmediate(resolve));
    eventHandler.on_message({
      type: 'ERROR',
      error_type: 'OPEN_ORDER',
      message: 'invalid params cid:abcdef02'
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.strictEqual(retryCount, 1);
    assert.strictEqual(calls.length, 2);
  } finally {
    Module._load = originalLoad;
  }

  console.log('dwx market hedge tests passed');
}

run().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
