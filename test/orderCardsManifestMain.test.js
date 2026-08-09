const assert = require('assert');
const path = require('path');
const Module = require('module');

function run() {
  const originalLoad = Module._load;
  const calls = [];
  const sources = [];
  const appService = {
    ingested: [],
    ingestRow(row, context) {
      this.ingested.push({ row, context });
      return { ok: true };
    }
  };

  Module._load = function(request, parent, isMain) {
    const parentPath = String(parent?.filename || '').replace(/\\/g, '/');
    if (parentPath.endsWith('app/services/orderCards/manifest.js') && request === './index') {
      return {
        createOrderCardService(opts) {
          calls.push(['createOrderCardService', opts]);
          const source = {
            opts,
            started: false,
            start() {
              this.started = true;
              calls.push(['start', opts.type]);
              opts.onRow({ ticker: 'AAPL', time: 1 });
            },
            list: async () => []
          };
          sources.push(source);
          return source;
        },
        createOrderCardsApplicationService(deps) {
          calls.push(['createOrderCardsApplicationService', deps]);
          return appService;
        }
      };
    }
    return originalLoad(request, parent, isMain);
  };

  const manifestPath = '../app/services/orderCards/manifest';
  delete require.cache[require.resolve(manifestPath)];
  const manifest = require(manifestPath);
  Module._load = originalLoad;

  const servicesApi = {};
  const positions = { handle: () => ({ ok: true }) };
  const resolveProviderName = () => 'simulated';
  const service = manifest.registerMainApplicationServices({
    servicesApi,
    positions,
    resolveProviderName,
    sendToRenderer: () => {},
    nowTs: () => 123,
    logDir: path.join('tmp', 'logs'),
    defaultWebhookPort: 3210,
    orderCardsConfig: {
      sources: [
        { type: 'webhook', port: 0, logFile: 'incoming.jsonl', truncateOnStart: false },
        { type: 'file', path: 'orders.jsonl' }
      ]
    }
  });

  assert.strictEqual(service, appService);
  assert.strictEqual(servicesApi.orderCards, appService);
  assert.strictEqual(sources.length, 2);
  assert.strictEqual(sources[0].started, true);
  assert.strictEqual(sources[1].started, true);
  assert.strictEqual(calls[0][0], 'createOrderCardService');
  assert.strictEqual(calls[0][1].type, 'webhook');
  assert.strictEqual(calls[0][1].port, 3210);
  assert.strictEqual(calls[0][1].logFile, path.join('tmp', 'logs', 'incoming.jsonl'));
  assert.strictEqual(calls[0][1].truncateOnStart, false);
  assert.strictEqual(calls[1][1].type, 'file');
  assert.strictEqual(calls[2][0], 'createOrderCardsApplicationService');
  assert.strictEqual(calls[2][1].positions, positions);
  assert.strictEqual(calls[2][1].resolveProviderName, resolveProviderName);
  assert.deepStrictEqual(calls[2][1].getSourceServices(), sources);
  assert.deepStrictEqual(appService.ingested, [
    { row: { ticker: 'AAPL', time: 1 }, context: { source: 'webhook' } },
    { row: { ticker: 'AAPL', time: 1 }, context: { source: 'file' } }
  ]);

  const second = manifest.registerMainApplicationServices({ servicesApi });
  assert.strictEqual(second, appService);
  assert.strictEqual(sources.length, 2);

  const handlers = new Map();
  manifest.registerMainIpcHandlers({
    ipcMain: {
      handle(name, fn) {
        handlers.set(name, fn);
      }
    },
    servicesApi
  });
  assert.deepStrictEqual([...handlers.keys()], ['order-cards:list']);

  console.log('orderCardsManifestMain tests passed');
}

try {
  run();
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
