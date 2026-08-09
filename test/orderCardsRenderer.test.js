const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createOrderCardsRenderer } = require('../app/services/orderCards/renderer');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (_) {}

function createRenderer(overrides = {}) {
  return createOrderCardsRenderer({
    el: () => ({}),
    inputNumber: () => ({ addEventListener() {}, classList: { toggle() {} }, value: '' }),
    uiState: new Map(),
    orderCalc: {
      defaultRiskUsd: () => 10,
      qty: () => 1,
      takePts: value => value * 3
    },
    priceToPoints: () => 1,
    normNum: value => Number(value),
    isPos: value => Number.isFinite(value) && value > 0,
    isSL: value => Number.isFinite(value) && value > 0,
    tickSize: () => 0.01,
    instrumentInfoFor: () => ({}),
    tradeRules: { validate: () => ({ ok: true }) },
    markTouched: () => {},
    detectInstrumentType: () => 'EQ',
    rowKey: row => `${row.ticker}|${row.event}|${row.time}|${row.price}`,
    ipcRenderer: { invoke: async () => ({ status: 'ok' }) },
    legacyOrderStateApi: {
      markPendingRequest: () => true,
      setPendingExecLabel: () => true,
      setPendingId: () => true
    },
    cardByKey: () => null,
    setCardState: () => {},
    pendingActionInfo: () => null,
    toast: () => {},
    shakeCard: () => {},
    render: () => {},
    ...overrides
  });
}

async function run() {
  const scheduleCalls = [];
  const typeHandler = {
    shouldScheduleInstantExecution: ({ row }) => row.instantExecution === true,
    scheduleInstantExecution: ({ row, place, instrumentType }) => {
      scheduleCalls.push({ row, place, instrumentType });
      return true;
    }
  };
  const cardTypeHandler = {
    createBody: () => ({ type: 'custom' })
  };

  const renderer = createRenderer({
    instrumentTypeHandlers: { CUSTOM: typeHandler },
    cardTypeHandlers: { customCard: cardTypeHandler }
  });

  assert.strictEqual(renderer.handlerFor({ instrumentType: 'CUSTOM' }), typeHandler);
  assert.strictEqual(renderer.handlerFor({ cardType: 'customCard' }), cardTypeHandler);
  assert.strictEqual(renderer.titleFor({ ticker: 'AAPL', instrumentType: 'CUSTOM' }, 'CUSTOM'), 'AAPL');
  assert.strictEqual(renderer.scheduleInstantExecution({ ticker: 'AAPL', instrumentType: 'CUSTOM', instantExecution: false }, () => {}, 'CUSTOM'), false);
  assert.strictEqual(scheduleCalls.length, 0);
  assert.strictEqual(renderer.scheduleInstantExecution({ ticker: 'AAPL', instrumentType: 'CUSTOM', instantExecution: true }, () => {}, 'CUSTOM'), true);
  assert.strictEqual(scheduleCalls.length, 1);
  assert.strictEqual(scheduleCalls[0].instrumentType, 'CUSTOM');
  assert.strictEqual(renderer.scheduleInstantExecution({ ticker: 'AAPL', instrumentType: 'EQ', instantExecution: true }, () => {}, 'EQ'), false);

  const registered = renderer.registerInstrumentHandler('REG', typeHandler);
  assert.strictEqual(renderer.handlerFor({ instrumentType: 'REG' }), typeHandler);
  registered();
  assert.strictEqual(renderer.handlerFor({ instrumentType: 'REG' }), null);
  const registeredCardType = renderer.registerCardTypeHandler('registeredCard', cardTypeHandler);
  assert.strictEqual(renderer.handlerFor({ cardType: 'registeredCard' }), cardTypeHandler);
  registeredCardType();
  assert.strictEqual(renderer.handlerFor({ cardType: 'registeredCard' }), null);

  if (JSDOM) {
    const dom = new JSDOM('<!DOCTYPE html><div id="grid"></div>');
    global.document = dom.window.document;
    const calls = [];
    const states = [];
    const uiState = new Map();
    const domRenderer = createRenderer({
      el: (tag, className, text, attrs) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        if (attrs) Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
        return node;
      },
      inputNumber: (ph, cls) => {
        const input = document.createElement('input');
        input.type = 'number';
        input.placeholder = ph;
        input.className = cls ? `num ${cls}` : 'num';
        return input;
      },
      uiState,
      ipcRenderer: {
        invoke: async (ch, payload) => {
          calls.push({ ch, payload });
          return { status: 'ok', providerOrderId: 'ticket-1' };
        }
      },
      cardByKey: key => document.querySelector(`.card[data-rowkey="${key}"]`),
      setCardState: (key, state) => states.push({ key, state }),
      now: () => 10,
      random: () => 0.5,
      btn: (text, className, onClick) => {
        const button = document.createElement('button');
        button.className = `btn ${className}`;
        button.textContent = text;
        button.addEventListener('click', onClick);
        return button;
      },
      getCardButtons: () => [{ label: 'BL', action: 'BL', style: 'bl' }]
    });
    const legacyRow = {
      ticker: 'AAPL',
      event: 'up',
      time: 1,
      price: 100,
      qty: 2,
      sl: 1,
      risk: 10,
      instrumentType: 'EQ'
    };
    const legacyCard = domRenderer.createLegacyOrderCard({ row: legacyRow, index: 0 });
    document.getElementById('grid').appendChild(legacyCard);
    assert.strictEqual(legacyCard.dataset.rowkey, 'AAPL|up|1|100');
    assert.strictEqual(legacyCard.dataset.ticker, 'AAPL');
    assert.strictEqual(legacyCard.querySelector('.card__status').style.display, 'none');
    assert.strictEqual(legacyCard.querySelector('.card__close').title, 'Удалить карточку');
    assert.deepStrictEqual(Array.from(legacyCard.querySelectorAll('button.btn')).map(btn => btn.dataset.kind), ['BL']);
    assert(legacyCard.querySelector('input.qty'));
    assert(legacyCard.querySelector('.card__note'));

    const customBody = {
      type: 'custom',
      line: document.createElement('div'),
      setButtons(btns) { this.btns = btns; },
      setNote(note) { this.note = note; },
      validate() { return { valid: true, type: 'custom', qty: 1, pr: 1, sl: 1, risk: 1 }; }
    };
    customBody.line.className = 'custom-body';
    const customHandler = {
      title: ({ row }) => `Custom ${row.ticker}`,
      createBody: () => customBody,
      buttons: () => [{ label: 'OPEN', action: 'OPEN', style: 'open' }],
      matchesExistingRow: ({ incomingRow, existingRow }) => incomingRow.id === existingRow.id
    };
    domRenderer.registerCardTypeHandler('customLegacy', customHandler);
    const customLegacy = domRenderer.createLegacyOrderCard({
      row: { id: 'same', ticker: 'TSLA', event: 'custom', time: 2, price: 200, cardType: 'customLegacy' },
      index: 1
    });
    assert(customLegacy.textContent.includes('Custom TSLA'));
    assert.strictEqual(customLegacy.querySelector('button.btn').dataset.kind, 'OPEN');
    assert.strictEqual(domRenderer.matchesExistingRow({ id: 'same', ticker: 'TSLA', cardType: 'customLegacy' }, { id: 'same', ticker: 'OLD' }), true);
    assert.strictEqual(domRenderer.matchesExistingRow({ id: 'new', ticker: 'TSLA', cardType: 'customLegacy' }, { id: 'same', ticker: 'TSLA' }), false);

    const card = domRenderer.createRegularPositionCard({
      position: {
        id: 'pos-reg-1',
        state: 'draft',
        ticker: 'MSFT',
        instrumentType: 'EQ',
        provider: 'simulated',
        card: {
          type: 'regular',
          actions: [{ id: 'BL', label: 'BL', command: 'position.open', style: 'bl' }],
          data: {
            ticker: 'MSFT',
            instrumentType: 'EQ',
            provider: 'simulated',
            event: 'up',
            price: 100,
            qty: 2,
            sl: 1,
            tp: 3,
            riskUsd: 10
          }
        }
      },
      key: 'position|pos-reg-1',
      title: 'MSFT'
    });
    document.getElementById('grid').appendChild(card);
    assert.strictEqual(card.dataset.cardType, 'regular');
    assert.strictEqual(card.querySelector('.card__status').style.display, 'none');
    assert.strictEqual(card.querySelector('input.qty').value, '1');
    assert.deepStrictEqual(Array.from(card.querySelectorAll('button.btn')).map(btn => btn.dataset.kind), ['BL']);
    card.querySelector('button.btn').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(calls[0].ch, 'queue-place-order');
    assert.strictEqual(calls[0].payload.ticker, 'MSFT');
    assert.strictEqual(calls[0].payload.meta.positionId, 'pos-reg-1');
    assert.strictEqual(states[0].key, 'position|pos-reg-1');

    const closed = domRenderer.createRegularPositionCard({
      position: {
        id: 'pos-reg-2',
        state: 'closed',
        primaryTicket: 'ticket-2',
        tickets: ['ticket-2'],
        pnlSnapshot: { status: 'reported', value: 5 },
        card: {
          type: 'regular',
          actions: [{ id: 'archive', label: 'Archive', command: 'position.remove', style: 'archive' }],
          data: { ticker: 'MSFT', price: 100, qty: 2, state: 'draft' }
        }
      },
      key: 'position|pos-reg-2',
      title: 'MSFT'
    });
    // Compact closed regular cards are read-only snapshots; action metadata is retained separately.
    assert.strictEqual(closed.querySelector('.card__status').textContent, '');
    assert.strictEqual(closed.querySelector('.card__status').classList.contains('card__status--closed'), true);
    assert.strictEqual(closed.classList.contains('card--mini'), true);
    assert.strictEqual(closed.querySelector('.position-card__data'), null);
    assert.strictEqual(closed.querySelector('.position-card__actions'), null);
    assert.deepStrictEqual(closed._positionActions.map(action => action.label), ['Archive']);
    assert.strictEqual(closed.querySelector('input'), null);

    const active = domRenderer.createRegularPositionCard({
      position: {
        id: 'pos-reg-active',
        state: 'active',
        primaryTicket: 'ticket-active',
        card: {
          type: 'regular',
          actions: [{ id: 'close', label: 'Close', command: 'position.close', style: 'close' }],
          data: { ticker: 'MSFT', price: 100 }
        }
      },
      key: 'position|pos-reg-active',
      title: 'MSFT'
    });
    // Compact active regular cards intentionally omit inline action controls.
    assert.strictEqual(active.classList.contains('card--mini'), true);
    assert.strictEqual(active.querySelector('.position-card__actions'), null);
    assert.deepStrictEqual(active._positionActions.map(action => action.label), ['Close']);
    assert.strictEqual(active.querySelector('input'), null);

    const openedButStalePlaced = domRenderer.createRegularPositionCard({
      position: {
        id: 'pos-reg-opened-stale',
        state: 'placed',
        timestamps: { openedAt: 20 },
        card: {
          type: 'regular',
          actions: [],
          data: { ticker: 'MSFT', state: 'placed', price: 100 }
        }
      },
      key: 'position|pos-reg-opened-stale',
      title: 'MSFT'
    });
    assert.strictEqual(openedButStalePlaced.querySelector('.card__status').classList.contains('card__status--active'), true);

    const cancelled = domRenderer.createRegularPositionCard({
      position: {
        id: 'pos-reg-3',
        state: 'cancelled',
        card: {
          type: 'regular',
          actions: [{ id: 'cancel', label: 'Cancel', command: 'position.remove', style: 'cancel' }],
          data: { ticker: 'MSFT', event: 'up', price: 100, qty: 2, sl: 1, riskUsd: 10 }
        }
      },
      key: 'position|pos-reg-3',
      title: 'MSFT'
    });
    assert.strictEqual(cancelled.classList.contains('card--mini'), false);
    assert.strictEqual(cancelled.querySelector('.card__status').style.display, 'none');
    assert.deepStrictEqual(Array.from(cancelled.querySelectorAll('button.btn')).map(btn => btn.dataset.kind), ['BL']);
  }

  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
  [
    'createOptionStratRenderer',
    'optionStratRenderer',
    'optionstrat/renderer',
    'emitOptionStratButtonEvent',
    'ensureOptionPayoff',
    "instrumentType === 'OPT'",
    "instrumentType !== 'OPT'",
    'registerOrderCardsRuntime',
    'let orderCardsRuntime'
  ].forEach(pattern => {
    assert.strictEqual(rendererSource.includes(pattern), false, `app/renderer.js still contains ${pattern}`);
  });

  console.log('orderCardsRenderer tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
