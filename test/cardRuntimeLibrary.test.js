const assert = require('assert');
const { JSDOM } = require('jsdom');
const { createCardRuntimeLibrary } = require('../app/infrastructure/renderer/cardRuntime/library');

function run() {
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>');
  const { document } = dom.window;
  const el = (tag, className, text, attrs) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    if (attrs) Object.entries(attrs).forEach(([name, value]) => node.setAttribute(name, value));
    return node;
  };
  const btn = (label, className, onClick) => {
    const button = document.createElement('button');
    button.className = `btn ${className}`;
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  };
  const library = createCardRuntimeLibrary({ el, btn, document });

  const compact = library.shapes.createPositionCardShape({
    title: 'Closed AAPL',
    status: 'closed',
    body: el('div', 'position-body'),
    actions: [{ label: 'Archive', action: 'archive' }],
    compact: true,
    attributes: {
      'data-rowkey': 'position|1',
      'data-position-id': '1',
      'data-card-type': 'regular'
    }
  });
  assert.strictEqual(compact.classList.contains('card--mini'), true);
  assert.strictEqual(compact.dataset.rowkey, 'position|1');
  assert.strictEqual(compact.dataset.positionId, '1');
  assert.strictEqual(compact.querySelector('.card__status').textContent, '');
  assert.strictEqual(compact.querySelector('.card__status').classList.contains('card__status--closed'), true);
  assert.strictEqual(compact.querySelector('.card__close'), null);
  assert.strictEqual(compact.querySelector('.position-body'), null);
  assert.strictEqual(compact.querySelector('.position-card__actions'), null);

  const grid = library.views.createDataGridView({
    fields: [
      { key: 'price', label: 'Price', value: 100 },
      { key: 'pnl', label: 'PnL', value: { status: 'reported', value: 5 } }
    ]
  });
  assert.strictEqual(grid.querySelector('[data-field="price"] .position-card__field-value').textContent, '100');
  assert.strictEqual(grid.querySelector('[data-field="pnl"] .position-card__field-value').textContent, 'reported: 5');

  const injectedTags = [];
  const injectedEl = (tag, className, text, attrs) => {
    injectedTags.push(tag);
    return el(tag, className, text, attrs);
  };
  const injectedLibrary = createCardRuntimeLibrary({ el: injectedEl });
  const controlCalls = [];
  const removeControl = injectedLibrary.controls.createRemoveControl({
    onRemove: event => controlCalls.push(['remove', event])
  });
  const retryControl = injectedLibrary.controls.createRetryControl({
    onRetryStop: event => controlCalls.push(['retry', event])
  });

  const removeEvent = new dom.window.MouseEvent('click', { bubbles: true });
  const retryEvent = new dom.window.MouseEvent('click', { bubbles: true });
  let stopPropagationCalls = 0;
  removeEvent.stopPropagation = () => { stopPropagationCalls += 1; };
  retryEvent.stopPropagation = () => { stopPropagationCalls += 1; };
  removeControl.dispatchEvent(removeEvent);
  retryControl.dispatchEvent(retryEvent);

  assert.deepStrictEqual(injectedTags, ['button', 'button']);
  assert.strictEqual(controlCalls.length, 2);
  assert.deepStrictEqual(controlCalls.map(([name]) => name), ['remove', 'retry']);
  assert.strictEqual(controlCalls[0][1], removeEvent);
  assert.strictEqual(controlCalls[1][1], retryEvent);
  assert.strictEqual(stopPropagationCalls, 2);

  console.log('cardRuntimeLibrary tests passed');
}

try {
  run();
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
