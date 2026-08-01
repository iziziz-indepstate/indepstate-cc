const { resolveLevelOrderDefaults, normalizePriceSource, resolveQuotePrice } = require('../../domain/strategy');

function isLevelOrderChildPosition(position = {}) {
  const meta = position.source?.meta || position.executionIntent?.meta || position.card?.data?.meta || {};
  return Boolean(meta.parentRequestId) && String(meta.strategy || '') === 'limitBidTrade';
}

function createLevelOrderRenderer({
  getConfig,
  el,
  inputNumber,
  normNum,
  instrumentInfoFor,
  tickSize,
  isPos,
  isSL,
  markTouched,
  uiState,
  orderCalc,
  detectInstrumentType,
  createPositionDataGrid,
  ipcRenderer,
  trackInstrument,
  untrackInstrument,
  now = () => Date.now(),
  random = () => Math.random()
} = {}) {
  function createLevelOrderBody(row, key, $pointSize) {
    const defaults = resolveLevelOrderDefaults(getConfig?.() || {}, row.ticker);
    const defaultRisk = orderCalc.defaultRiskUsd({
      symbol: row.ticker,
      instrumentType: row.instrumentType || detectInstrumentType(row.ticker)
    });
    const saved = uiState.get(key) || {
      level: row.level != null ? String(row.level) : '',
      risk: row.riskUsd != null ? String(row.riskUsd) : (defaultRisk != null ? String(defaultRisk) : ''),
      stopOffsetPts: row.stopOffsetPts != null ? String(row.stopOffsetPts) : (defaults.stopOffsetPts != null ? String(defaults.stopOffsetPts) : ''),
      maxLot: row.maxLot != null ? String(row.maxLot) : (defaults.maxLot != null ? String(defaults.maxLot) : '0'),
      takeProfitPts: row.takeProfitPts != null ? String(row.takeProfitPts) : (defaults.takeProfitPts != null ? String(defaults.takeProfitPts) : ''),
      pointSize: row.pointSize != null ? String(row.pointSize) : ''
    };
    if ($pointSize) $pointSize.value = saved.pointSize;

    const line = el('div', 'quad-line level-order-line');
    line.style.display = 'grid';
    line.style.gridTemplateColumns = '1fr 1fr 1fr 1fr 1fr';
    line.style.alignItems = 'center';
    line.style.gap = line.style.gap || '8px';

    const $level = inputNumber('Level', 'level');
    const $risk = inputNumber('Risk $', 'risk');
    const $stopOffset = inputNumber('Stop off', 'sl');
    const $maxLot = inputNumber('Max lot', 'qty');
    const $tp = inputNumber('TP pts', 'tp');

    $level.value = saved.level;
    $risk.value = saved.risk;
    $stopOffset.value = saved.stopOffsetPts;
    $maxLot.value = saved.maxLot;
    $tp.value = saved.takeProfitPts;

    line.appendChild($level);
    line.appendChild($risk);
    line.appendChild($stopOffset);
    line.appendChild($maxLot);
    line.appendChild($tp);

    const persist = () => {
      uiState.set(key, {
        level: $level.value,
        risk: $risk.value,
        stopOffsetPts: $stopOffset.value,
        maxLot: $maxLot.value,
        takeProfitPts: $tp.value,
        pointSize: $pointSize ? $pointSize.value : ''
      });
    };

    const body = {
      type: 'levelOrder',
      line,
      setButtons($btns) {
        this._btns = $btns;
      },
      setNote($note) {
        this._note = $note;
      },
      validate(actionForValidation) {
        const level = normNum($level.value);
        const risk = normNum($risk.value);
        const stopOffsetPts = normNum($stopOffset.value);
        const maxLot = normNum($maxLot.value);
        const takeProfitPts = normNum($tp.value);
        const pointSize = normNum($pointSize?.value);
        const info = instrumentInfoFor(row.ticker, row);
        const bid = Number(info?.bid);
        const ask = Number(info?.ask);
        const buyPriceSource = normalizePriceSource(defaults.buyPriceSource, 'bid');
        const sellPriceSource = normalizePriceSource(defaults.sellPriceSource, 'bid');
        const sourceForAction = action => String(action || '').toUpperCase() === 'LS' ? sellPriceSource : buyPriceSource;
        const quoteForAction = action => resolveQuotePrice({ bid, ask, source: sourceForAction(action) });
        const pointSizeOk = !$pointSize || $pointSize.value === '' || (Number.isFinite(pointSize) && pointSize > 0);
        const tick = pointSizeOk && Number.isFinite(pointSize) && pointSize > 0 ? pointSize : tickSize(row);
        const tickOk = Number.isFinite(tick) && tick > 0;
        const minLot = Number(defaults.minLot);
        const minLotOk = Number.isFinite(minLot) && minLot > 0;
        const tpOk = $tp.value === '' || (Number.isFinite(takeProfitPts) && takeProfitPts > 0);
        const maxLotOk = Number.isFinite(maxLot) && maxLot >= 0;
        const commonValid = isPos(level) && isPos(risk) && isSL(stopOffsetPts) && maxLotOk && minLotOk && tpOk && pointSizeOk && tickOk;
        const quoteByAction = {
          LB: quoteForAction('LB'),
          LS: quoteForAction('LS')
        };
        const requestedActionRaw = String(actionForValidation || '').toUpperCase();
        const requestedAction = requestedActionRaw === 'LB' || requestedActionRaw === 'LS' ? requestedActionRaw : '';
        const quoteOk = action => quoteByAction[action]?.ok === true;
        const valid = commonValid && (requestedAction ? quoteOk(requestedAction) : quoteOk('LB') && quoteOk('LS'));

        line.classList.toggle('card--invalid', !valid);
        const setErr = (inp, bad) => inp.classList.toggle('input--error', !!bad);
        setErr($level, !isPos(level));
        setErr($risk, !isPos(risk));
        setErr($stopOffset, !isSL(stopOffsetPts));
        setErr($maxLot, !maxLotOk);
        setErr($tp, !tpOk);
        if ($pointSize) setErr($pointSize, !pointSizeOk);

        const commonReason = !isPos(level) ? 'Level > 0'
          : !isPos(risk) ? 'Risk $ > 0'
            : !isSL(stopOffsetPts) ? 'Stop offset pts > 0'
              : !maxLotOk ? 'Max lot >= 0'
                : !minLotOk ? 'Min lot > 0'
                  : !tpOk ? 'TP pts > 0 or blank'
                    : !pointSizeOk ? 'Point price > 0 or blank'
                      : !tickOk ? 'Tick size required'
                        : '';
        const quoteReason = requestedAction && !quoteOk(requestedAction)
          ? quoteByAction[requestedAction]?.reason
          : !quoteOk('LB') ? quoteByAction.LB.reason
            : !quoteOk('LS') ? quoteByAction.LS.reason
              : '';
        const reason = commonReason || quoteReason;
        const buttonReason = action => commonReason || (!quoteOk(action) ? quoteByAction[action]?.reason : '');
        if (this._btns) this._btns.querySelectorAll('button').forEach(b => {
          const action = String(b.dataset.kind || '').toUpperCase();
          const buttonValid = commonValid && quoteOk(action);
          b.disabled = !buttonValid;
          const title = buttonReason(action);
          if (title) b.title = title; else b.removeAttribute('title');
        });
        if (this._note) {
          this._note.textContent = reason;
          this._note.style.display = reason ? 'block' : 'none';
        }
        persist();
        return {
          valid,
          type: 'levelOrder',
          level,
          risk,
          stopOffsetPts,
          maxLot,
          minLot,
          takeProfitPts: $tp.value === '' ? null : takeProfitPts,
          buyPriceSource,
          sellPriceSource,
          pointSize: $pointSize && $pointSize.value !== '' ? pointSize : null,
          tickSize: tick
        };
      }
    };

    [$level, $risk, $stopOffset, $maxLot, $tp, $pointSize].filter(Boolean).forEach(inp => {
      inp.addEventListener('input', () => {
        markTouched(row.ticker);
        persist();
        body.validate();
      });
    });

    return body;
  }

  function renderPositionCard(position) {
    const data = position.card?.data || {};
    return createPositionDataGrid([
      { key: 'level', label: 'Level', value: data.level },
      { key: 'riskUsd', label: 'Risk $', value: data.riskUsd ?? data.risk },
      { key: 'stopOffsetPts', label: 'Stop off', value: data.stopOffsetPts },
      { key: 'maxLot', label: 'Max lot', value: data.maxLot },
      { key: 'takeProfitPts', label: 'TP pts', value: data.takeProfitPts },
      { key: 'provider', label: 'Provider', value: data.provider || position.provider },
      { key: 'state', label: 'State', value: data.state || position.state }
    ]);
  }

  function positionRow(position = {}) {
    const data = position.card?.data || {};
    const source = position.source || {};
    const ticker = data.ticker || data.symbol || position.ticker || position.symbol || source.ticker || source.symbol;
    return {
      ...source,
      cardType: 'levelOrder',
      ticker,
      symbol: data.symbol || position.symbol || ticker,
      provider: data.provider || position.provider || source.provider,
      instrumentType: data.instrumentType || position.instrumentType || source.instrumentType || detectInstrumentType(ticker),
      level: data.level ?? source.level,
      riskUsd: data.riskUsd ?? data.risk ?? source.riskUsd ?? source.risk,
      stopOffsetPts: data.stopOffsetPts ?? source.stopOffsetPts,
      maxLot: data.maxLot ?? source.maxLot,
      minLot: data.minLot ?? source.minLot,
      takeProfitPts: data.takeProfitPts ?? source.takeProfitPts,
      pointSize: data.pointSize ?? source.pointSize
    };
  }

  function trackPositionInstrument(position = {}) {
    if (typeof trackInstrument !== 'function') return;
    trackInstrument(positionRow(position));
  }

  function untrackPositionInstrument(position = {}) {
    if (typeof untrackInstrument !== 'function') return;
    untrackInstrument(positionRow(position));
  }

  function onPositionRemoved(position = {}) {
    untrackPositionInstrument(position);
    return false;
  }

  function createLevelOrderPositionCard({
    position,
    key,
    title,
    createActionButton,
    createActionsFromSnapshot,
    requestRemove
  } = {}) {
    const row = positionRow(position);
    trackPositionInstrument(position);
    const card = el('div', 'card position-card');
    card.setAttribute('data-rowkey', key);
    card.setAttribute('data-position-id', position.id);
    card.setAttribute('data-card-type', 'levelOrder');
    card.setAttribute('data-ticker', row.ticker || '');
    card.setAttribute('data-instrument-type', row.instrumentType || '');

    const head = el('div', 'row');
    const left = el('div', null, null, { style: 'display:flex;align-items:center;gap:6px' });
    left.appendChild(el('div', null, title || row.ticker || position.id || 'Position', { style: 'font-weight:600;font-size:13px' }));

    const $levelPointSize = inputNumber('Pt', 'point-size');
    $levelPointSize.title = 'Point price override';
    Object.assign($levelPointSize.style, {
      width: '58px',
      height: '20px',
      padding: '2px 5px',
      fontSize: '11px',
      borderRadius: '5px'
    });
    left.appendChild($levelPointSize);
    head.appendChild(left);

    const right = el('div', null, null, { style: 'display:flex;align-items:center;gap:6px' });
    const status = el('span', 'card__status');
    status.style.display = 'none';
    right.appendChild(status);
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = String.fromCharCode(215);
    close.className = 'card__close';
    Object.assign(close.style, {
      border: 'none',
      background: 'transparent',
      width: '22px',
      height: '22px',
      lineHeight: '22px',
      textAlign: 'center',
      fontSize: '16px',
      cursor: 'pointer',
      borderRadius: '4px',
      color: '#c62828',
      marginLeft: '8px'
    });
    close.title = 'Remove card';
    close.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (typeof requestRemove !== 'function') return;
      close.disabled = true;
      await requestRemove(position).catch(() => {
        close.disabled = false;
      });
    });
    right.appendChild(close);
    head.appendChild(right);

    const body = createLevelOrderBody(row, key, $levelPointSize);
    const btns = el('div', 'btns position-card__actions');
    const actions = Array.isArray(position.card?.actions) ? position.card.actions : [];
    const cols = Math.max(1, actions.length);
    btns.style.gridTemplateColumns = `repeat(${cols},1fr)`;
    for (const action of actions) {
      const label = action.label || action.id;
      const kind = action.id || label;
      const button = createActionButton({
        label,
        kind,
        className: (action.style || kind || 'action').toLowerCase(),
        onClick: async () => {
          const validated = body.validate(kind);
          if (!validated.valid) return;
          return createActionsFromSnapshot(position, action, validated);
        }
      });
      btns.appendChild(button);
    }

    card.appendChild(head);
    card.appendChild(el('div', 'meta'));
    card.appendChild(body.line);
    card.appendChild(btns);
    const note = el('div', 'card__note');
    card.appendChild(note);

    body.setButtons(btns);
    if (body.setNote) body.setNote(note);
    body.validate();
    card._validate = () => body.validate();
    return card;
  }

  function dispatchPositionAction(position = {}, action = {}, base = {}) {
    const id = String(action.id || action.label || '').toUpperCase();
    const data = position.card?.data || {};
    const requestId = base.requestId || `${now()}_${random().toString(36).slice(2, 8)}`;
    return ipcRenderer.invoke('level-order:place', {
      ...base,
      action: id || base.action,
      level: Number(base.level ?? data.level),
      riskUsd: Number(base.riskUsd ?? base.risk ?? data.riskUsd ?? data.risk),
      stopOffsetPts: Number(base.stopOffsetPts ?? data.stopOffsetPts),
      maxLot: Number(base.maxLot ?? data.maxLot),
      minLot: Number(base.minLot ?? data.minLot),
      takeProfitPts: (base.takeProfitPts ?? data.takeProfitPts) == null || (base.takeProfitPts ?? data.takeProfitPts) === ''
        ? null
        : Number(base.takeProfitPts ?? data.takeProfitPts),
      buyPriceSource: base.buyPriceSource ?? data.buyPriceSource,
      sellPriceSource: base.sellPriceSource ?? data.sellPriceSource,
      pointSize: (base.pointSize ?? data.pointSize) == null || (base.pointSize ?? data.pointSize) === ''
        ? null
        : Number(base.pointSize ?? data.pointSize),
      requestId,
      strategyId: `${requestId}_${String(id || base.action || '').toLowerCase()}`
    });
  }

  function createPositionActionDispatcher({
    positionKey,
    positionCardTitle,
    pendingByReqId,
    retryCounts,
    pendingExecLabels,
    cardByKey,
    setCardState,
    toast,
    shakeCard,
    render
  } = {}) {
    return async function placeLevelOrderPositionAction(position = {}, action = {}, base = {}) {
      const id = String(action.id || action.label || base.action || '').toUpperCase();
      const key = positionKey(position);
      const title = positionCardTitle(position);
      const requestId = `${now()}_${random().toString(36).slice(2, 8)}`;
      const strategyId = `${requestId}_${String(id).toLowerCase()}`;
      pendingByReqId.set(requestId, key);
      retryCounts.set(requestId, 0);
      pendingExecLabels.set(key, action.label || id);
      setCardState(key, 'pending-exec');
      const card = cardByKey(key);
      if (card) {
        card.dataset.reqId = requestId;
        const rb = card.querySelector('.retry-btn');
        if (rb) rb.textContent = '0';
      }

      try {
        const res = await dispatchPositionAction(position, action, {
          ...base,
          requestId,
          strategyId
        });
        if (!res || res.status === 'rejected' || res.status === 'error') {
          pendingByReqId.delete(requestId);
          retryCounts.delete(requestId);
          setCardState(key, null);
          toast(`x ${title}: ${res?.reason || 'Rejected'}`);
          shakeCard(key);
          render();
          return res;
        }
        setCardState(key, 'pending-exec');
        toast(res.status === 'unknown'
          ? `... ${title}: level order state unknown, waiting reconciliation`
          : `... ${title}: level order sent`);
        render();
        return res;
      } catch (err) {
        pendingByReqId.delete(requestId);
        retryCounts.delete(requestId);
        setCardState(key, null);
        toast(`x ${title}: ${err?.message || err}`);
        shakeCard(key);
        render();
        return { status: 'error', reason: err?.message || String(err) };
      }
    };
  }

  function isLevelOrderPlacementAction(action = {}) {
    const command = action.command || '';
    const id = String(action.id || action.label || '').toUpperCase();
    return command === 'position.levelOrder.buy'
      || command === 'position.levelOrder.sell'
      || id === 'LB'
      || id === 'LS';
  }

  function isLevelOrderCloseAction(position = {}, action = {}) {
    return action.command === 'position.close' && position.card?.type === 'levelOrder';
  }

  function isLevelOrderArchiveAction(position = {}, action = {}) {
    return action.command === 'position.remove' && position.card?.type === 'levelOrder';
  }

  function createSnapshotActionHandler({ placePositionAction } = {}) {
    return function handleLevelOrderSnapshotAction(position = {}, action = {}, base = {}) {
      if (isLevelOrderPlacementAction(action)) {
        const placeAction = typeof placePositionAction === 'function' ? placePositionAction : dispatchPositionAction;
        return placeAction(position, action, base);
      }

      if (isLevelOrderCloseAction(position, action)) {
        ipcRenderer.invoke('positions:remove', {
          positionId: position.id,
          reason: 'renderer.levelOrder.close'
        }).catch(() => {});
        return ipcRenderer.invoke('execution:close-level-order-positions', {
          ...base,
          tickets: position.tickets || [],
          expectedIds: (position.children || [])
            .map(child => child.ticket || child.requestId || child.providerOrderId)
            .filter(Boolean)
        });
      }

      if (isLevelOrderArchiveAction(position, action)) {
        return ipcRenderer.invoke('positions:remove', {
          positionId: position.id,
          reason: 'renderer.levelOrder.archive'
        });
      }

      return undefined;
    };
  }

  return {
    createLevelOrderBody,
    renderPositionCard,
    createLevelOrderPositionCard,
    dispatchPositionAction,
    createPositionActionDispatcher,
    createSnapshotActionHandler,
    onPositionRemoved,
    isLevelOrderChildPosition
  };
}

module.exports = {
  createLevelOrderRenderer,
  isLevelOrderChildPosition
};
