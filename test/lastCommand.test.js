const assert = require('assert');
const manifest = require('../app/services/tvListener/manifest');
const aggregatorManifest = require('../app/services/tvAggregatorListener/manifest');
const { createActionsBus } = require('../app/services/actions-bus');
const { createCommandService } = require('../app/services/commandLine');

function run() {
  const emitted = [];
  const bus = createActionsBus();
  ['tv-tool-horzline', 'tv-tool-horzray', 'tv-tool-horzline-ray', 'tv-tool-horzline-remove', 'tv-tool-horzray-remove']
    .forEach(event => bus.on(event, payload => emitted.push({ event, payload })));
  const api = {
    commands: [],
    actionBus: bus,
    tvProxy: { addListener(fn) { this.fn = fn; } }
  };
  aggregatorManifest.initService(api);
  manifest.initService(api);
  const samplePayload = {
    sources: {
      foo: {
        state: { type: 'LineToolHorzLine', points: [{ price: 1.5 }] },
        symbol: 'NYSE:AAA',
        serverUpdateTime: 1000
      }
    }
  };
  api.tvProxy.fn({ event: 'http_request', text: JSON.stringify(samplePayload) });

  assert.deepStrictEqual(emitted, [{
    event: 'tv-tool-horzline',
    payload: { symbol: 'NYSE:AAA', price: 1.5, toolType: 'LineToolHorzLine', lineId: 'foo', serverUpdateTime: 1000 }
  }]);
  assert.deepStrictEqual(api.tvListener.getLastActivity(), { symbol: 'NYSE:AAA', price: 1.5, lineId: 'foo' });
  assert.deepStrictEqual(api.tvAggregatorListener.getState('NYSE:AAA').line, {
    symbol: 'NYSE:AAA', price: 1.5, toolType: 'LineToolHorzLine', lineId: 'foo', serverUpdateTime: 1000
  });

  api.tvProxy.fn({
    event: 'http_request',
    text: JSON.stringify({
      sources: {
        ray1: {
          state: { type: 'LineToolHorzRay', points: [{ price: 1.35 }] },
          symbol: 'NYSE:AAA',
          serverUpdateTime: 2000
        }
      }
    })
  });

  assert.deepStrictEqual(api.tvListener.getLastActivity(), { symbol: 'NYSE:AAA', price: 1.5, lineId: 'foo' });
  assert.deepStrictEqual(api.tvAggregatorListener.getState('NYSE:AAA').ray, {
    symbol: 'NYSE:AAA', rayPrice: 1.35, price: 1.35, toolType: 'LineToolHorzRay', rayId: 'ray1', serverUpdateTime: 2000
  });
  assert.deepStrictEqual(emitted.slice(1), [
    {
      event: 'tv-tool-horzray',
      payload: { symbol: 'NYSE:AAA', rayPrice: 1.35, price: 1.35, toolType: 'LineToolHorzRay', rayId: 'ray1', serverUpdateTime: 2000 }
    },
    {
      event: 'tv-tool-horzline-ray',
      payload: {
        symbol: 'NYSE:AAA',
        price: 1.5,
        linePrice: 1.5,
        lineId: 'foo',
        rayPrice: 1.35,
        rayId: 'ray1',
        lineServerUpdateTime: 1000,
        rayServerUpdateTime: 2000
      }
    }
  ]);

  const beforeDifferentSymbol = emitted.length;
  api.tvProxy.fn({
    event: 'http_request',
    text: JSON.stringify({
      sources: {
        ray2: {
          state: { type: 'LineToolHorzRay', points: [{ price: 2.25 }] },
          symbol: 'NYSE:BBB',
          serverUpdateTime: 3000
        }
      }
    })
  });
  assert.strictEqual(emitted.length, beforeDifferentSymbol + 1);
  assert.strictEqual(emitted[emitted.length - 1].event, 'tv-tool-horzray');
  assert.deepStrictEqual(api.tvAggregatorListener.getState('NYSE:BBB').line, null);
  assert.strictEqual(api.tvAggregatorListener.getState('NYSE:BBB').ray.rayPrice, 2.25);

  api.tvProxy.fn({ event: 'http_request', text: JSON.stringify({ sources: { foo: null, ray1: null } }) });
  assert.deepStrictEqual(emitted.slice(-2), [
    { event: 'tv-tool-horzline-remove', payload: { lineId: 'foo' } },
    { event: 'tv-tool-horzray-remove', payload: { rayId: 'ray1' } }
  ]);

  let row;
  const cmdService = createCommandService({ commands: api.commands, onAdd: r => { row = r; } });

  let res = cmdService.run('add BBB 100 20');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(row.ticker, 'BBB');

  res = cmdService.run('last');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(row.ticker, 'AAA');
  assert.strictEqual(row.price, 1.5);
  assert.strictEqual(row.sl, 10);
  assert.strictEqual(row.producingLineId, 'foo');
  console.log('lastCommand tests passed');
}

try { run(); } catch (err) { console.error(err); process.exit(1); }
