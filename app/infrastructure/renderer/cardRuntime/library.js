function createCardRuntimeLibrary({
  el,
  btn,
  document,
  formatValue = defaultFormatValue,
  createActionButton
} = {}) {
  const documentCreateElement = document?.createElement?.bind(document);
  const createElement = (tag, className, text, attrs) => {
    if (typeof el === 'function') return el(tag, className, text, attrs);
    if (!documentCreateElement) throw new Error('card runtime library requires el or document');
    const node = documentCreateElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    if (attrs) Object.entries(attrs).forEach(([name, value]) => node.setAttribute(name, value));
    return node;
  };

  function createStatusView({ status = '', compact = false, className = '' } = {}) {
    const statusText = String(status || '');
    const modifier = statusText ? ` card__status--${statusText}` : '';
    const extraClass = className ? ` ${className}` : '';
    const view = createElement('span', `card__status${modifier}${extraClass}`, statusText);
    view.style.display = statusText ? 'inline-block' : 'none';
    if (compact && statusText !== 'pending-exec') view.textContent = '';
    return view;
  }

  function createHeaderView({
    title,
    bidAskText,
    spreadText,
    status,
    compact = false,
    retryControl,
    removeControl
  } = {}) {
    const head = createElement('div', 'row');
    const left = createElement('div', null, null, { style: 'display:flex;align-items:center;gap:6px' });
    left.appendChild(createElement('div', null, title, { style: 'font-weight:600;font-size:13px' }));
    if (bidAskText !== undefined && bidAskText !== null) {
      const bidAsk = createElement('span', 'card__bidask');
      bidAsk.title = 'Bid / Ask';
      bidAsk.style.fontSize = '11px';
      bidAsk.style.color = '#6b7280';
      bidAsk.textContent = bidAskText || '';
      left.appendChild(bidAsk);
    }
    head.appendChild(left);

    const right = createElement('div', null, null, { style: 'display:flex;align-items:center;gap:6px' });
    const statusView = isNode(status)
      ? status
      : createStatusView({ status: status?.text ?? status, compact, className: status?.className });
    right.appendChild(statusView);
    if (spreadText !== undefined && spreadText !== null) {
      const spread = createElement('span', 'card__spread');
      spread.title = 'Spread pts: current / avg10 / avg100';
      spread.style.fontSize = '11px';
      spread.style.color = '#6b7280';
      spread.textContent = spreadText || '';
      right.appendChild(spread);
    }
    if (retryControl) right.appendChild(retryControl);
    if (removeControl) right.appendChild(removeControl);
    head.appendChild(right);
    return head;
  }

  function createRemoveControl({
    onRemove,
    title = 'Remove card',
    color = '#6b7280'
  } = {}) {
    const control = createElement('button');
    control.type = 'button';
    control.textContent = '×';
    control.className = 'card__close';
    Object.assign(control.style, {
      border: 'none',
      background: 'transparent',
      width: '22px',
      height: '22px',
      lineHeight: '22px',
      textAlign: 'center',
      fontSize: '16px',
      cursor: 'pointer',
      borderRadius: '4px',
      color,
      marginLeft: '8px'
    });
    control.title = title;
    control.addEventListener('click', (event) => {
      event.stopPropagation();
      onRemove?.(event);
    });
    return control;
  }

  function createRetryControl({ onRetryStop, text = '0', title = 'Stop retries' } = {}) {
    const control = createElement('button');
    control.type = 'button';
    control.className = 'retry-btn';
    control.textContent = text;
    control.title = title;
    control.style.display = 'none';
    control.addEventListener('click', (event) => {
      event.stopPropagation();
      onRetryStop?.(event);
    });
    return control;
  }

  function createActionButtonsControl({
    actions = [],
    onAction,
    rows = 1,
    className = 'btns',
    createActionButton: actionButtonFactory = createActionButton
  } = {}) {
    const control = createElement('div', className);
    const rowCount = Number(rows) || 1;
    const columns = Math.max(1, Math.ceil(actions.length / rowCount));
    control.style.gridTemplateColumns = `repeat(${columns},1fr)`;
    for (const action of actions) {
      const label = action.label || action.action;
      const kind = action.action || action.id || label;
      const buttonClass = String(action.style || kind).toLowerCase();
      const onClick = event => onAction?.(action, event);
      const button = typeof actionButtonFactory === 'function'
        ? actionButtonFactory({ label, kind, className: buttonClass, onClick })
        : (typeof btn === 'function' ? btn(label, buttonClass, onClick) : null);
      if (!button) continue;
      button.dataset.kind = kind;
      control.appendChild(button);
    }
    return control;
  }

  function createDataGridView({ fields = [], columns = 2, className = 'position-card__data' } = {}) {
    const grid = createElement('div', className);
    Object.assign(grid.style, {
      display: 'grid',
      gridTemplateColumns: `repeat(${columns},minmax(0,1fr))`,
      gap: '6px',
      fontSize: '11px'
    });
    fields.forEach(field => appendDataField(grid, field));
    return grid;
  }

  function appendDataField(parent, { key, label, value } = {}) {
    const item = createElement('div', 'position-card__field');
    item.dataset.field = key;
    item.appendChild(createElement('span', 'position-card__field-label', label));
    item.appendChild(createElement('span', 'position-card__field-value', formatValue(value)));
    parent.appendChild(item);
    return item;
  }

  function createPositionCardShape({
    title,
    status = '',
    body,
    actions = [],
    onAction,
    onRemove,
    compact = false,
    attributes = {},
    actionRows = 1,
    createActionButton: actionButtonFactory
  } = {}) {
    const card = createElement('div', 'card position-card');
    if (compact) card.classList.add('card--mini');
    applyAttributes(card, attributes);
    const remove = compact ? null : createRemoveControl({ onRemove });
    card.appendChild(createHeaderView({ title, status, compact, removeControl: remove }));
    if (!compact) card.appendChild(createElement('div', 'meta', ''));
    if (!compact) appendBody(card, body);
    const buttons = createActionButtonsControl({
      actions,
      onAction,
      rows: actionRows,
      className: 'btns position-card__actions',
      createActionButton: actionButtonFactory
    });
    const note = createElement('div', 'card__note');
    if (!compact && actions.length) card.appendChild(buttons);
    if (!compact) card.appendChild(note);
    wireBody(card, body, buttons, note);
    return card;
  }

  function appendBody(card, body) {
    const line = body?.line || (isNode(body) ? body : null);
    if (line) card.appendChild(line);
    if (body?.extraRow) card.appendChild(body.extraRow);
  }

  function wireBody(card, body, buttons, note) {
    if (!body || isNode(body)) return;
    body.setButtons?.(buttons);
    body.setNote?.(note);
    if (typeof body.validate === 'function') {
      body.validate();
      card._validate = (commit = false) => body.validate(commit);
    }
  }

  return {
    views: { createHeaderView, createStatusView, createDataGridView },
    controls: { createRemoveControl, createRetryControl, createActionButtonsControl },
    shapes: { createPositionCardShape }
  };
}

function applyAttributes(node, attributes = {}) {
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value));
}

function isNode(value) {
  return !!value && typeof value === 'object' && typeof value.nodeType === 'number';
}

function defaultFormatValue(value) {
  if (value == null || value === '') return '-';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '-';
  if (typeof value === 'object') {
    if (value.status && value.value != null) return `${value.status}: ${value.value}`;
    if (value.status) return value.status;
    return JSON.stringify(value);
  }
  return String(value);
}

module.exports = {
  createCardRuntimeLibrary
};
