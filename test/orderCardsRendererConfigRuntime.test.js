const assert = require('assert');
const {
  createOrderCardsRendererConfigRuntime,
  normalizeCardButtons,
  DEFAULT_CARD_BUTTONS
} = require('../app/services/orderCards/rendererConfigRuntime');

function run() {
  assert.deepStrictEqual(normalizeCardButtons([
    ['BUY', 'BL', 'bl'],
    { label: 'SELL', action: 'SL', style: 'sl', hotkey: 's' },
    null,
    ['BAD'],
    { label: 'NO_ACTION' }
  ]), [
    { label: 'BUY', action: 'BL', style: 'bl' },
    { label: 'SELL', action: 'SL', style: 'sl', hotkey: 's' }
  ]);
  assert.deepStrictEqual(normalizeCardButtons([]), DEFAULT_CARD_BUTTONS);

  const applyHandlers = {};
  let renderCount = 0;
  const appliedStrategies = [];
  const runtime = createOrderCardsRendererConfigRuntime({
    loadConfig(name) {
      assert.strictEqual(name, '../services/orderCards/config/order-cards.json');
      return {
        showBidAsk: true,
        showSpread: false,
        instrumentRefreshMs: 2500,
        buttonRows: 3,
        closedCardEventStrategy: 'remove',
        buttons: [['OPEN', 'BL', 'bl']]
      };
    },
    settingsRuntime: {
      onApply(key, handler) {
        applyHandlers[key] = handler;
      }
    },
    env: {},
    onConfigApplied(appliedRuntime) {
      appliedStrategies.push(appliedRuntime.getClosedCardEventStrategy());
    },
    render() {
      renderCount += 1;
    }
  });

  assert.strictEqual(runtime.shouldShowBidAsk(), true);
  assert.strictEqual(runtime.shouldShowSpread(), false);
  assert.strictEqual(runtime.getInstrumentRefreshMs(), 2500);
  assert.strictEqual(runtime.getButtonRows(), 3);
  assert.deepStrictEqual(runtime.getCardButtons(), [{ label: 'OPEN', action: 'BL', style: 'bl' }]);
  assert.strictEqual(runtime.getClosedCardEventStrategy(), 'remove');
  assert.deepStrictEqual(Object.keys(runtime).sort(), [
    'getButtonRows',
    'getCardButtons',
    'getClosedCardEventStrategy',
    'getInstrumentRefreshMs',
    'shouldShowBidAsk',
    'shouldShowSpread'
  ]);

  applyHandlers['order-cards']({
    config: {
      showBidAsk: false,
      showSpread: true,
      instrumentRefreshMs: 1500,
      buttonRows: 2,
      closedCardEventStrategy: 'ignore',
      buttons: [{ label: 'CLOSE', action: 'SC', style: 'sc' }]
    }
  });

  assert.strictEqual(renderCount, 1);
  assert.deepStrictEqual(appliedStrategies, ['ignore']);
  assert.strictEqual(runtime.shouldShowBidAsk(), false);
  assert.strictEqual(runtime.shouldShowSpread(), true);
  assert.strictEqual(runtime.getInstrumentRefreshMs(), 1500);
  assert.strictEqual(runtime.getButtonRows(), 2);
  assert.deepStrictEqual(runtime.getCardButtons(), [{ label: 'CLOSE', action: 'SC', style: 'sc' }]);
  assert.strictEqual(runtime.getClosedCardEventStrategy(), 'ignore');

  const envRuntime = createOrderCardsRendererConfigRuntime({
    loadConfig: () => ({ instrumentRefreshMs: 2500 }),
    env: { INSTRUMENT_REFRESH_MS: '125' }
  });
  assert.strictEqual(envRuntime.getInstrumentRefreshMs(), 125);

  const fallbackRuntime = createOrderCardsRendererConfigRuntime({
    loadConfig: () => ({
      showBidAsk: false,
      showSpread: false,
      instrumentRefreshMs: 0,
      buttonRows: 0,
      buttons: []
    }),
    env: { INSTRUMENT_REFRESH_MS: 'not-a-number' }
  });
  assert.strictEqual(fallbackRuntime.getInstrumentRefreshMs(), 1000);
  assert.strictEqual(fallbackRuntime.getButtonRows(), 1);
  assert.deepStrictEqual(fallbackRuntime.getCardButtons(), DEFAULT_CARD_BUTTONS);
  assert.strictEqual(fallbackRuntime.getClosedCardEventStrategy(), 'ignore');

  console.log('orderCardsRendererConfigRuntime tests passed');
}

try {
  run();
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
