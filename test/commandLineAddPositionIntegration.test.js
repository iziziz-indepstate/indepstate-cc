const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

async function run() {
  const ipcHandlers = new Map();
  const ipcMain = {
    handle(channel, fn) {
      ipcHandlers.set(channel, fn);
    }
  };

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { ipcMain };
    return originalLoad(request, parent, isMain);
  };

  let loadConfig;
  let originalConfigRoots;
  let originalUserRoot;
  let tempRoot;
  try {
    loadConfig = require('../app/config/load');
    originalConfigRoots = loadConfig.CONFIG_ROOTS.slice();
    originalUserRoot = loadConfig.USER_ROOT;

    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iscc-command-line-add-'));
    const configRoot = path.join(tempRoot, 'config');
    fs.mkdirSync(configRoot, { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'optionstrat.json'), JSON.stringify({
      commands: [{
        enabled: true,
        command: 'bcs {s1} {s2} {q}',
        ticker: 'SPY',
        provider: 'optionstrat',
        expiration: '0DTE',
        legs: [
          { option: 'CALL', side: 'buy', strike: '{s1}', quantity: '{q}' },
          { option: 'CALL', side: 'sell', strike: '{s2}', quantity: '{q}' }
        ]
      }]
    }));
    loadConfig.CONFIG_ROOTS.length = 0;
    loadConfig.CONFIG_ROOTS.push(configRoot);
    loadConfig.USER_ROOT = tempRoot;

    const servicesApi = {};
    const positionsManifest = require('../app/services/positions/manifest');
    const orderCardsManifest = require('../app/services/orderCards/manifest');
    const commandLineManifest = require('../app/services/commandLine/manifest');
    const levelOrderManifest = require('../app/services/levelOrder/manifest');
    const optionStratManifest = require('../app/services/optionstrat/manifest');
    const { registerPositionsIpcHandlers, createPositionsChangedPublisher } = require('../app/infrastructure/positions');

    const positions = positionsManifest.initService(servicesApi);
    levelOrderManifest.initService(servicesApi);
    servicesApi.brokerage = {
      registerAdapterFactory() {},
      registerExecutionProviderDefaults() {}
    };
    servicesApi.executionPayloadPolicies = { register() {} };
    servicesApi.outboundWebhooks = { registerLifecycleEnricher() {} };
    servicesApi.events = {};
    optionStratManifest.initService(servicesApi);
    registerPositionsIpcHandlers({ ipcMain, positionsService: positions });

    const sent = [];
    const mainWindow = {
      isDestroyed: () => false,
      webContents: {
        send(channel, payload) {
          const savedAtSend = positions.snapshot().positions.find(position => position.id === payload.position?.id);
          sent.push({ channel, payload, savedAtSend });
        }
      }
    };
    const publisher = createPositionsChangedPublisher({
      positionsService: positions,
      getMainWindow: () => mainWindow
    });

    assert(
      servicesApi.commands.some(command => command.names?.includes('bcs')),
      'optionstrat should register the bcs command before commandLine initialization'
    );
    commandLineManifest.initService(servicesApi);
    const runCommand = ipcHandlers.get('cmdline:run');
    assert.strictEqual(typeof runCommand, 'function');
    assert.strictEqual(servicesApi.orderCards, undefined);

    const levelResult = await runCommand(null, 'levelOrder ADAUSDT.cfd 0.1995');
    assert.strictEqual(levelResult.ok, true);
    assert.strictEqual(levelResult.cardType, 'levelOrder');
    assert.strictEqual(levelResult.position.ticker, 'ADAUSDT.cfd');

    const optionResult = await runCommand(null, 'bcs 755 756 2');
    assert.strictEqual(optionResult.ok, true);
    assert.strictEqual(optionResult.cardType, 'option');
    assert.strictEqual(optionResult.position.instrumentType, 'OPT');
    assert.strictEqual(optionResult.position.provider, 'optionstrat');
    assert.strictEqual(servicesApi.orderCards, undefined);

    orderCardsManifest.registerMainApplicationServices({
      servicesApi,
      orderCardsConfig: {
        sources: [{
          type: 'file',
          pathEnvVar: 'ISCC_COMMAND_LINE_ADD_TEST_EMPTY_SOURCE',
          pollMs: 2147483647
        }]
      },
      resolveProviderName: () => 'simulated',
      publish: () => {}
    });

    const result = await runCommand(null, 'a ADAUSDT.cfd 0.1981');
    assert.strictEqual(result.ok, true);

    const listed = await ipcHandlers.get('positions:list')();
    const saved = listed.find(position => (
      position.ticker === 'ADAUSDT.cfd'
      && position.card?.type === 'regular'
    ));
    assert(saved, 'positions:list should contain ADAUSDT.cfd');
    assert.strictEqual(saved.card.type, 'regular');
    assert.strictEqual(result.cardType, saved.card.type);
    assert.strictEqual(result.position.card.type, saved.card.type);

    const changed = sent.find(item => (
      item.channel === 'positions:changed'
      && item.payload.position?.ticker === 'ADAUSDT.cfd'
      && item.payload.position?.card?.type === 'regular'
    ));
    assert(changed, 'positions:changed should be sent for ADAUSDT.cfd');
    assert(changed.savedAtSend, 'saved repository snapshot must exist before positions:changed is observed');
    assert.strictEqual(changed.savedAtSend.id, saved.id);
    assert.strictEqual(changed.savedAtSend.card.type, saved.card.type);
    assert.strictEqual(changed.savedAtSend.ticker, saved.ticker);
    assert.strictEqual(changed.payload.position.id, saved.id);
    assert.strictEqual(changed.payload.position.card.type, saved.card.type);
    assert.strictEqual(changed.payload.position.card.type, result.cardType);
    assert.strictEqual(changed.payload.position.ticker, saved.ticker);

    const afterLevel = await ipcHandlers.get('positions:list')();
    const levelSaved = afterLevel.find(position => (
      position.ticker === 'ADAUSDT.cfd'
      && position.card?.type === 'levelOrder'
      && Number(position.card?.data?.level) === 0.1995
    ));
    assert(levelSaved, 'positions:list should contain levelOrder ADAUSDT.cfd snapshot');
    assert.strictEqual(levelSaved.openingPolicy.kind, 'levelOrder');
    assert.strictEqual(levelResult.cardType, levelSaved.card.type);
    assert.strictEqual(levelResult.position.card.type, levelSaved.card.type);

    const levelChanged = sent.find(item => (
      item.channel === 'positions:changed'
      && item.payload.position?.ticker === 'ADAUSDT.cfd'
      && item.payload.position?.card?.type === 'levelOrder'
    ));
    assert(levelChanged, 'positions:changed should be sent for levelOrder ADAUSDT.cfd');
    assert(levelChanged.savedAtSend, 'levelOrder repository snapshot must exist before positions:changed is observed');
    assert.strictEqual(levelChanged.savedAtSend.card.type, 'levelOrder');
    assert.strictEqual(levelChanged.payload.position.card.type, levelResult.cardType);

    const afterOption = await ipcHandlers.get('positions:list')();
    const optionSaved = afterOption.find(position => (
      position.ticker === 'SPY'
      && position.card?.type === 'option'
      && position.provider === 'optionstrat'
    ));
    assert(optionSaved, 'positions:list should contain optionstrat option snapshot');
    assert.strictEqual(optionSaved.instrumentType, 'OPT');
    assert.strictEqual(optionSaved.card.type, 'option');
    assert.deepStrictEqual(optionSaved.card.actions.map(action => action.id), ['OPEN']);
    assert.strictEqual(
      optionSaved.card.actions.some(action => ['BL', 'BC', 'BFB', 'SL', 'SC', 'SFB'].includes(action.id)),
      false
    );
    assert.deepStrictEqual(optionSaved.card.actions[0].payload.legs, [
      { option: 'CALL', side: 'buy', strike: 755, quantity: 2 },
      { option: 'CALL', side: 'sell', strike: 756, quantity: 2 }
    ]);
    assert.strictEqual(optionResult.cardType, optionSaved.card.type);
    assert.strictEqual(optionResult.position.card.type, optionSaved.card.type);

    const optionChanged = sent.find(item => (
      item.channel === 'positions:changed'
      && item.payload.position?.ticker === 'SPY'
      && item.payload.position?.card?.type === 'option'
    ));
    assert(optionChanged, 'positions:changed should be sent for optionstrat option snapshot');
    assert(optionChanged.savedAtSend, 'optionstrat repository snapshot must exist before positions:changed is observed');
    assert.strictEqual(optionChanged.savedAtSend.card.type, 'option');
    assert.strictEqual(optionChanged.payload.position.card.type, optionResult.cardType);

    publisher.dispose();
  } finally {
    if (loadConfig && originalConfigRoots) {
      loadConfig.CONFIG_ROOTS.length = 0;
      loadConfig.CONFIG_ROOTS.push(...originalConfigRoots);
      loadConfig.USER_ROOT = originalUserRoot;
    }
    Module._load = originalLoad;
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log('commandLineAddPositionIntegration tests passed');
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
