function createPositionsRenderer({
  ipcRenderer,
  el,
  createPositionDataGrid,
  createPositionActions,
  positionKey,
  positionCardTitle,
  render,
  positionCardRenderers,
  onPositionRemoved,
  onPositionSnapshot
} = {}) {
  const positionsById = new Map();

  function normalizePositionSnapshot(position) {
    if (position?.card?.type !== 'levelOrder') return position;
    const hasOpenedAt = Boolean(position.timestamps?.openedAt || position.openedAt);
    if (position.state !== 'closed' || hasOpenedAt) return position;
    const normalized = {
      ...position,
      state: 'draft',
      primaryTicket: '',
      tickets: [],
      children: [],
      expectedChildren: 0,
      pnlSnapshot: { status: 'unavailable' },
      card: {
        ...(position.card || {}),
        actions: [
          { id: 'LB', label: 'LB', command: 'position.levelOrder.buy', style: 'bl' },
          { id: 'LS', label: 'LS', command: 'position.levelOrder.sell', style: 'sl' }
        ],
        data: {
          ...(position.card?.data || {}),
          state: 'draft',
          children: [],
          expectedChildren: 0,
          tickets: [],
          pnl: { status: 'unavailable' }
        }
      }
    };
    return normalized;
  }

  function setPositionSnapshot(position) {
    if (!position || !position.id) return false;
    const normalized = normalizePositionSnapshot(position);
    positionsById.set(String(position.id), normalized);
    if (typeof onPositionSnapshot === 'function') onPositionSnapshot(normalized);
    return true;
  }

  function removePositionSnapshot(positionOrId) {
    const id = typeof positionOrId === 'object' ? positionOrId?.id : positionOrId;
    if (!id) return false;
    return positionsById.delete(String(id));
  }

  function renderRegularPositionCard(position) {
    const data = position.card?.data || {};
    return createPositionDataGrid([
      { key: 'price', label: 'Price', value: data.price },
      { key: 'qty', label: 'Qty', value: data.qty ?? position.qty },
      { key: 'sl', label: 'SL', value: data.sl },
      { key: 'tp', label: 'TP', value: data.tp },
      { key: 'riskUsd', label: 'Risk $', value: data.riskUsd ?? data.risk },
      { key: 'provider', label: 'Provider', value: data.provider || position.provider },
      { key: 'state', label: 'State', value: data.state || position.state }
    ]);
  }

  function createPositionSnapshotCard(position = {}) {
    const key = positionKey(position);
    const cardType = position.card?.type || 'regular';
    const renderer = positionCardRenderers[cardType] || positionCardRenderers.regular;
    const data = position.card?.data || {};
    const rendered = renderer(position);
    if (rendered?.classList?.contains('card')) return rendered;
    const card = el('div', 'card position-card');
    card.setAttribute('data-rowkey', key);
    card.setAttribute('data-position-id', position.id);
    card.setAttribute('data-card-type', cardType);
    card.setAttribute('data-ticker', data.ticker || position.ticker || data.symbol || position.symbol || '');
    card.setAttribute('data-instrument-type', position.instrumentType || data.instrumentType || '');

    const head = el('div', 'row');
    const left = el('div', null, null, { style: 'display:flex;align-items:center;gap:6px' });
    left.appendChild(el('div', null, positionCardTitle(position), { style: 'font-weight:600;font-size:13px' }));
    head.appendChild(left);
    const right = el('div', null, null, { style: 'display:flex;align-items:center;gap:6px' });
    const status = el('span', `card__status card__status--${position.state || 'draft'}`, position.state || '');
    status.style.display = 'inline-block';
    right.appendChild(status);
    head.appendChild(right);

    card.appendChild(head);
    card.appendChild(el('div', 'meta', cardType));
    card.appendChild(rendered);
    card.appendChild(createPositionActions(position));
    card.appendChild(el('div', 'card__note'));
    return card;
  }

  function mount() {
    ipcRenderer.invoke('positions:list').then(positions => {
      positionsById.clear();
      if (Array.isArray(positions)) {
        for (const position of positions) setPositionSnapshot(position);
      }
      render();
    }).catch(() => {
    });

    ipcRenderer.on('positions:changed', (_evt, payload = {}) => {
      if (payload.event?.type === 'position.removed' || payload.event?.type === 'position.archived') {
        const removedSnapshot = removePositionSnapshot(payload.position || payload.event?.positionId);
        const removedFallback = typeof onPositionRemoved === 'function'
          ? onPositionRemoved(payload.position || payload.event)
          : false;
        if (removedSnapshot || removedFallback) render();
        return;
      }
      if (!setPositionSnapshot(payload.position)) return;
      render();
    });
  }

  return {
    positionsById,
    setPositionSnapshot,
    removePositionSnapshot,
    normalizePositionSnapshot,
    renderRegularPositionCard,
    createPositionSnapshotCard,
    mount
  };
}

module.exports = {
  createPositionsRenderer
};
