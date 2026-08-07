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
  placedOrderByKey,
  ticketToKey,
  cardStates,
  cardByKey,
  setCardState,
  pendingActionInfo,
  emitOptionStratButtonEvent,
  toast,
  shakeCard,
  render,
  now = () => Date.now(),
  random = () => Math.random()
} = {}) {
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



async function place(kind, row, v, instrumentType, btnLabel) {
  if (!v.valid) return;

  const key = rowKey(row);
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
  if (v.type === 'option') {
    qtyVal = 1;
    priceVal = 1;
    slVal = 1;
    takeVal = null;
    tick = 0.01;
  } else if (v.type === 'crypto') {
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

  let res;
  try {
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
      if (v.type === 'option') {
        const payload = {
          ticker: row.ticker,
          symbol: row.symbol || row.ticker,
          root: row.root,
          provider: row.provider,
          instrumentType: 'OPT',
          event: row.event,
          time: row.time,
          cardType: row.cardType || 'option',
          name: row.name,
          description: row.description,
          expirationDte: row.expirationDte,
          isCustomName: row.isCustomName,
          isCashSecured: row.isCashSecured,
          legs: row.legs,
          side: 'OPEN',
          meta: baseMeta,
        };
        emitOptionStratButtonEvent('open', row);
        res = await ipcRenderer.invoke('queue-place-order', payload);
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
      if (v.type === 'option' && res.providerOrderId) {
        const openedAt = now();
        pendingByReqId.delete(requestId);
        pendingIdByReqId.delete(requestId);
        retryCounts.delete(requestId);
        placedOrderByKey.set(key, {
          provider: res.provider || row.provider || 'optionstrat',
          ticket: String(res.providerOrderId),
          symbol: row.symbol || row.ticker || '',
          strategyCommand: row.strategyCommand,
          name: row.name,
          payoff: res.payoff || res.raw?.payoff,
          valuation: res.valuation || res.raw?.valuation,
          openedAt
        });
        if (res.payoff || res.raw?.payoff) row.payoff = res.payoff || res.raw.payoff;
        if (res.valuation || res.raw?.valuation) row.valuation = res.valuation || res.raw.valuation;
        row.openedAt = row.openedAt || openedAt;
        ticketToKey.set(String(res.providerOrderId), key);
        setCardState(key, 'placed');
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

  return {
    createCryptoBody,
    createFxBody,
    createEquitiesBody,
    place
  };
}

module.exports = {
  createOrderCardsRenderer
};
