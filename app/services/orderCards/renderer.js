function createOrderCardsRenderer({
  el,
  inputNumber,
  uiState,
  orderCalc,
  priceToPoints,
  normNum,
  isPos,
  isSL,
  tickSize,
  ensureInstrument = () => {},
  instrumentInfoFor,
  tradeRules,
  markTouched,
  detectInstrumentType,
  rowKey,
  ipcRenderer,
  pendingByReqId,
  pendingIdByReqId,
  retryCounts,
  pendingExecLabels,
  cardByKey,
  setCardState,
  pendingActionInfo,
  instrumentTypeHandlers = {},
  cardTypeHandlers = {},
  toast,
  shakeCard,
  render,
  btn,
  removeRow,
  formatBidAskText = () => '',
  formatSpreadTriple = () => '',
  updateSpreadForTicker = () => {},
  shouldShowBidAsk = () => false,
  shouldShowSpread = () => false,
  getCardButtons = () => [],
  getButtonRows = () => 1,
  getRows = () => [],
  now = () => Date.now(),
  random = () => Math.random()
} = {}) {
function registerInstrumentHandler(instrumentType, handler) {
  const key = String(instrumentType || '').trim();
  if (!key || !handler || typeof handler !== 'object') return false;
  instrumentTypeHandlers[key] = handler;
  return () => {
    if (instrumentTypeHandlers[key] === handler) delete instrumentTypeHandlers[key];
  };
}

function registerCardTypeHandler(cardType, handler) {
  const key = String(cardType || '').trim();
  if (!key || !handler || typeof handler !== 'object') return false;
  cardTypeHandlers[key] = handler;
  return () => {
    if (cardTypeHandlers[key] === handler) delete cardTypeHandlers[key];
  };
}

function handlerFor(row = {}, instrumentType) {
  const type = instrumentType || row.instrumentType;
  return instrumentTypeHandlers[type] || cardTypeHandlers[row.cardType] || cardTypeHandlers[row.type] || null;
}

function handlerForKey(key) {
  const row = (getRows() || []).find(r => rowKey(r) === key) || {};
  return handlerFor(row, row.instrumentType);
}

function titleFor(row = {}, instrumentType) {
  const handler = handlerFor(row, instrumentType);
  const custom = typeof handler?.title === 'function'
    ? handler.title({ row, instrumentType })
    : null;
  return custom || row.ticker;
}

function matchesExistingRow(incomingRow = {}, existingRow = {}) {
  const instrumentType = incomingRow.instrumentType || detectInstrumentType(incomingRow.ticker);
  const handler = handlerFor(incomingRow, instrumentType);
  if (typeof handler?.matchesExistingRow === 'function') {
    return !!handler.matchesExistingRow({ incomingRow, existingRow, rowKey });
  }
  return existingRow.ticker === incomingRow.ticker;
}

function createBody(row, key, instrumentType) {
  const handler = handlerFor(row, instrumentType);
  if (handler && typeof handler.createBody === 'function') return handler.createBody(row, key);
  switch (instrumentType) {
    case 'EQ':
      return createEquitiesBody(row, key);
    case 'FX':
      return createFxBody(row, key);
    case 'CX':
      return createCryptoBody(row, key);
    default:
      return createEquitiesBody(row, key);
  }
}

function buttons(row, instrumentType) {
  const handler = handlerFor(row, instrumentType);
  if (handler && typeof handler.buttons === 'function') {
    const configured = handler.buttons(row);
    if (Array.isArray(configured) && configured.length) return configured;
  }
  return null;
}

function scheduleInstantExecution(row, placeFn = place, instrumentType) {
  const handler = handlerFor(row, instrumentType);
  if (!handler || typeof handler.scheduleInstantExecution !== 'function') return false;
  if (typeof handler.shouldScheduleInstantExecution === 'function'
    && !handler.shouldScheduleInstantExecution({ row, instrumentType })) return false;
  return handler.scheduleInstantExecution({ row, place: placeFn, instrumentType });
}

// ======= Crypto body (Qty, Price, SL, TP; TP auto = SL*3) =======
function createCryptoBody(row, key) {
  const defaultRisk = orderCalc.defaultRiskUsd({ symbol: row.ticker, instrumentType: 'CX' });
  const saved = uiState.get(key) || {
    qty: row.qty != null ? String(row.qty) : '',
    price: row.price != null ? String(row.price) : '',
    sl: row.sl != null ? String(row.sl) : '',
    tp: row.tp != null ? String(row.tp) : '',
    risk: row.risk != null ? String(row.risk) : (defaultRisk != null ? String(defaultRisk) : ''),
    tpTouched: row.tp != null, // если TP пришёл с хуком — не перезатираем авто-логикой
  };
  let tpTouched = !!saved.tpTouched;
  let autoTpUpdate = false;

  const line = el('div', 'quad-line');
  line.style.display = 'grid';
  line.style.gridTemplateColumns = '1fr 1fr 0.8fr 0.8fr 1fr'; // Qty, Price, SL, TP, Risk$
  line.style.alignItems = 'center';
  line.style.gap = line.style.gap || '8px';

  const $qty = inputNumber('Qty', 'qty');
  const $price = inputNumber('Price', 'pr');
  const $sl = inputNumber('SL', 'sl');
  const $tp = inputNumber('TP', 'tp');
  const $risk = inputNumber('Risk $', 'risk');

  // restore
  $qty.value = saved.qty;
  $price.value = saved.price;
  $sl.value = saved.sl;
  $tp.value = saved.tp;
  $risk.value = saved.risk;

  line.appendChild($qty);
  line.appendChild($price);
  line.appendChild($sl);
  line.appendChild($tp);
  line.appendChild($risk);

  const persist = () => {
    uiState.set(key, {
      qty: $qty.value,
      price: $price.value,
      sl: $sl.value,
      tp: $tp.value,
      risk: $risk.value,
      tpTouched
    });
  };
  const recomputeTP = () => {
    if (!tpTouched) {
      const slv = priceToPoints($sl, normNum($price.value), row);
      autoTpUpdate = true;
      $tp.value = (slv && slv > 0) ? String(orderCalc.takePts(slv)) : '';
      autoTpUpdate = false;
      persist();
    }
  };
  const recomputeQtyFromRisk = () => {
    const r = normNum($risk.value);
    const sl = priceToPoints($sl, normNum($price.value), row);
    const lot = Number.isFinite(row.lot) && row.lot > 0 ? row.lot : 1;
    const tick = tickSize(row);

    if (isPos(r) && isSL(sl) && Number.isFinite(tick) && tick > 0) {
      const q = orderCalc.qty({riskUsd: r, stopPts: sl, tickSize: tick, lot, instrumentType: 'CX'});
      console.log('[UI][SIZE]', { ticker: row.ticker, riskUsd: r, stopPts: sl, tickSize: tick, quoteTickSize: instrumentInfoFor(row.ticker, row)?.tickSize, rowTickSize: row.tickSize, qty: q });
      $qty.value = String(q);
    }
    if (isPos(r) && isSL(sl) && (!Number.isFinite(tick) || tick <= 0)) {
      console.log('[UI][SIZE]', { ticker: row.ticker, riskUsd: r, stopPts: sl, tickSize: tick, quoteTickSize: instrumentInfoFor(row.ticker, row)?.tickSize, rowTickSize: row.tickSize, qty: null, state: 'tick-loading' });
      $qty.value = '';
    }
    persist();
  };

  const body = {
    type: 'crypto',
    line, $qty, $price, $sl, $tp, $risk,
    setButtons($btns) {
      this._btns = $btns;
    },
    setNote($note) {
      this._note = $note;
    },
    validate(commit = false) {
      const qty = normNum($qty.value);
      const pr = normNum($price.value);
      const risk = normNum($risk.value);
      const sl = priceToPoints($sl, pr, row, commit);
      const tpVal = priceToPoints($tp, pr, row, commit);
      const info = instrumentInfoFor(row.ticker, row);
      const instrumentType = row.instrumentType || detectInstrumentType(row.ticker);
      const qtyOk = isPos(qty);
      const priceOk = isPos(pr);
      const slOk = isSL(sl);
      const {ok: rulesOk, reason: ruleReason = ''} = tradeRules.validate({
        price: pr,
        side: row.side,
        sl,
        instrumentType,
        qty
      }, info);
      const valid = qtyOk && priceOk && slOk && rulesOk;

      line.classList.toggle('card--invalid', !valid);

      const setErr = (inp, bad) => inp.classList.toggle('input--error', !!bad);
      setErr($qty, !qtyOk || (!rulesOk && ruleReason.toLowerCase().includes('qty')));
      setErr($price, !priceOk || (!rulesOk && !ruleReason.toLowerCase().includes('sl')));
      setErr($sl, !slOk || (!rulesOk && ruleReason.toLowerCase().includes('sl')));

      const reason = !qtyOk ? 'Qty > 0'
        : !priceOk ? 'Price > 0'
          : !slOk ? 'SL > 0'
            : !rulesOk ? ruleReason
              : '';
      if (this._btns) this._btns.querySelectorAll('button').forEach(b => {
        b.disabled = !valid;
        if (!valid) b.title = reason; else b.removeAttribute('title');
      });
      if (this._note) {
        if (!valid && reason) {
          this._note.textContent = reason;
          this._note.style.display = 'block';
        } else {
          this._note.textContent = '';
          this._note.style.display = 'none';
        }
      }
  return {valid, type: 'crypto', qty, pr, sl, tp: tpVal, risk};
    }
  };

  // wiring
  $risk.addEventListener('input', () => {
    markTouched(row.ticker);
    recomputeQtyFromRisk();
    body.validate();
  });
  $sl.addEventListener('input', () => {
    markTouched(row.ticker);
    if (String($sl.value).includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    body.validate();
  });
  $sl.addEventListener('blur', () => {
    const raw = $sl.value;
    priceToPoints($sl, normNum($price.value), row, true);
    if (raw.includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    persist();
    body.validate(true);
  });
  $qty.addEventListener('input', () => {
    markTouched(row.ticker);
    persist();
    body.validate();
  });
  $price.addEventListener('input', () => {
    markTouched(row.ticker);
    persist();
    body.validate();
  });
  $price.addEventListener('blur', () => {
    const slRaw = $sl.value;
    priceToPoints($sl, normNum($price.value), row, true);
    priceToPoints($tp, normNum($price.value), row, true);
    if (slRaw.includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    persist();
    body.validate(true);
  });
  $tp.addEventListener('input', () => {
    if (autoTpUpdate) return;
    markTouched(row.ticker);
    tpTouched = true;
    persist();
    body.validate();
  });
  $tp.addEventListener('blur', () => {
    priceToPoints($tp, normNum($price.value), row, true);
    persist();
    body.validate(true);
  });

  // Автопочатковий розрахунок qty з Risk/SL (якщо задано)
  recomputeQtyFromRisk();
  // Если TP не передан — вычисляем его из SL
  recomputeTP();
  return body;
}

// ======= Equities body (Qty, Price, SL, TP; Risk$ separate line; Qty auto from Risk/SL) =======
function createFxBody(row, key) {
  const defaultRisk = orderCalc.defaultRiskUsd({ symbol: row.ticker, instrumentType: 'FX' });
  const saved = uiState.get(key) || {
    qty: row.qty != null ? String(row.qty) : '',
    price: row.price != null ? String(row.price) : '',
    sl: row.sl != null ? String(row.sl) : '',
    tp: row.tp != null ? String(row.tp) : '',
    risk: row.risk != null ? String(row.risk) : (defaultRisk != null ? String(defaultRisk) : ''),
    tpTouched: row.tp != null,
  };
  let tpTouched = !!saved.tpTouched;
  let autoTpUpdate = false;

  const line = el('div', 'quad-line');
  line.style.display = 'grid';
  line.style.gridTemplateColumns = '1fr 1fr 0.8fr 0.8fr 1fr'; // Qty, Price, SL, TP, Risk$
  line.style.alignItems = 'center';
  line.style.gap = line.style.gap || '8px';

  const $qty = inputNumber('Qty', 'qty');
  const $price = inputNumber('Price', 'pr');
  const $sl = inputNumber('SL', 'sl');
  const $tp = inputNumber('TP', 'tp');
  const $risk = inputNumber('Risk $', 'risk');

  // restore
  $qty.value = saved.qty;
  $price.value = saved.price;
  $sl.value = saved.sl;
  $tp.value = saved.tp;
  $risk.value = saved.risk;

  const persist = () => {
    uiState.set(key, {
      qty: $qty.value,
      price: $price.value,
      sl: $sl.value,
      tp: $tp.value,
      risk: $risk.value,
      tpTouched
    });
  };
  const recomputeQtyFromRisk = () => {
    const r = normNum($risk.value);
    const sl = priceToPoints($sl, normNum($price.value), row);
    if (isPos(r) && isSL(sl)) {
      const tick = tickSize(row);
      const lot = row.lot || 100000;
      const q = orderCalc.qty({riskUsd: r, stopPts: sl, tickSize: tick, lot, instrumentType: 'FX'});
      $qty.value = String(q);
    }
    persist();
  };
  const recomputeTP = () => {
    if (!tpTouched) {
      const slv = priceToPoints($sl, normNum($price.value), row);
      autoTpUpdate = true;
      $tp.value = (slv && slv > 0) ? String(orderCalc.takePts(slv)) : '';
      autoTpUpdate = false;
      persist();
    }
  };

  const body = {
    type: 'fx',
    line, $qty, $price, $sl, $tp, $risk,
    setButtons($btns) {
      this._btns = $btns;
    },
    validate(commit = false) {
      const qtyRaw = normNum($qty.value);
      const pr = normNum($price.value);
      const sl = priceToPoints($sl, pr, row, commit);
      const tpVal = priceToPoints($tp, pr, row, commit);
      const risk = normNum($risk.value);
      const info = instrumentInfoFor(row.ticker, row);
      const instrumentType = row.instrumentType || 'FX';

      const qtyOk = Number.isFinite(qtyRaw) && qtyRaw > 0;
      const {ok: rulesOk, reason: ruleReason = ''} = tradeRules.validate({
        price: pr,
        side: row.side,
        sl,
        instrumentType,
        qty: qtyRaw
      }, info);
      const valid = isPos(risk) && isSL(sl) && isPos(pr) && qtyOk && rulesOk;

      line.classList.toggle('card--invalid', !valid);

      const setErr = (inp, bad) => inp.classList.toggle('input--error', !!bad);
      setErr($risk, !isPos(risk));
      setErr($sl, !isSL(sl) || (!rulesOk && ruleReason.toLowerCase().includes('sl')));
      setErr($price, !isPos(pr) || (!rulesOk && !ruleReason.toLowerCase().includes('sl')));
      setErr($qty, !qtyOk || (!rulesOk && ruleReason.toLowerCase().includes('qty')));

      const reason = !isPos(risk) ? 'Risk $ > 0'
        : !isSL(sl) ? 'SL > 0'
          : !isPos(pr) ? 'Price > 0'
            : !qtyOk ? 'Qty > 0'
              : !rulesOk ? ruleReason
                : '';
      if (this._btns) this._btns.querySelectorAll('button').forEach(b => {
        b.disabled = !valid;
        if (!valid) b.title = reason; else b.removeAttribute('title');
      });

      return {
        valid, type: 'fx',
        qty: qtyRaw, pr, sl, risk, tp: tpVal //todo normalize to min qty
      };
    }
  };

  // wiring
  $risk.addEventListener('input', () => {
    markTouched(row.ticker);
    recomputeQtyFromRisk();
    body.validate();
  });
  $sl.addEventListener('input', () => {
    markTouched(row.ticker);
    if (String($sl.value).includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    body.validate();
  });
  $sl.addEventListener('blur', () => {
    const raw = $sl.value;
    priceToPoints($sl, normNum($price.value), row, true);
    if (raw.includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    persist();
    body.validate(true);
  });
  $qty.addEventListener('input', () => {
    markTouched(row.ticker);
    persist();
    body.validate();
  });
  $price.addEventListener('input', () => {
    markTouched(row.ticker);
    persist();
    body.validate();
  });
  $price.addEventListener('blur', () => {
    const slRaw = $sl.value;
    priceToPoints($sl, normNum($price.value), row, true);
    priceToPoints($tp, normNum($price.value), row, true);
    if (slRaw.includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    persist();
    body.validate(true);
  });
  $tp.addEventListener('input', () => {
    if (autoTpUpdate) return;
    markTouched(row.ticker);
    tpTouched = true;
    persist();
    body.validate();
  });
  $tp.addEventListener('blur', () => {
    priceToPoints($tp, normNum($price.value), row, true);
    persist();
    body.validate(true);
  });

  // assemble
  line.appendChild($qty);
  line.appendChild($price);
  line.appendChild($sl);
  line.appendChild($tp);
  line.appendChild($risk);

  // compute qty from default risk and SL (if provided)
  recomputeQtyFromRisk();
  // if TP wasn't provided, derive it from SL
  recomputeTP();
  return body;
}


// ======= Equities body (Qty, Price, SL, TP; Risk$ separate line; Qty auto from Risk/SL) =======
function createEquitiesBody(row, key) {
  const defaultRisk = orderCalc.defaultRiskUsd({ symbol: row.ticker, instrumentType: 'EQ' });
  const saved = uiState.get(key) || {
    qty: row.qty != null ? String(row.qty) : '',
    price: row.price != null ? String(row.price) : '',
    sl: row.sl != null ? String(row.sl) : '',
    tp: row.tp != null ? String(row.tp) : '',
    risk: row.risk != null ? String(row.risk) : (defaultRisk != null ? String(defaultRisk) : ''),
    tpTouched: row.tp != null,
  };
  let tpTouched = !!saved.tpTouched;
  let autoTpUpdate = false;

  const line = el('div', 'quad-line');
  line.style.display = 'grid';
  line.style.gridTemplateColumns = '1fr 1fr 0.8fr 0.8fr 1fr'; // Qty, Price, SL, TP, Risk$
  line.style.alignItems = 'center';
  line.style.gap = line.style.gap || '8px';

  const $qty = inputNumber('Qty', 'qty');
  const $price = inputNumber('Price', 'pr');
  const $sl = inputNumber('SL', 'sl');
  const $tp = inputNumber('TP', 'tp');
  const $risk = inputNumber('Risk $', 'risk');

  // restore
  $qty.value = saved.qty;
  $price.value = saved.price;
  $sl.value = saved.sl;
  $tp.value = saved.tp;
  $risk.value = saved.risk;

  const persist = () => {
    uiState.set(key, {
      qty: $qty.value,
      price: $price.value,
      sl: $sl.value,
      tp: $tp.value,
      risk: $risk.value,
      tpTouched
    });
  };
  const recomputeQtyFromRisk = () => {
    const r = normNum($risk.value);
    const sl = priceToPoints($sl, normNum($price.value), row);
    if (isPos(r) && isSL(sl)) {
      const tick = tickSize(row);
      const q = orderCalc.qty({riskUsd: r, stopPts: sl, tickSize: tick, instrumentType: 'EQ'});
      $qty.value = String(q);
    }
    persist();
  };
  const recomputeTP = () => {
    if (!tpTouched) {
      const slv = priceToPoints($sl, normNum($price.value), row);
      autoTpUpdate = true;
      $tp.value = (slv && slv > 0) ? String(orderCalc.takePts(slv)) : '';
      autoTpUpdate = false;
      persist();
    }
  };

  const body = {
    type: 'equities',
    line, $qty, $price, $sl, $tp, $risk,
    setButtons($btns) {
      this._btns = $btns;
    },
    setNote($note) {
      this._note = $note;
    },
    validate(commit = false) {
      const qtyRaw = normNum($qty.value);
      const pr = normNum($price.value);
      const sl = priceToPoints($sl, pr, row, commit);
      const tpVal = priceToPoints($tp, pr, row, commit);
      const risk = normNum($risk.value);
      const info = instrumentInfoFor(row.ticker, row);
      const instrumentType = row.instrumentType || detectInstrumentType(row.ticker);

      const qtyOk = Number.isFinite(qtyRaw) && qtyRaw >= 1 && Math.floor(qtyRaw) === qtyRaw;
      const priceOk = isPos(pr);
      const slOk = isSL(sl);
      const riskOk = isPos(risk);
      const {ok: rulesOk, reason: ruleReason = ''} = tradeRules.validate({
        price: pr,
        side: row.side,
        sl,
        instrumentType,
        qty: qtyRaw
      }, info);

      const valid = riskOk && slOk && priceOk && qtyOk && rulesOk;

      line.classList.toggle('card--invalid', !valid);

      const setErr = (inp, bad) => inp.classList.toggle('input--error', !!bad);
      setErr($risk, !riskOk);
      setErr($sl, !slOk || (!rulesOk && ruleReason.toLowerCase().includes('sl')));
      setErr($price, !priceOk || (!rulesOk && !ruleReason.toLowerCase().includes('sl')));
      setErr($qty, !qtyOk || (!rulesOk && ruleReason.toLowerCase().includes('qty')));

      const reason = !riskOk ? 'Risk $ > 0'
        : !slOk ? 'SL > 0'
          : !priceOk ? 'Price > 0'
            : !qtyOk ? 'Qty ≥ 1 (int)'
              : !rulesOk ? ruleReason
                : '';
      if (this._btns) this._btns.querySelectorAll('button').forEach(b => {
        b.disabled = !valid;
        if (!valid) b.title = reason; else b.removeAttribute('title');
      });
      if (this._note) {
        if (!valid && reason) {
          this._note.textContent = reason;
          this._note.style.display = 'block';
        } else {
          this._note.textContent = '';
          this._note.style.display = 'none';
        }
      }

      return {
        valid, type: 'equities',
        qty: qtyRaw, pr, sl, risk, tp: tpVal,
        qtyInt: Number.isFinite(qtyRaw) ? Math.floor(qtyRaw) : 0
      };
    }
  };

  // wiring
  $risk.addEventListener('input', () => {
    markTouched(row.ticker);
    recomputeQtyFromRisk();
    body.validate();
  });
  $sl.addEventListener('input', () => {
    markTouched(row.ticker);
    if (String($sl.value).includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    body.validate();
  });
  $sl.addEventListener('blur', () => {
    const raw = $sl.value;
    priceToPoints($sl, normNum($price.value), row, true);
    if (raw.includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    persist();
    body.validate(true);
  });
  $qty.addEventListener('input', () => {
    markTouched(row.ticker);
    persist();
    body.validate();
  });
  $price.addEventListener('input', () => {
    markTouched(row.ticker);
    persist();
    body.validate();
  });
  $price.addEventListener('blur', () => {
    const slRaw = $sl.value;
    priceToPoints($sl, normNum($price.value), row, true);
    priceToPoints($tp, normNum($price.value), row, true);
    if (slRaw.includes('.')) tpTouched = false;
    recomputeQtyFromRisk();
    recomputeTP();
    persist();
    body.validate(true);
  });
  $tp.addEventListener('input', () => {
    if (autoTpUpdate) return;
    markTouched(row.ticker);
    tpTouched = true;
    persist();
    body.validate();
  });
  $tp.addEventListener('blur', () => {
    priceToPoints($tp, normNum($price.value), row, true);
    persist();
    body.validate(true);
  });

  // assemble
  line.appendChild($qty);
  line.appendChild($price);
  line.appendChild($sl);
  line.appendChild($tp);
  line.appendChild($risk);

  // compute qty from default risk and SL (if provided)
  recomputeQtyFromRisk();
  // prefill TP from SL when not explicitly passed
  recomputeTP();
  return body;
}



function keyForRow(row = {}) {
  return row.__positionKey || rowKey(row);
}

function isUpEvent(ev) {
  return /(up|long)/i.test(String(ev));
}

function createLegacyOrderCard({ row = {}, index } = {}) {
  const key = rowKey(row);
  const instrumentType = row.instrumentType || detectInstrumentType(row.ticker);
  const cardHandler = handlerFor(row, instrumentType);

  ensureInstrument(row.ticker, row.provider);
  cardHandler?.onCreateCard?.({ row, key, instrumentType });

  const card = el('div', 'card');
  card.setAttribute('data-rowkey', key);
  card.setAttribute('data-ticker', row.ticker);
  card.setAttribute('data-instrument-type', instrumentType);

  const head = el('div', 'row');
  const left = el('div', null, null, {style: 'display:flex;align-items:center;gap:6px'});
  left.appendChild(el('div', null, titleFor(row, instrumentType), {style: 'font-weight:600;font-size:13px'}));
  if (shouldShowBidAsk()) {
    const $bidask = el('span', 'card__bidask');
    $bidask.title = 'Bid / Ask';
    $bidask.style.fontSize = '11px';
    $bidask.style.color = '#6b7280';
    $bidask.textContent = formatBidAskText(instrumentInfoFor(row.ticker, row), row) || '';
    left.appendChild($bidask);
  }
  head.appendChild(left);

  const right = el('div', null, null, {style: 'display:flex;align-items:center;gap:6px'});
  const $status = el('span', 'card__status');
  $status.style.display = 'none';
  right.appendChild($status);

  if (shouldShowSpread()) {
    const $spread = el('span', 'card__spread');
    $spread.title = 'Spread pts: current / avg10 / avg100';
    $spread.style.fontSize = '11px';
    $spread.style.color = '#6b7280';
    $spread.textContent = formatSpreadTriple(row.ticker, row) || '';
    right.appendChild($spread);
  }

  const $retry = document.createElement('button');
  $retry.type = 'button';
  $retry.className = 'retry-btn';
  $retry.textContent = '0';
  $retry.title = 'Stop retries';
  $retry.style.display = 'none';
  $retry.addEventListener('click', (e) => {
    e.stopPropagation();
    const cardEl = e.currentTarget.closest('.card');
    const reqId = cardEl?.dataset.reqId;
    if (reqId) ipcRenderer.invoke('execution:stop-retry', reqId);
  });
  right.appendChild($retry);

  const $close = document.createElement('button');
  $close.type = 'button';
  $close.textContent = '×';
  $close.className = 'card__close';
  Object.assign($close.style, {
    border: 'none',
    background: 'transparent',
    width: '22px',
    height: '22px',
    lineHeight: '22px',
    textAlign: 'center',
    fontSize: '16px',
    cursor: 'pointer',
    borderRadius: '4px',
    color: isUpEvent(row.event) ? '#2e7d32' : '#c62828',
    marginLeft: '8px'
  });
  $close.title = 'Удалить карточку';
  $close.addEventListener('click', (e) => {
    e.stopPropagation();
    removeRow?.(row);
  });
  right.appendChild($close);
  head.appendChild(right);

  const meta = el('div', 'meta');
  const body = createBody(row, key, instrumentType);
  const btns = el('div', 'btns');
  const mk = (label, cls, kind) => {
    const b = btn(label, cls, async () => {
      const v = body.validate();
      if (!v.valid) return;
      await place(kind, row, v, instrumentType, label);
    });
    b.setAttribute('data-kind', kind);
    return b;
  };
  const cardButtons = buttons(row, instrumentType) || getCardButtons();
  const rows = Number(getButtonRows()) || 1;
  const cols = Math.ceil(cardButtons.length / rows);
  btns.style.gridTemplateColumns = `repeat(${cols},1fr)`;
  for (const {label, action, style} of cardButtons) {
    btns.appendChild(mk(label, (style || action).toLowerCase(), action));
  }

  card.appendChild(head);
  card.appendChild(meta);
  card.appendChild(body.line);
  if (body.extraRow) card.appendChild(body.extraRow);
  card.appendChild(btns);
  const note = el('div', 'card__note');
  card.appendChild(note);

  body.setButtons(btns);
  if (body.setNote) body.setNote(note);
  body.validate();
  card._validate = (commit = false) => body.validate(commit);

  return card;
}

async function place(kind, row, v, instrumentType, btnLabel) {
  if (!v.valid) return;

  const key = keyForRow(row);
  const requestId = `${now()}_${random().toString(36).slice(2, 8)}`;
  pendingByReqId.set(requestId, key);
  retryCounts.set(requestId, 0);
  const pendingInfo = pendingActionInfo(kind);
  const isPendingExec = !!pendingInfo;
  const isLong = pendingInfo ? pendingInfo.side === 'long' : null;
  const alias = isPendingExec ? btnLabel : null;
  if (alias) pendingExecLabels.set(key, alias);
  setCardState(key, isPendingExec ? 'pending-exec' : 'pending');
  const card = cardByKey(key);
  if (card) {
    card.dataset.reqId = requestId;
    const rb = card.querySelector('.retry-btn');
    if (rb) rb.textContent = '0';
  }

  let qtyVal, priceVal, slVal, takeVal, tick, extra = {};
  if (v.type === 'crypto') {
    qtyVal = v.qty;
    priceVal = v.pr;
    slVal = v.sl;
    takeVal = v.tp ?? null;
    tick = tickSize(row);  //do not fallback for crypro to keep fail order if tick size is unknown
    extra.riskUsd = v.risk;
  } else if (v.type === 'equities') {
    qtyVal = v.qtyInt;
    priceVal = v.pr;
    slVal = v.sl;
    takeVal = v.tp ?? null;
    tick = tickSize(row);
    extra.riskUsd = v.risk;
  } else {
    qtyVal = v.qty;
    priceVal = v.pr;
    slVal = v.sl;
    takeVal = v.tp ?? null;
    tick = tickSize(row);
    extra.riskUsd = v.risk;
  }

  const baseMeta = {
    requestId, // связь с execution:result
    qty: Number(qtyVal),
    stopPts: Number(slVal),
    takePts: takeVal == null ? null : Number(takeVal),
    ...extra
  };
  if (row.positionId || row.meta?.positionId) baseMeta.positionId = row.positionId || row.meta.positionId;

  let res;
  try {
    const handler = handlerFor(row, instrumentType);
    if (isPendingExec) {
      const pendPayload = {
        ticker: row.ticker,
        provider: row.provider,
        event: row.event,
        price: Number(priceVal),
        side: isLong ? 'long' : 'short',
        strategy: pendingInfo?.strategy,
        instrumentType: instrumentType,
        tickSize: tick,
        meta: baseMeta,
      };
      res = await ipcRenderer.invoke('queue-place-pending', pendPayload);
    } else {
      const prepared = handler && typeof handler.preparePlace === 'function'
        ? await handler.preparePlace({ row, validated: v, requestId, baseMeta, kind, instrumentType, btnLabel })
        : null;
      if (prepared) {
        res = await ipcRenderer.invoke(prepared.channel || 'queue-place-order', prepared.payload || prepared);
      } else {
        const payload = {
          ticker: row.ticker,
          event: row.event,
          price: Number(priceVal),
          kind,
          instrumentType: instrumentType,
          tickSize: tick,
          meta: baseMeta,
        };
        res = await ipcRenderer.invoke('queue-place-order', payload);
      }
    }
    if (res && typeof res.providerOrderId === 'string' && res.providerOrderId.startsWith('pending:')) {
      const pendId = res.providerOrderId.slice('pending:'.length);
      pendingIdByReqId.set(requestId, pendId);
      if (card) card.dataset.pendingId = pendId;
      toast(`… ${row.ticker}: sent, waiting confirmation`);
    }
    if (!res || res.status === 'rejected' || res.status === 'error') {
      setCardState(key, null);
      toast(`✖ ${row.ticker}: ${res?.reason || 'Rejected'}`);
      shakeCard(key);
      render();
    } else {
      if (handler && typeof handler.afterPlaceOk === 'function') {
        await handler.afterPlaceOk({ row, validated: v, result: res, requestId, key, baseMeta, kind, instrumentType, btnLabel });
      } else {
        setCardState(key, isPendingExec ? 'pending-exec' : 'pending');
      }
      render();
    }
  } catch (e) {
    setCardState(key, null);
    toast(`✖ ${row.ticker}: ${e.message || e}`);
    shakeCard(key);
    render();
  }
}

function regularRowFromPosition(position = {}, key) {
  const data = position.card?.data || {};
  const source = position.source || {};
  const symbol = data.ticker || data.symbol || position.ticker || position.symbol || source.ticker || source.symbol;
  return {
    ...source,
    ...data,
    __positionKey: key,
    positionId: position.id,
    ticker: symbol,
    symbol: data.symbol || position.symbol || symbol,
    provider: data.provider || position.provider || source.provider,
    event: data.event || source.event || position.side || '',
    instrumentType: data.instrumentType || position.instrumentType || source.instrumentType,
    price: data.price ?? source.price,
    qty: data.qty ?? position.qty ?? source.qty,
    sl: data.sl ?? source.sl,
    tp: data.tp ?? source.tp,
    risk: data.risk ?? data.riskUsd ?? source.risk ?? source.riskUsd,
    riskUsd: data.riskUsd ?? data.risk ?? source.riskUsd ?? source.risk,
    cardType: 'regular'
  };
}

function appendDataField(parent, key, label, value) {
  const item = el('div', 'position-card__field');
  item.dataset.field = key;
  item.appendChild(el('span', 'position-card__field-label', label));
  item.appendChild(el('span', 'position-card__field-value', formatPositionValue(value)));
  parent.appendChild(item);
}

function formatPositionValue(value) {
  if (value == null || value === '') return '-';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '-';
  if (typeof value === 'object') {
    if (value.status && value.value != null) return `${value.status}: ${value.value}`;
    if (value.status) return value.status;
    return JSON.stringify(value);
  }
  return String(value);
}

function createSnapshotDataGrid(position = {}) {
  const data = position.card?.data || {};
  const grid = el('div', 'position-card__data');
  Object.assign(grid.style, {
    display: 'grid',
    gridTemplateColumns: 'repeat(2,minmax(0,1fr))',
    gap: '6px',
    fontSize: '11px'
  });
  [
    { key: 'price', label: 'Price', value: data.price },
    { key: 'qty', label: 'Qty', value: data.qty ?? position.qty },
    { key: 'sl', label: 'SL', value: data.sl },
    { key: 'tp', label: 'TP', value: data.tp },
    { key: 'riskUsd', label: 'Risk $', value: data.riskUsd ?? data.risk },
    { key: 'provider', label: 'Provider', value: data.provider || position.provider },
    { key: 'primaryTicket', label: 'Ticket', value: position.primaryTicket || data.primaryTicket },
    { key: 'tickets', label: 'Tickets', value: position.tickets || data.tickets },
    { key: 'pnl', label: 'PnL', value: position.pnlSnapshot || data.pnl },
    { key: 'state', label: 'State', value: position.state || data.state }
  ].forEach(field => appendDataField(grid, field.key, field.label, field.value));
  return grid;
}

function normalizeRegularAction(action = {}) {
  if (typeof action === 'string') return { label: action, action, style: action };
  const id = action.id || action.action || action.label;
  if (!id) return null;
  return {
    label: action.label || id,
    action: action.action || action.id || id,
    style: action.style || action.action || action.id || id,
    command: action.command,
    payload: action.payload
  };
}

function defaultRegularActions(position = {}) {
  const actions = Array.isArray(position.card?.actions) ? position.card.actions : [];
  if (isEditableRegularPosition(position)) {
    const openActions = actions
      .map(normalizeRegularAction)
      .filter(action => !action.command || ['position.open', 'position.openPending'].includes(action.command));
    if (openActions.length) return openActions;
    return (getCardButtons() || []).map(normalizeRegularAction).filter(Boolean);
  }
  if (actions.length) return actions.map(normalizeRegularAction).filter(Boolean);
  return (getCardButtons() || []).map(normalizeRegularAction).filter(Boolean);
}

function isEditableRegularPosition(position = {}) {
  const state = String(position.state || position.card?.data?.state || 'draft').toLowerCase();
  return ['', 'draft', 'rejected', 'cancelled', 'failed'].includes(state);
}

function regularPositionStatus(position = {}) {
  const hasOpenedAt = !!(position.timestamps?.openedAt || position.openedAt || position.card?.data?.timestamps?.openedAt);
  const state = hasOpenedAt && String(position.state || '').toLowerCase() === 'placed'
    ? 'active'
    : position.state || position.card?.data?.state || '';
  if (['draft', 'cancelled'].includes(String(state).toLowerCase())) return '';
  if (state) return String(state);
  if (position.primaryTicket) return 'placed';
  return '';
}

function isCompactRegularPosition(position = {}) {
  const status = regularPositionStatus(position).toLowerCase();
  return !!status && !['rejected', 'cancelled', 'failed'].includes(status);
}

function createRegularPositionCard({
  position = {},
  key,
  title,
  instrumentType,
  createActionButton,
  dispatchPositionAction,
  requestRemove
} = {}) {
  const row = regularRowFromPosition(position, key);
  const resolvedInstrumentType = instrumentType || row.instrumentType || detectInstrumentType(row.ticker);
  const card = el('div', 'card position-card');
  const compact = isCompactRegularPosition(position);
  if (compact) card.classList.add('card--mini');
  card.setAttribute('data-rowkey', key);
  card.setAttribute('data-position-id', position.id);
  card.setAttribute('data-card-type', 'regular');
  card.setAttribute('data-ticker', row.ticker || '');
  card.setAttribute('data-instrument-type', resolvedInstrumentType || '');

  const head = el('div', 'row');
  const left = el('div', null, null, { style: 'display:flex;align-items:center;gap:6px' });
  left.appendChild(el('div', null, title || row.ticker || position.id || 'Position', { style: 'font-weight:600;font-size:13px' }));
  head.appendChild(left);

  const right = el('div', null, null, { style: 'display:flex;align-items:center;gap:6px' });
  const statusText = regularPositionStatus(position);
  const status = el('span', `card__status card__status--${statusText || 'draft'}`, statusText);
  status.style.display = statusText ? 'inline-block' : 'none';
  if (compact && statusText !== 'pending-exec') status.textContent = '';
  right.appendChild(status);

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
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
    color: '#6b7280',
    marginLeft: '8px'
  });
  close.title = 'Remove card';
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    requestRemove?.(position);
  });
  if (!compact) right.appendChild(close);
  head.appendChild(right);
  card.appendChild(head);
  if (!compact) card.appendChild(el('div', 'meta', ''));

  let body = null;
  if (isEditableRegularPosition(position)) {
    ensureInstrument(row.ticker, row.provider);
    body = createBody(row, key, resolvedInstrumentType);
    card.appendChild(body.line);
    if (body.extraRow) card.appendChild(body.extraRow);
  }

  const actions = defaultRegularActions(position);
  card._positionActions = actions;
  const btns = el('div', 'btns position-card__actions');
  const rows = Number(getButtonRows()) || 1;
  btns.style.gridTemplateColumns = `repeat(${Math.max(1, Math.ceil(actions.length / rows))},1fr)`;
  for (const action of actions) {
    const label = action.label || action.action;
    const kind = action.action || label;
    const onClick = async () => {
      if (action.command === 'position.remove') {
        await requestRemove?.(position);
        return;
      }
      if (action.command && !['position.open', 'position.openPending'].includes(action.command)) {
        const result = await dispatchPositionAction?.(position, action);
        if (!result || result.status === 'error' || result.status === 'rejected' || result.status === 'unsupported') {
          toast?.(`x ${title || row.ticker || position.id || 'Position'}: ${result?.reason || 'Action failed'}`);
          shakeCard?.(key);
        }
        return;
      }
      if (!body) {
        const result = await dispatchPositionAction?.(position, action);
        if (!result || result.status === 'error' || result.status === 'rejected' || result.status === 'unsupported') {
          toast?.(`x ${title || row.ticker || position.id || 'Position'}: ${result?.reason || 'Action failed'}`);
          shakeCard?.(key);
        }
        return;
      }
      const validated = body.validate();
      if (!validated.valid) return;
      await place(kind, row, validated, resolvedInstrumentType, label);
    };
    const button = typeof createActionButton === 'function'
      ? createActionButton({ label, kind, className: String(action.style || kind).toLowerCase(), onClick })
      : (typeof btn === 'function' ? btn(label, String(action.style || kind).toLowerCase(), onClick) : null);
    if (!button) continue;
    button.dataset.kind = kind;
    btns.appendChild(button);
  }
  if (!compact && actions.length) card.appendChild(btns);
  const note = el('div', 'card__note');
  if (!compact) card.appendChild(note);
  if (body) {
    body.setButtons(btns);
    if (body.setNote) body.setNote(note);
    body.validate();
    card._validate = (commit = false) => body.validate(commit);
  }
  return card;
}

  return {
    createCryptoBody,
    createFxBody,
    createEquitiesBody,
    createBody,
    createLegacyOrderCard,
    buttons,
    registerInstrumentHandler,
    registerCardTypeHandler,
    handlerFor,
    handlerForKey,
    matchesExistingRow,
    titleFor,
    scheduleInstantExecution,
    place,
    regularRowFromPosition,
    createRegularPositionCard,
    instrumentTypeHandlers,
    cardTypeHandlers
  };
}

module.exports = {
  createOrderCardsRenderer
};
