const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping optionstratRenderer test');
  process.exit(0);
}
const Module = require('module');

function optionPosition(state = 'draft', overrides = {}) {
  const payoff = {
    maxProfit: 100,
    maxLoss: 900,
    isMaxProfitInfinite: false,
    isMaxLossInfinite: false
  };
  const legs = [
    { option: 'CALL', side: 'buy', strike: 755, quantity: 10 },
    { option: 'CALL', side: 'sell', strike: 756, quantity: 10 }
  ];
  const isDraft = state === 'draft';
  return {
    id: 'pos-opt-1',
    state,
    ticker: 'SPY',
    symbol: 'SPY',
    instrumentType: 'OPT',
    provider: 'optionstrat',
    primaryTicket: isDraft ? undefined : 'deal-1',
    tickets: isDraft ? [] : ['deal-1'],
    card: {
      type: 'option',
      actions: isDraft ? [{
        id: 'OPEN',
        label: 'OPEN',
        command: 'position.open',
        style: 'bl',
        payload: {
          side: 'OPEN',
          event: 'optionstrat',
          strategyCommand: 'lcs',
          expirationDte: '0DTE',
          legs
        }
      }] : state === 'closed' ? [] : [{
        id: 'close',
        label: 'CLOSE',
        command: 'position.close',
        style: 'sl'
      }],
      data: {
        ticker: 'SPY',
        symbol: 'SPY',
        provider: 'optionstrat',
        instrumentType: 'OPT',
        state,
        event: 'optionstrat',
        strategyCommand: 'lcs',
        name: 'BCS 755/756',
        expirationDte: '0DTE',
        legs,
        payoff,
        openedAt: isDraft ? undefined : Date.UTC(2026, 5, 13, 9, 30),
        ticket: isDraft ? undefined : 'deal-1',
        ...overrides.data
      }
    },
    ...overrides.position
  };
}

async function run() {
  const handlers = {};
  const queuedOrders = [];
  const cancelled = [];
  const buttonEvents = [];
  const ipcRenderer = {
    on: (channel, handler) => { handlers[channel] = handler; },
    invoke: async (channel, payload) => {
      if (channel === 'positions:list') return [optionPosition()];
      if (channel === 'settings:get' && payload === 'optionstrat') return { valuationRefreshMs: 5000 };
      if (channel === 'settings:get') return { autoscroll: true };
      if (channel === 'settings:list') return [];
      if (channel === 'actions-bus:list') return [];
      if (channel === 'actions-bus:set-enabled') return [];
      if (channel === 'optionstrat:button-event') {
        buttonEvents.push(payload);
        return { ok: true };
      }
      if (channel === 'queue-place-order') {
        queuedOrders.push(payload);
        return { status: 'ok', provider: 'optionstrat', providerOrderId: 'deal-1' };
      }
      if (channel === 'execution:cancel-order') {
        cancelled.push(payload);
        return { status: 'ok' };
      }
      return {};
    }
  };

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { ipcRenderer };
    return originalLoad(request, parent, isMain);
  };

  const dom = new JSDOM('<!DOCTYPE html><div id="wrap"><div id="grid"></div></div><input id="filter"><input id="cmdline"><button id="settings-btn"></button><div id="settings-panel"><div id="settings-sections"></div><div id="settings-fields"></div><button id="settings-close"></button></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.CSS = dom.window.CSS;
  global.navigator = { userAgent: 'node.js' };

  const renderer = require('../app/renderer.js');
  await new Promise(resolve => setImmediate(resolve));
  const t = renderer.__testing;
  let card = document.querySelector('.position-card[data-position-id="pos-opt-1"]');
  assert(card);
  assert(card.textContent.includes('Max Loss $900'));
  assert(card.textContent.includes('Max Profit $100'));
  assert(card.textContent.includes('SPY 0DTE +10C755/-10C756'));
  assert.strictEqual(card.querySelector('button.btn').textContent, 'OPEN');

  card.querySelector('button.btn').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(buttonEvents[0].action, 'open');
  assert.strictEqual(queuedOrders.length, 1);
  assert.strictEqual(queuedOrders[0].positionId, 'pos-opt-1');
  assert.strictEqual(queuedOrders[0].side, 'OPEN');
  assert.deepStrictEqual(queuedOrders[0].legs, optionPosition().card.data.legs);

  handlers['positions:changed'](null, {
    event: { type: 'position.opened' },
    position: optionPosition('active', {
      data: {
        valuation: { initialValue: 900, currentValue: 950, change: 50, changePct: 5.56 }
      }
    })
  });
  await new Promise(resolve => setImmediate(resolve));
  card = document.querySelector('.position-card[data-position-id="pos-opt-1"]');
  assert(card.textContent.includes('P/L $50'));
  assert(card.textContent.includes('Value $950'));
  assert.strictEqual(card.querySelector('button.btn').textContent, 'CLOSE');

  card.querySelector('button.btn').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(buttonEvents[1].action, 'close');
  assert.deepStrictEqual(cancelled, [{
    provider: 'optionstrat',
    ticket: 'deal-1',
    symbol: 'SPY',
    name: 'BCS 755/756'
  }]);

  handlers['positions:changed'](null, {
    event: { type: 'position.closed' },
    position: optionPosition('closed', {
      data: {
        valuation: { initialValue: 900, currentValue: 970, change: 70, changePct: 7.78 },
        closedAt: Date.UTC(2026, 5, 13, 10, 45)
      }
    })
  });
  await new Promise(resolve => setImmediate(resolve));
  card = document.querySelector('.position-card[data-position-id="pos-opt-1"]');
  assert(card.textContent.includes('P/L $70'));
  assert(card.textContent.includes('Closed '));
  assert.strictEqual(card.querySelectorAll('button.btn').length, 0);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(t.cardRuntime, 'legacyRows'), false);

  Module._load = originalLoad;
  console.log('optionstratRenderer tests passed');
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
