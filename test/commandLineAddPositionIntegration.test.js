const assert = require('assert');
const Module = require('module');

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

  try {
    const servicesApi = {};
    const positionsManifest = require('../app/services/positions/manifest');
    const orderCardsManifest = require('../app/services/orderCards/manifest');
    const commandLineManifest = require('../app/services/commandLine/manifest');
    const levelOrderManifest = require('../app/services/levelOrder/manifest');
    const { createOptionStratCommands } = require('../app/services/optionstrat/command');
    const { registerPositionsIpcHandlers, createPositionsChangedPublisher } = require('../app/infrastructure/positions');

    const positions = positionsManifest.initService(servicesApi);
    levelOrderManifest.initService(servicesApi);
    servicesApi.commands.push(...createOptionStratCommands({
      commands: [{
        enabled: true,
        command: 'bcs {s1} {s2} {q}',
        name: 'BCS {s1}/{s2}',
        ticker: 'SPY',
        provider: 'optionstrat',
        expiration: '0DTE',
        legs: [
          { option: 'CALL', side: 'buy', strike: '{s1}', quantity: '{q}' },
          { option: 'CALL', side: 'sell', strike: '{s2}', quantity: '{q}' }
        ]
      }]
    }));
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
    commandLineManifest.initService(servicesApi);

    const runCommand = ipcHandlers.get('cmdline:run');
    assert.strictEqual(typeof runCommand, 'function');
    const result = await runCommand(null, 'a ADAUSDT.cfd 0.1981');
    assert.strictEqual(result.ok, true);

    const listed = await ipcHandlers.get('positions:list')();
    const saved = listed.find(position => position.ticker === 'ADAUSDT.cfd');
    assert(saved, 'positions:list should contain ADAUSDT.cfd');
    assert.strictEqual(saved.card.type, 'regular');
    assert.strictEqual(result.cardType, saved.card.type);
    assert.strictEqual(result.position.card.type, saved.card.type);

    const changed = sent.find(item => item.channel === 'positions:changed' && item.payload.position?.ticker === 'ADAUSDT.cfd');
    assert(changed, 'positions:changed should be sent for ADAUSDT.cfd');
    assert(changed.savedAtSend, 'saved repository snapshot must exist before positions:changed is observed');
    assert.strictEqual(changed.savedAtSend.id, saved.id);
    assert.strictEqual(changed.savedAtSend.card.type, saved.card.type);
    assert.strictEqual(changed.savedAtSend.ticker, saved.ticker);
    assert.strictEqual(changed.payload.position.id, saved.id);
    assert.strictEqual(changed.payload.position.card.type, saved.card.type);
    assert.strictEqual(changed.payload.position.card.type, result.cardType);
    assert.strictEqual(changed.payload.position.ticker, saved.ticker);

    const levelResult = await runCommand(null, 'levelOrder ADAUSDT.cfd 0.1995');
    assert.strictEqual(levelResult.cardType, 'levelOrder');
    assert.strictEqual(levelResult.ticker, 'ADAUSDT.cfd');

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

    const optionResult = await runCommand(null, 'bcs 755 756 2');
    assert.strictEqual(optionResult.cardType, 'option');
    assert.strictEqual(optionResult.instrumentType, 'OPT');
    assert.strictEqual(optionResult.provider, 'optionstrat');

    const afterOption = await ipcHandlers.get('positions:list')();
    const optionSaved = afterOption.find(position => (
      position.ticker === 'SPY'
      && position.card?.type === 'option'
      && position.provider === 'optionstrat'
    ));
    assert(optionSaved, 'positions:list should contain optionstrat option snapshot');
    assert.strictEqual(optionSaved.instrumentType, 'OPT');
    assert.strictEqual(optionSaved.card.type, 'option');
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
    Module._load = originalLoad;
  }

  console.log('commandLineAddPositionIntegration tests passed');
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
