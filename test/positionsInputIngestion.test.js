const assert = require('assert');
const { createPositionApplicationService } = require('../app/application/positions');
const { createLevelOrderPositionInputAdapter } = require('../app/services/levelOrder/positionInputAdapter');
const { createLevelOrderOpeningPolicy } = require('../app/services/levelOrder/domain/openingPolicy');
const { createOptionStratPositionBehavior } = require('../app/services/optionstrat/domain/positionBehavior');
const { createOptionStratPositionInputAdapter } = require('../app/services/optionstrat/positionInputAdapter');

function run() {
  const positions = createPositionApplicationService({ clock: () => 100 });
  positions.registerOpeningPolicy('levelOrder', createLevelOrderOpeningPolicy);
  const unregisterOptionStratBehavior = positions.registerBehavior(createOptionStratPositionBehavior());
  const unregisterLevelOrder = positions.registerPositionInputAdapter(createLevelOrderPositionInputAdapter());
  const unregisterOptionStrat = positions.registerPositionInputAdapter(createOptionStratPositionInputAdapter());
  const seenContexts = [];
  const unregisterContextProbe = positions.registerPositionInputAdapter({
    id: 'context-probe',
    cardTypeForInput(_row, context) {
      seenContexts.push(context);
      return context.source === 'context-test' ? 'context-card' : null;
    }
  });

  try {
    const regular = positions.createFromInput({
      ticker: 'AAPL',
      provider: 'simulated',
      instrumentType: 'EQ',
      event: 'manual',
      time: 1
    }, { source: 'commandLine' });
    assert.strictEqual(regular.ok, true);
    assert.strictEqual(regular.cardType, 'regular');
    assert.strictEqual(regular.position.card.type, 'regular');

    const levelOrder = positions.createFromInput({
      cardType: 'levelOrder',
      ticker: 'ES',
      provider: 'simulated',
      level: 5500,
      event: 'levelOrder',
      time: 2
    }, { source: 'commandLine' });
    assert.strictEqual(levelOrder.ok, true);
    assert.strictEqual(levelOrder.cardType, 'levelOrder');
    assert.strictEqual(levelOrder.position.card.type, 'levelOrder');
    assert.deepStrictEqual(levelOrder.position.openingPolicy, { kind: 'levelOrder', config: {} });

    const optionLegs = [{ option: 'CALL', side: 'buy', strike: 700, quantity: 1 }];
    const optionStrat = positions.createFromInput({
      ticker: 'SPY',
      provider: 'optionstrat',
      instrumentType: 'OPT',
      event: 'optionstrat',
      strategyCommand: 'lc',
      expirationDte: '0DTE',
      legs: optionLegs,
      time: 3
    }, { source: 'commandLine' });
    assert.strictEqual(optionStrat.ok, true);
    assert.strictEqual(optionStrat.cardType, 'option');
    assert.strictEqual(optionStrat.position.card.type, 'option');
    assert.deepStrictEqual(optionStrat.position.card.actions.map(action => action.id), ['OPEN']);
    assert.deepStrictEqual(optionStrat.position.card.actions[0].payload.legs, optionLegs);
    assert.strictEqual(optionStrat.position.card.actions[0].payload.event, 'optionstrat');
    assert.strictEqual(optionStrat.position.card.actions[0].payload.strategyCommand, 'lc');
    assert.strictEqual(optionStrat.position.card.actions[0].payload.expirationDte, '0DTE');
    assert.strictEqual(optionStrat.position.card.actions[0].payload.provider, 'optionstrat');
    assert.strictEqual(optionStrat.position.card.actions[0].payload.instrumentType, 'OPT');

    const contextual = positions.createFromInput({ ticker: 'CTX', time: 4 }, { source: 'context-test' });
    assert.strictEqual(contextual.cardType, 'context-card');
    assert(seenContexts.some(context => context.source === 'context-test'));

    const invalid = positions.createFromInput(null, { source: 'invalid-test' });
    assert.strictEqual(invalid.ok, false);
    assert.strictEqual(typeof invalid.error, 'string');
  } finally {
    unregisterContextProbe();
    unregisterOptionStrat();
    unregisterLevelOrder();
    unregisterOptionStratBehavior();
  }

  console.log('positionsInputIngestion tests passed');
}

try {
  run();
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
