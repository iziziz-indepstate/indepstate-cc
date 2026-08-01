function createInstrumentInfoRenderer({
  ipcRenderer,
  state,
  getInstrumentRefreshMs,
  shouldShowBidAsk,
  shouldShowSpread,
  findTickSizeOverride,
  getDefaultTickSize,
  cardByKey,
  cssEsc,
  getGrid,
  render,
  getRows,
  findRowByTicker,
  revalidateCard,
  setTimeoutFn = setTimeout,
  setIntervalFn = setInterval
} = {}) {
  const instrumentInfo = new Map();
  const pendingInstruments = new Set();
  const spreadHistory = new Map();
  const trackedRows = new Map();

  function instrumentInfoKey(ticker, provider) {
    return `${String(provider || '').trim().toLowerCase()}:${String(ticker || '').trim().toUpperCase()}`;
  }

  function hasUsableQuote(info) {
    return Number.isFinite(Number(info?.bid))
      || Number.isFinite(Number(info?.ask))
      || Number.isFinite(Number(info?.price));
  }

  function storeInstrumentInfo(requestedKey, ticker, info) {
    const flat = flattenInstrumentSnapshot(info);
    if (!flat) return null;
    instrumentInfo.set(requestedKey, flat);
    instrumentInfo.set(String(ticker || '').trim().toUpperCase(), flat);
    if (flat.provider && flat.symbol) {
      instrumentInfo.set(instrumentInfoKey(flat.symbol, flat.provider), flat);
    }
    return flat;
  }

  function allRows() {
    return (getRows() || []).concat(Array.from(trackedRows.values()));
  }

  function trackInstrument(row = {}) {
    const ticker = row.ticker || row.symbol;
    if (!ticker) return false;
    const provider = row.provider;
    trackedRows.set(instrumentInfoKey(ticker, provider), {
      ticker,
      symbol: row.symbol || ticker,
      provider,
      instrumentType: row.instrumentType,
      cardType: row.cardType
    });
    ensureInstrument(ticker, provider);
    return true;
  }

  function untrackInstrument(row = {}) {
    const ticker = row.ticker || row.symbol;
    if (!ticker) return false;
    trackedRows.delete(instrumentInfoKey(ticker, row.provider));
    forgetInstrument(ticker, row.provider);
    return true;
  }

  function instrumentInfoFor(ticker, rowOrProvider) {
    const provider = typeof rowOrProvider === 'object' ? rowOrProvider?.provider : rowOrProvider;
    const inferredProvider = provider || allRows().find(row => row.ticker === ticker)?.provider;
    return instrumentInfo.get(instrumentInfoKey(ticker, inferredProvider)) || instrumentInfo.get(ticker);
  }

  function flattenInstrumentSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    if (!snapshot.quote && !snapshot.metadata) return { ...snapshot, snapshot };
    return {
      ...(snapshot.quote || {}),
      ...(snapshot.metadata || {}),
      provider: snapshot.provider,
      symbol: snapshot.symbol,
      instrumentType: snapshot.instrumentType,
      sources: snapshot.sources || {},
      quoteUpdatedAt: snapshot.quoteUpdatedAt,
      metadataUpdatedAt: snapshot.metadataUpdatedAt,
      snapshot
    };
  }

  function ensureInstrument(ticker, provider) {
    if (!ticker) return;
    if (!allRows().some(r => r.ticker === ticker && r.provider === provider)) return;
    const infoKey = instrumentInfoKey(ticker, provider);
    if (hasUsableQuote(instrumentInfo.get(infoKey))) return;
    if (pendingInstruments.has(infoKey)) return;
    pendingInstruments.add(infoKey);
    ipcRenderer.invoke('instrument:get', { symbol: ticker, provider, forceQuote: true }).then(info => {
      if (info) {
        const flat = storeInstrumentInfo(infoKey, ticker, info);
        updateSpreadForTicker(ticker);
        revalidateCardsForTicker(ticker);
        render();
        if (!hasUsableQuote(flat)) {
          setTimeoutFn(() => {
            pendingInstruments.delete(infoKey);
            ensureInstrument(ticker, provider);
          }, 250);
        } else {
          pendingInstruments.delete(infoKey);
        }
      } else {
        setTimeoutFn(() => {
          pendingInstruments.delete(infoKey);
          ensureInstrument(ticker, provider);
        }, 1000);
      }
    }).catch(() => {
      setTimeoutFn(() => {
        pendingInstruments.delete(infoKey);
        ensureInstrument(ticker, provider);
      }, 1000);
    });
  }

  function forgetInstrument(ticker, provider) {
    if (!ticker) return;
    if (allRows().some(r => r.ticker === ticker && r.provider === provider)) return;
    const infoKey = instrumentInfoKey(ticker, provider);
    instrumentInfo.delete(infoKey);
    pendingInstruments.delete(infoKey);
    ipcRenderer.invoke('instrument:forget', { symbol: ticker, provider }).catch(() => {
    });
  }

  function tickSize(row) {
    const explicit = Number(row?.tickSize);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const info = instrumentInfoFor(row.ticker, row);
    const cached = Number(info?.tickSize);
    if (Number.isFinite(cached) && cached > 0 && String(info?.sources?.tickSize || '').startsWith('adapter:')) return cached;
    const configured = Number(findTickSizeOverride(row.ticker));
    if (Number.isFinite(configured) && configured > 0) return configured;
    if (Number.isFinite(cached) && cached > 0) return cached;
    return getDefaultTickSize();
  }

  function decimalsFromTick(tick) {
    const t = Number(tick);
    if (!Number.isFinite(t) || t <= 0) return 5;
    const s = String(t);
    if (s.includes('e') || s.includes('E')) {
      const m = t.toString();
      const p = m.indexOf('.');
      return p >= 0 ? (m.length - p - 1) : 0;
    }
    const dot = s.indexOf('.');
    return dot >= 0 ? (s.length - dot - 1) : 0;
  }

  function formatPriceValue(info, row) {
    if (!info || typeof info !== 'object') return '';
    const bid = Number(info.bid);
    const ask = Number(info.ask);
    let price = Number(info.price);
    if (!Number.isFinite(price)) {
      if (Number.isFinite(bid) && Number.isFinite(ask)) price = (bid + ask) / 2;
    }
    if (!Number.isFinite(price)) return '';
    const tick = tickSize(row);
    const decimals = Math.min(8, Math.max(0, decimalsFromTick(tick)));
    return price.toFixed(decimals);
  }

  function computeSpreadPts(info, row) {
    if (!info || !Number.isFinite(info.ask) || !Number.isFinite(info.bid)) return NaN;
    const spread = info.ask - info.bid;
    const tick = tickSize(row);
    if (!Number.isFinite(spread) || !Number.isFinite(tick) || tick <= 0) return NaN;
    const pts = spread / tick;
    if (!Number.isFinite(pts)) return NaN;
    return Math.max(0, Math.round(pts));
  }

  function formatBidAskText(info, row) {
    if (!info || typeof info !== 'object') return '';
    const bid = Number(info.bid);
    const ask = Number(info.ask);
    if (!Number.isFinite(bid) && !Number.isFinite(ask)) return '';
    const tick = tickSize(row);
    const decimals = Math.min(8, Math.max(0, decimalsFromTick(tick)));
    const b = Number.isFinite(bid) ? bid.toFixed(decimals) : '-';
    const a = Number.isFinite(ask) ? ask.toFixed(decimals) : '-';
    return `${b} / ${a}`;
  }

  function calcAvg(arr, n) {
    const len = Array.isArray(arr) ? arr.length : 0;
    if (!len) return NaN;
    const k = Math.max(1, Math.min(n, len));
    let sum = 0;
    for (let i = len - k; i < len; i++) sum += arr[i];
    return Math.round(sum / k);
  }

  function formatSpreadTriple(ticker, row, curPtsOverride) {
    const info = instrumentInfoFor(ticker, row);
    const cur = Number.isFinite(curPtsOverride) ? curPtsOverride : computeSpreadPts(info, row);
    if (!Number.isFinite(cur)) return '';
    const hist = spreadHistory.get(ticker) || [];
    const avg10 = Number.isFinite(calcAvg(hist, 10)) ? calcAvg(hist, 10) : cur;
    const avg100 = Number.isFinite(calcAvg(hist, 100)) ? calcAvg(hist, 100) : (Number.isFinite(avg10) ? avg10 : cur);
    return `${cur}/${avg10}/${avg100}`;
  }

  function updateSpreadForTicker(ticker) {
    if (!ticker) return;
    const info = instrumentInfoFor(ticker);
    const row = findRowByTicker(ticker) || allRows().find(r => r.ticker === ticker);
    if (!row) return;

    let curPts;
    if (shouldShowSpread()) {
      curPts = computeSpreadPts(info, row);
      if (Number.isFinite(curPts)) {
        const arr = spreadHistory.get(ticker) || [];
        arr.push(curPts);
        if (arr.length > 100) arr.splice(0, arr.length - 100);
        spreadHistory.set(ticker, arr);
      }
    }

    const cards = getGrid().querySelectorAll(`.card[data-ticker="${cssEsc(ticker)}"]`);
    cards.forEach(card => {
      if (shouldShowBidAsk()) {
        const ba = card.querySelector('.card__bidask');
        if (ba) ba.textContent = formatBidAskText(info, row) || '';
      }
      if (shouldShowSpread()) {
        const sp = card.querySelector('.card__spread');
        if (sp) sp.textContent = formatSpreadTriple(ticker, row, curPts) || '';
      }
    });
  }

  function revalidateCardsForTicker(ticker) {
    if (!ticker) return;
    const cards = getGrid().querySelectorAll(`.card[data-ticker="${cssEsc(ticker)}"]`);
    cards.forEach(card => revalidateCard(card));
  }

  function startPeriodicRefresh() {
    const timer = setIntervalFn(async () => {
      if (startPeriodicRefresh.running) return;
      startPeriodicRefresh.running = true;
      try {
        const instruments = Array.from(new Map(allRows()
          .filter(r => r.ticker)
          .map(r => [instrumentInfoKey(r.ticker, r.provider), { ticker: r.ticker, provider: r.provider }])).values());
        if (!instruments.length) return;

        await Promise.all(instruments.map(async ({ ticker: t, provider }) => {
          const row = allRows().find(r => r.ticker === t && r.provider === provider);
          if (!row) return;
          const infoKey = instrumentInfoKey(t, provider);
          if (pendingInstruments.has(infoKey)) return;

          pendingInstruments.add(infoKey);
          try {
            const info = await ipcRenderer.invoke('instrument:get', { symbol: t, provider, forceQuote: true });
            if (info) {
              storeInstrumentInfo(infoKey, t, info);
              updateSpreadForTicker(t);
              revalidateCardsForTicker(t);
            }
          } catch {
          } finally {
            pendingInstruments.delete(infoKey);
          }
        }));
      } finally {
        startPeriodicRefresh.running = false;
      }
    }, getInstrumentRefreshMs());
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  return {
    instrumentInfo,
    pendingInstruments,
    spreadHistory,
    trackedRows,
    instrumentInfoKey,
    trackInstrument,
    untrackInstrument,
    instrumentInfoFor,
    flattenInstrumentSnapshot,
    ensureInstrument,
    forgetInstrument,
    tickSize,
    decimalsFromTick,
    formatPriceValue,
    computeSpreadPts,
    formatBidAskText,
    formatSpreadTriple,
    updateSpreadForTicker,
    revalidateCardsForTicker,
    startPeriodicRefresh
  };
}

module.exports = {
  createInstrumentInfoRenderer
};
