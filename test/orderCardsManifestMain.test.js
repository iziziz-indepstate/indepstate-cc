const assert = require('assert');
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
    },
    remove(filter) {
      calls.push(['remove', filter]);
      return { ok: true, removed: 1 };
    }
  };

  Module._load = function(request, parent, isMain) {
    const parentPath = String(parent?.filename || '').replace(/\\/g, '/');
    if (parentPath.endsWith('app/services/orderCards/manifest.js') && request === './index') {
      return {
        isOrderCardSourceType(type) {
          return type === 'file';
        },
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

  assert.strictEqual(manifest.mainApplicationServicePhase, 'before-window');

  const servicesApi = {};
  const positions = { handle: () => ({ ok: true }) };
  const resolveProviderName = () => 'simulated';
  const warnings = [];
  const service = manifest.registerMainApplicationServices({
    servicesApi,
    positions,
    resolveProviderName,
    sendToRenderer: () => {},
    nowTs: () => 123,
    warn: message => warnings.push(message),
    orderCardsConfig: {
      sources: [
        { type: 'webhook', port: 3210, logFile: 'incoming.jsonl', truncateOnStart: true },
        { type: 'file', pathEnvVar: 'ORDER_CARDS_TEST_PATH', pollMs: 500 },
        { type: 'future-source' }
      ]
    }
  });

  assert.strictEqual(service, appService);
  assert.strictEqual(servicesApi.orderCards, appService);
  assert.strictEqual(servicesApi.commands.length, 2);
  assert.deepStrictEqual(servicesApi.commands[0].names, ['add', 'a']);
  assert.deepStrictEqual(servicesApi.commands[1].names, ['rm']);
  assert.deepStrictEqual(servicesApi.commands[0].run(['MSFT', '300', '10']), { ok: true });
  assert.deepStrictEqual(appService.ingested[1], {
    row: { ticker: 'MSFT', price: 300, sl: 10, time: appService.ingested[1].row.time, event: 'manual' },
    context: { source: 'commandLine' }
  });
  assert.deepStrictEqual(servicesApi.commands[1].run(['producingLineId:line-1']), { ok: true, removed: 1 });
  assert.deepStrictEqual(calls[calls.length - 1], ['remove', { producingLineId: 'line-1' }]);
  assert.strictEqual(sources.length, 1);
  assert.strictEqual(sources[0].started, true);
  assert.strictEqual(calls[0][0], 'createOrderCardService');
  assert.strictEqual(calls[0][1].type, 'file');
  assert.strictEqual(calls[0][1].pathEnvVar, 'ORDER_CARDS_TEST_PATH');
  assert.strictEqual(calls[0][1].pollMs, 500);
  assert.strictEqual(calls[1][0], 'createOrderCardsApplicationService');
  assert.strictEqual(calls[1][1].positions, positions);
  assert.strictEqual(calls[1][1].resolveProviderName, resolveProviderName);
  assert.deepStrictEqual(calls[1][1].getSourceServices(), sources);
  assert.deepStrictEqual(appService.ingested[0], {
    row: { ticker: 'AAPL', time: 1 },
    context: { source: 'file' }
  });
  assert.deepStrictEqual(warnings, [
    '[orderCards] Ignoring unknown source type: webhook',
    '[orderCards] Ignoring unknown source type: future-source'
  ]);

  const second = manifest.registerMainApplicationServices({ servicesApi });
  assert.strictEqual(second, appService);
  assert.strictEqual(sources.length, 1);

  const emptyServicesApi = {};
  const emptyService = manifest.registerMainApplicationServices({
    servicesApi: emptyServicesApi,
    orderCardsConfig: { sources: [] }
  });
  assert.strictEqual(emptyService, appService);
  assert.strictEqual(emptyServicesApi.orderCards, appService);
  assert.strictEqual(sources.length, 1, 'empty source config must not create a fallback source');

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
