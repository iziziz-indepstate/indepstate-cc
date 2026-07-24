const assert = require('assert');
const { EventEmitter } = require('events');
const {
  DWXAdapter,
  calculateDwxProtectionPrices,
  filterDwxBars,
  isDwxOpenPosition,
  isDwxPendingOrder,
  normalizeDwxBar
} = require('../app/services/brokerage-adapter-dwx/comps/dwx');

async function run() {
  assert.deepStrictEqual(calculateDwxProtectionPrices({
    side: 'buy',
    price: 100,
    sl: 10,
    tp: undefined,
    tickSize: 0.5
  }), { sl: 95, tp: 0 });
  assert.deepStrictEqual(calculateDwxProtectionPrices({
    side: 'sell',
    price: 100,
    sl: 10,
    tp: 20,
    tickSize: 0.5
  }), { sl: 105, tp: 90 });
  assert.strictEqual(isDwxPendingOrder({ type: 'buylimit' }), true);
  assert.strictEqual(isDwxPendingOrder({ type: 'sellstop' }), true);
  assert.strictEqual(isDwxOpenPosition({ type: 'buylimit' }), false);
  assert.strictEqual(isDwxOpenPosition({ type: 'buy' }), true);
  assert.strictEqual(isDwxOpenPosition({ type: 'sell' }), true);

  const normalized = normalizeDwxBar('1781078460', {
    open: '1.1000',
    high: '1.1010',
    low: '1.0990',
    close: '1.1005',
    tick_volume: '42'
  });
  assert.deepStrictEqual(normalized, {
    time: '2026-06-10T08:01:00.000Z',
    open: 1.1,
    high: 1.101,
    low: 1.099,
    close: 1.1005,
    raw: {
      open: '1.1000',
      high: '1.1010',
      low: '1.0990',
      close: '1.1005',
      tick_volume: '42'
    },
    volume: 42
  });

  const data = {
    1781078520: { open: '1.2', high: '1.3', low: '1.1', close: '1.25', volume: '5' },
    1781078400: { open: '1.0', high: '1.1', low: '0.9', close: '1.05' },
    1781078580: { open: '2.0', high: '2.1', low: '1.9', close: '2.05' }
  };
  const filtered = filterDwxBars(data, {
    from: new Date('2026-06-10T08:00:30.000Z'),
    to: new Date('2026-06-10T08:03:00.000Z'),
    limit: 1
  });
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].time, '2026-06-10T08:02:00.000Z');

  const events = new EventEmitter();
  const requested = [];
  const fakeAdapter = Object.create(DWXAdapter.prototype);
  fakeAdapter.events = events;
  fakeAdapter.client = {
    historic_data: {},
    get_historic_data(args) {
      requested.push(args);
      setImmediate(() => {
        this.historic_data.EURUSD_M1 = {
          1781078400: { open: '1.0', high: '1.1', low: '0.9', close: '1.05' },
          1781078460: { open: '1.1', high: '1.2', low: '1.0', close: '1.15', tick_volume: '7' },
          1781078520: { open: '1.2', high: '1.3', low: '1.1', close: '1.25' }
        };
        events.emit('dwx:historic_data', {
          symbol: 'EURUSD',
          timeframe: 'M1',
          data: this.historic_data.EURUSD_M1
        });
      });
    }
  };
  fakeAdapter._historicBarsRequestChain = Promise.resolve();

  const bars = await fakeAdapter.getHistoricBars({
    symbol: 'EURUSD',
    timeframe: 'm1',
    from: new Date('2026-06-10T08:01:00.000Z'),
    to: new Date('2026-06-10T08:02:00.000Z'),
    limit: 10,
    timeoutMs: 100
  });
  assert.deepStrictEqual(requested, [{
    symbol: 'EURUSD',
    time_frame: 'M1',
    start: 1781078460,
    end: 1781078520
  }]);
  assert.strictEqual(bars.length, 2);
  assert.strictEqual(bars[0].time, '2026-06-10T08:01:00.000Z');
  assert.strictEqual(bars[0].volume, 7);
  assert.strictEqual(bars[1].time, '2026-06-10T08:02:00.000Z');

  const timeoutAdapter = Object.create(DWXAdapter.prototype);
  timeoutAdapter.events = new EventEmitter();
  timeoutAdapter.client = {
    historic_data: {
      GBPUSD_M5: {
        1781078400: { open: '1.3', high: '1.4', low: '1.2', close: '1.35' }
      }
    },
    get_historic_data() {}
  };
  timeoutAdapter._historicBarsRequestChain = Promise.resolve();
  const cachedBars = await timeoutAdapter.getHistoricBars({
    symbol: 'GBPUSD',
    timeframe: 'M5',
    from: new Date('2026-06-10T08:00:00.000Z'),
    to: new Date('2026-06-10T08:05:00.000Z'),
    timeoutMs: 1
  });
  assert.strictEqual(cachedBars.length, 1);
  assert.strictEqual(cachedBars[0].time, '2026-06-10T08:00:00.000Z');

  console.log('dwx historic bars tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });
