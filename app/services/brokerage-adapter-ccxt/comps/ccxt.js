// services/brokerage-adapter-ccxt/comps/ccxt.js
const { ExecutionAdapter } = require('../../brokerage/comps/base');
const ccxt = require('ccxt');
const crypto = require('crypto');
const events = require('../../events');
const orderCalc = require('../../orderCalculator');

function positiveFiniteNumber(value) {
  if (value == null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function firstPositiveFiniteNumber(...values) {
  for (const value of values) {
    const number = positiveFiniteNumber(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

class CCXTExecutionAdapter extends ExecutionAdapter {
  /**
   * @param {Object} cfg
   * @param {string} cfg.exchangeId - ідентифікатор біржі з ccxt, наприклад 'binance', 'bybit', 'okx'
   * @param {string} [cfg.apiKey]
   * @param {string} [cfg.secret]
   * @param {string} [cfg.password] - для деяких бірж
   * @param {string} [cfg.uid] - для деяких бірж
   * @param {boolean} [cfg.sandbox=false] - режим пісочниці, якщо підтримується
   * @param {boolean} [cfg.enableRateLimit=true]
   * @param {Object} [cfg.options] - додаткові опції ccxt
   * @param {Object} [cfg.params] - дефолтні params для запитів
   * @param {Object<string,string>} [cfg.symbolMap] - мапінг локальних символів до формату ccxt (наприклад {'BTCUSDT':'BTC/USDT'})
   */
  constructor(cfg = {}) {
    super();
    if (!cfg.exchangeId || !ccxt[cfg.exchangeId]) {
      throw new Error(`CCXT: unknown or missing exchangeId: ${cfg.exchangeId || '(empty)'}`);
    }
    this.exchangeId = cfg.exchangeId;
    this.provider = `ccxt:${this.exchangeId}`;
    this.symbolMap = cfg.symbolMap || {};
    const ExchangeClass = ccxt[this.exchangeId];

    this.exchange = new ExchangeClass({
      apiKey: cfg.apiKey,
      secret: cfg.secret,
      password: cfg.password,
      uid: cfg.uid,
      enableRateLimit: cfg.enableRateLimit !== false,
      options: cfg.options || {},
    });

    if (cfg.sandbox) {
      if (typeof this.exchange.enableDemoTrading === 'function') {
        this.exchange.enableDemoTrading(true)
      } else if (typeof this.exchange.setSandboxMode === 'function') {
        this.exchange.setSandboxMode(true);
      } else {
        throw new Error(`CCXT: unable to set demo/sandbox mode for exchange: ${cfg.exchangeId || '(empty)'}, please consult with documentation`);
      }
    }

    this.defaultParams = cfg.params || {};
    // Автопобудова мапи символів з біржі (можна вимкнути через cfg.autoBuildSymbolMap=false)
    this.autoBuildSymbolMap = cfg.autoBuildSymbolMap !== false;
    this._marketsLoaded = false;
    this._readyPromise = null;

    // Зв'язки батьківського ордера з дочірніми (SL/TP) та вотчери для скасування
    this._childOrdersByParent = new Map(); // parentId -> { symbol, children: string[] }
    this._parentWatchers = new Map(); // parentId -> NodeJS.Timer

    // Pending та події підтвердження/відхилення (для UI)
    this.events = new (require('events').EventEmitter)();
    this.pending = new Map(); // cid -> { order, createdAt }

    // Трекінг позицій/замовлень для подій як у DWX
    this._ticketToSymbol = new Map(); // ticket(providerOrderId) -> mappedSymbol
    this._ticketOpened = new Set();   // ticket -> boolean (позиція відкрита)
    this._positionClosedTickets = new Set(); // ticket -> terminal close event already emitted
    this.watchIntervalMs = Number.isFinite(cfg.watchIntervalMs) ? cfg.watchIntervalMs : 2000;
    this._watchTimer = null;
    this._startWatchLoop();

    // Бар-стріми: спочатку websocket (watchOHLCV), з фолбеком на polling fetchOHLCV.
    this.barPollIntervalMs = Number.isFinite(cfg.barPollIntervalMs) ? cfg.barPollIntervalMs : 5000;
    this.barWatchFailuresLimit = Number.isFinite(cfg.barWatchFailuresLimit) ? cfg.barWatchFailuresLimit : 3;
    this._barSubscriptions = new Map(); // key: originalSymbol::timeframe -> { originalSymbol, mappedSymbol, timeframe }
    this._barLastTs = new Map(); // key: originalSymbol::timeframe -> last bar timestamp
    this._barTasks = new Map(); // key -> { stop, mode, failures, timer }
    this.client = {
      subscribe_symbols_bar_data: this.subscribe_symbols_bar_data.bind(this),
      unsubscribe_symbols_bar_data: this.unsubscribe_symbols_bar_data.bind(this)
    };

    // Кеш котирувань: per-symbol watchTicker/fetchTicker
    this.tickerPollIntervalMs = Number.isFinite(cfg.tickerPollIntervalMs) ? cfg.tickerPollIntervalMs : 5000;
    this.tickerWatchFailuresLimit = Number.isFinite(cfg.tickerWatchFailuresLimit) ? cfg.tickerWatchFailuresLimit : 3;
    this._tickerCache = new Map(); // mappedSymbol -> { bid, ask, price, tickSize }
    this._tickerWatchTasks = new Map(); // mappedSymbol -> { stop, mode, failures, timer }

    // Конфіг бажаних SL/TP по тікету (щоб забезпечити та відновлювати SL/TP після фактичного входу)
    this._desiredProtectionByTicket = new Map(); // ticket -> { symbol, side, amount, slPts, tpPts, tickSize }

    this._brackets = new Map();
    this._entryClientToBracket = new Map();
    this._algoClientToBracket = new Map();
    this._bracketEntryWatchers = new Map();
    this.protectiveOrders = {
      manualModificationStrategy: ['adopt', 'stop-managing'].includes(String(cfg.protectiveOrders?.manualModificationStrategy || '').toLowerCase())
        ? String(cfg.protectiveOrders.manualModificationStrategy).toLowerCase()
        : 'adopt'
    };
    this._reconcileTimer = setInterval(() => { this._reconcileBrackets().catch(() => {}); }, Math.max(5000, Number(cfg.bracketReconcileMs) || 10000));

    // Binance USDⓈ-M REST helpers
    this._binanceTimeOffsetMs = 0;
    this._binanceTimeOffsetUpdatedAt = 0;
    this._binanceExchangeInfoCache = null;
    this._binanceExchangeInfoLoadedAt = 0;
    this._binanceExchangeInfoPromise = null;
    this._binanceMetadataBySymbol = new Map();

    // Автоматичне забезпечення/скасування SL/TP по подіях позицій
    this.on('position:opened', async ({ ticket }) => {
      try { await this._ensureProtectiveOrdersForTicket(ticket); } catch {}
    });
    this.on('position:closed', async ({ ticket }) => {
      try { await this._cancelAllProtectionForTicket(ticket); } catch {}
    });
  }

  async ensureReady() {
    if (this._marketsLoaded) return;
    if (!this._readyPromise) {
      this._readyPromise = (async () => {
        try {
          const markets = await this.exchange.loadMarkets();
          if (this.autoBuildSymbolMap) this._buildSymbolMapFromMarkets(markets);
          if (typeof this.exchange.loadTimeDifference === 'function') {
            try { await this.exchange.loadTimeDifference(); } catch {}
          }
        } finally {
          this._marketsLoaded = true;
        }
      })();
    }
    return this._readyPromise;
  }

  async _binancePublicRequest(path, params = {}) {
    const baseUrl = 'https://fapi.binance.com';
    const query = Object.entries(params || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const url = `${baseUrl}${path}${query ? `?${query}` : ''}`;
    const res = await fetch(url, { method: 'GET' });
    const txt = await res.text();
    let json;
    try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
    if (!res.ok) throw new Error(`binance ${JSON.stringify(json)}`);
    return json;
  }

  async _syncBinanceServerTime(force = false) {
    const now = Date.now();
    if (!force && now - this._binanceTimeOffsetUpdatedAt < 30000) return this._binanceTimeOffsetMs;
    const json = await this._binancePublicRequest('/fapi/v1/time');
    const serverTime = Number(json?.serverTime);
    if (Number.isFinite(serverTime)) {
      this._binanceTimeOffsetMs = serverTime - Date.now();
      this._binanceTimeOffsetUpdatedAt = Date.now();
    }
    return this._binanceTimeOffsetMs;
  }

  async _binanceSignedRequest(method, path, params = {}) {
    const apiKey = this.exchange?.apiKey;
    const secret = this.exchange?.secret;
    if (!apiKey || !secret) throw new Error('Binance API key/secret are required');
    const baseUrl = 'https://fapi.binance.com';
    await this._syncBinanceServerTime();
    const payload = { ...params, recvWindow: 5000, timestamp: Date.now() + this._binanceTimeOffsetMs };
    const query = Object.entries(payload)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const signature = crypto.createHmac('sha256', secret).update(query).digest('hex');
    const total = `${query}&signature=${signature}`;
    const url = `${baseUrl}${path}${method === 'GET' || method === 'DELETE' ? `?${total}` : ''}`;
    const res = await fetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: method === 'GET' || method === 'DELETE' ? undefined : total
    });
    const txt = await res.text();
    let json;
    try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
    if (!res.ok) throw new Error(`binance ${JSON.stringify(json)}`);
    return json;
  }



  _roundToStep(value, step, mode = 'round') {
    const v = Number(value); const st = Number(step);
    if (!Number.isFinite(v) || !Number.isFinite(st) || st <= 0) return v;
    const n = v / st;
    const r = mode === 'floor' ? Math.floor(n) : mode === 'ceil' ? Math.ceil(n) : Math.round(n);
    return Number((r * st).toFixed(12));
  }

  async _getBinanceSymbolFilters(symbol) {
    const info = await this._getBinanceExchangeInfo();
    const key = String(symbol || '').toUpperCase();
    if (this._binanceMetadataBySymbol?.has(key)) return this._binanceMetadataBySymbol.get(key);
    const row = (info?.symbols || []).find((s) => String(s?.symbol || '').toUpperCase() === key);
    if (!row) throw new Error(`Symbol ${symbol} not found in exchangeInfo`);
    const metadata = this._parseBinanceSymbolMetadata(row);
    if (!this._binanceMetadataBySymbol) this._binanceMetadataBySymbol = new Map();
    this._binanceMetadataBySymbol.set(key, metadata);
    return metadata;
  }

  _parseBinanceSymbolMetadata(row) {
    const filters = row.filters || [];
    const pf = filters.find((f) => f.filterType === 'PRICE_FILTER') || {};
    const lf = filters.find((f) => f.filterType === 'LOT_SIZE') || {};
    const mn = filters.find((f) => f.filterType === 'MIN_NOTIONAL') || {};
    return {
      tickSize: Number(pf.tickSize || 0),
      stepSize: Number(lf.stepSize || 0),
      minQty: Number(lf.minQty || 0),
      maxQty: Number(lf.maxQty || 0),
      minNotional: Number(mn.notional || mn.minNotional || 0)
    };
  }

  _cacheBinanceInstrumentMetadata(info) {
    const next = new Map();
    for (const row of info?.symbols || []) {
      const key = String(row?.symbol || '').toUpperCase();
      if (key) next.set(key, this._parseBinanceSymbolMetadata(row));
    }
    this._binanceMetadataBySymbol = next;
    return next;
  }

  async _waitBinanceOrderFilled(symbol, clientOrderId, timeoutMs = 120000) {
    return this._fetchEntryStatusOnce(symbol, clientOrderId);
  }


  async _fetchEntryStatusOnce(symbol, entryClientOrderId) {
    return this._binanceSignedRequest('GET', '/fapi/v1/order', { symbol, origClientOrderId: entryClientOrderId });
  }
  _buildSymbolMapFromMarkets(markets) {
    try {
      const list = Array.isArray(markets) ? markets : Object.values(markets || {});
      for (const m of list) {
        if (!m) continue;
        const ccxtSymbol = m.symbol || '';
        const base = String(m.base || '').toUpperCase();
        const quote = String(m.quote || '').toUpperCase();
        const id = String(m.id || '');
        const idKey = id.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

        const add = (k) => {
          if (!k) return;
          if (!this.symbolMap[k]) this.symbolMap[k] = ccxtSymbol;
          const up = k.toUpperCase();
          if (!this.symbolMap[up]) this.symbolMap[up] = ccxtSymbol;
        };

        // Канонічний ключ, наприклад BTCUSDT
        if (base && quote) {
          const k = (base + quote).toUpperCase();
          add(k);
          // Поширені аліаси для ф'ючерсів/свопів
          if (m.contract || m.swap || m.future) {
            add(`${k}.P`);
            add(`${k}-PERP`);
            add(`${k}_PERP`);
          }
        }
        // Додаємо нормалізований id
        if (idKey) add(idKey);
      }
    } catch {}
  }

  subscribe_symbols_bar_data(symbols = []) {
    if (!Array.isArray(symbols)) return;
    for (const entry of symbols) {
      const [symbol, timeframe] = Array.isArray(entry) ? entry : [];
      if (!symbol || !timeframe) continue;
      const originalSymbol = String(symbol);
      const tf = String(timeframe);
      const mappedSymbol = this.mapSymbol(originalSymbol);
      const key = `${originalSymbol}::${tf}`;
      this._barSubscriptions.set(key, { originalSymbol, mappedSymbol, timeframe: tf });
    }
    this._startBarPolling();
  }

  unsubscribe_symbols_bar_data(symbols = []) {
    if (!Array.isArray(symbols)) return;
    for (const entry of symbols) {
      const [symbol, timeframe] = Array.isArray(entry) ? entry : [];
      if (!symbol || !timeframe) continue;
      const originalSymbol = String(symbol);
      const tf = String(timeframe);
      const key = `${originalSymbol}::${tf}`;
      this._barSubscriptions.delete(key);
      this._stopBarTask(key);
    }
  }

  _normalizeTimeframe(timeframe) {
    const raw = String(timeframe || '').trim();
    if (!raw) return '';
    if (this.exchange?.timeframes) {
      if (this.exchange.timeframes[raw]) return raw;
      const lower = raw.toLowerCase();
      if (this.exchange.timeframes[lower]) return lower;
      const upper = raw.toUpperCase();
      if (this.exchange.timeframes[upper]) return upper;
    }
    const upper = raw.toUpperCase();
    const mapping = {
      M1: '1m',
      M5: '5m',
      M15: '15m',
      M30: '30m',
      H1: '1h',
      H4: '4h',
      D1: '1d',
      W1: '1w'
    };
    if (mapping[upper]) return mapping[upper];
    return raw;
  }

  _supportsWatchOHLCV() {
    return !!(this.exchange?.has?.watchOHLCV && typeof this.exchange.watchOHLCV === 'function');
  }

  _supportsWatchTicker() {
    return !!(this.exchange?.has?.watchTicker && typeof this.exchange.watchTicker === 'function');
  }

  _startBarPolling() {
    for (const key of this._barSubscriptions.keys()) {
      this._ensureBarTask(key);
    }
    for (const key of this._barTasks.keys()) {
      if (!this._barSubscriptions.has(key)) {
        this._stopBarTask(key);
      }
    }
  }

  _ensureTickerTask(mappedSymbol) {
    if (!mappedSymbol || this._tickerWatchTasks.has(mappedSymbol)) return;
    const task = {
      mode: this._supportsWatchTicker() ? 'watch' : 'poll',
      failures: 0,
      timer: null,
      active: true,
      stop: () => {
        task.active = false;
        if (task.timer) clearInterval(task.timer);
        task.timer = null;
      }
    };
    this._tickerWatchTasks.set(mappedSymbol, task);
    if (task.mode === 'watch') {
      this._startTickerWatchLoop(mappedSymbol, task);
    } else {
      this._startTickerPollLoop(mappedSymbol, task);
    }
  }

  _stopTickerTask(mappedSymbol) {
    const task = this._tickerWatchTasks.get(mappedSymbol);
    if (!task) return;
    try { task.stop?.(); } catch {}
    this._tickerWatchTasks.delete(mappedSymbol);
  }

  async _startTickerWatchLoop(mappedSymbol, task) {
    const backoffMs = 500;
    const notifyFailures = () => {
      try {
        events.emit('ticker:watch_failed', {
          provider: this.provider,
          symbol: mappedSymbol,
          failures: task.failures
        });
      } catch {}
    };
    while (task.active) {
      try {
        await this.ensureReady();
      } catch {
        task.failures += 1;
        if (task.failures >= this.tickerWatchFailuresLimit) {
          notifyFailures();
          task.failures = 0;
        }
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
      try {
        const t = await this.exchange.watchTicker(mappedSymbol);
        task.failures = 0;
        if (!this._isTickerTaskActive(mappedSymbol, task)) continue;
        await this._updateTickerCache(mappedSymbol, t, true);
      } catch {
        task.failures += 1;
        if (task.failures >= this.tickerWatchFailuresLimit) {
          notifyFailures();
          task.failures = 0;
        }
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }

  _startTickerPollLoop(mappedSymbol, task) {
    if (!task.active) return;
    const interval = Math.max(1000, this.tickerPollIntervalMs);
    const pollOnce = () => {
      this._pollTickerOnce(mappedSymbol, task).catch(() => {});
    };
    task.timer = setInterval(pollOnce, interval);
    pollOnce();
  }

  _isTickerTaskActive(mappedSymbol, task) {
    return task?.active && this._tickerWatchTasks.get(mappedSymbol) === task;
  }

  async _pollTickerOnce(mappedSymbol, task) {
    if (!mappedSymbol || typeof this.exchange.fetchTicker !== 'function') return;
    try {
      await this.ensureReady();
    } catch {
      return;
    }
    let t;
    try {
      t = await this.exchange.fetchTicker(mappedSymbol);
    } catch {
      return;
    }
    if (!this._isTickerTaskActive(mappedSymbol, task)) return;
    await this._updateTickerCache(mappedSymbol, t, true);
  }

  _ensureBarTask(key) {
    if (this._barTasks.has(key)) return;
    const task = {
      mode: this._supportsWatchOHLCV() ? 'watch' : 'poll',
      failures: 0,
      timer: null,
      active: true,
      stop: () => {
        task.active = false;
        if (task.timer) clearInterval(task.timer);
        task.timer = null;
      }
    };
    this._barTasks.set(key, task);
    if (task.mode === 'watch') {
      this._startBarWatchLoop(key, task);
    } else {
      this._startBarPollLoop(key, task);
    }
  }

  _stopBarTask(key) {
    const task = this._barTasks.get(key);
    if (!task) return;
    try { task.stop?.(); } catch {}
    this._barTasks.delete(key);
    this._barLastTs.delete(key);
  }

  async _startBarWatchLoop(key, task) {
    const backoffMs = 500;
    const notifyFailures = (sub) => {
      try {
        events.emit('bar:watch_failed', {
          provider: this.provider,
          symbol: sub?.originalSymbol,
          timeframe: sub?.timeframe,
          failures: task.failures
        });
      } catch {}
    };
    while (task.active) {
      const sub = this._barSubscriptions.get(key);
      if (!sub) break;
      try {
        await this.ensureReady();
      } catch {
        task.failures += 1;
        if (task.failures >= this.barWatchFailuresLimit) {
          notifyFailures(sub);
          task.failures = 0;
        }
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
      const refreshedSymbol = this.mapSymbol(sub.originalSymbol);
      if (!refreshedSymbol) {
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
      if (refreshedSymbol !== sub.mappedSymbol) {
        this._barSubscriptions.set(key, { ...sub, mappedSymbol: refreshedSymbol });
      }
      const normalizedTimeframe = this._normalizeTimeframe(sub.timeframe);
      if (!normalizedTimeframe) {
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
      try {
        const bars = await this.exchange.watchOHLCV(refreshedSymbol, normalizedTimeframe);
        task.failures = 0;
        const last = Array.isArray(bars) ? bars[bars.length - 1] : null;
        if (last) this._emitBarFromCandle(key, sub, last);
      } catch {
        task.failures += 1;
        if (task.failures >= this.barWatchFailuresLimit) {
          notifyFailures(sub);
          task.failures = 0;
        }
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }

  _startBarPollLoop(key, task) {
    if (!task.active) return;
    const interval = Math.max(1000, this.barPollIntervalMs);
    const pollOnce = () => {
      this._pollBarsOnce(key).catch(() => {});
    };
    task.timer = setInterval(pollOnce, interval);
    pollOnce();
  }

  async _pollBarsOnce(key) {
    if (!key) return;
    const sub = this._barSubscriptions.get(key);
    if (!sub) return;
    try {
      await this.ensureReady();
    } catch {
      return;
    }
    const { originalSymbol, mappedSymbol, timeframe } = sub;
    const refreshedSymbol = this.mapSymbol(originalSymbol);
    if (!refreshedSymbol || !timeframe) return;
    if (refreshedSymbol !== mappedSymbol) {
      this._barSubscriptions.set(key, { ...sub, mappedSymbol: refreshedSymbol });
    }
    const normalizedTimeframe = this._normalizeTimeframe(timeframe);
    if (!normalizedTimeframe) return;
    let bars;
    try {
      bars = await this.exchange.fetchOHLCV(refreshedSymbol, normalizedTimeframe);
    } catch {
      return;
    }
    if (!Array.isArray(bars) || bars.length === 0) return;
    const last = bars[bars.length - 1];
    if (last) this._emitBarFromCandle(key, sub, last);
  }

  _emitBarFromCandle(key, sub, candle) {
    if (!Array.isArray(candle) || candle.length < 5) return;
    const time = Number(candle[0]);
    if (!Number.isFinite(time)) return;
    const lastTs = this._barLastTs.get(key);
    //skip bars from the past but do not skip updatesK
    if (Number.isFinite(lastTs) && time < lastTs) return;
    this._barLastTs.set(key, time);
    const open = Number(candle[1]);
    const high = Number(candle[2]);
    const low = Number(candle[3]);
    const close = Number(candle[4]);
    const vol = Number(candle[5]);
    try {
      events.emit('bar', {
        provider: this.provider,
        symbol: sub.originalSymbol,
        tf: sub.timeframe,
        time,
        open,
        high,
        low,
        close,
        vol
      });
    } catch {}
  }

  async shutdown() {
    for (const key of this._barTasks.keys()) {
      this._stopBarTask(key);
    }
    for (const mappedSymbol of this._tickerWatchTasks.keys()) {
      this._stopTickerTask(mappedSymbol);
    }
    this._tickerCache.clear();
    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }
    try {
      if (typeof this.exchange?.close === 'function') {
        await this.exchange.close();
      }
    } catch {}
  }

  _getTickSizeFromMarket(mappedSymbol) {
    try {
      const m = (this.exchange.markets && this.exchange.markets[mappedSymbol]) || this.exchange.market(mappedSymbol);
      if (!m) return undefined;

      // 1) За precision.price
      const p = m?.precision?.price;
      if (Number.isInteger(p) && p >= 0 && p <= 18) {
        const ts = Math.pow(10, -p);
        // console.log(`[${this.provider}] Using precision.price=${p} for ${mappedSymbol}:`, ts);
        if (Number.isFinite(ts) && ts > 0) return ts;
      }

      // 2) Уніфіковане tickSize (деякі біржі надають)
      if (Number.isFinite(m?.tickSize) && m.tickSize > 0)  {
        // console.log(`[${this.provider}] Using tickSize=${m.tickSize} for ${mappedSymbol}:`, m.tickSize);
        return Number(m.tickSize);
      }


      // // 3) limits.price.step (інколи відповідає мін. кроку)
      // const step = m?.limits?.price?.min;
      // if (Number.isFinite(step) && step > 0) {
      //   console.log(`[${this.provider}] Using price.step=${step} for ${mappedSymbol}:`, step);
      //   return Number(step);
      // }

      // 4) Біржові "info"
      const info = m.info || {};
      // Binance
      if (Array.isArray(info.filters)) {
        const pf = info.filters.find(f => String(f.filterType).toUpperCase() === 'PRICE_FILTER');
        const ts = pf && parseFloat(pf.tickSize);
        if (Number.isFinite(ts) && ts > 0) {
          // console.log(`[${this.provider}] Using price.filter.tickSize=${ts} for ${mappedSymbol}:`, ts);
          return ts;
        }
      }
      // Bybit
      const bbTs = parseFloat(info?.priceFilter?.tickSize || info?.priceFilter?.tick_size);
      if (Number.isFinite(bbTs) && bbTs > 0) return bbTs;
      // OKX
      const okxTs = parseFloat(info?.tickSz || info?.tickSize);
      if (Number.isFinite(okxTs) && okxTs > 0) return okxTs;

      return undefined;
    } catch {
      return undefined;
    }
  }

  mapSymbol(symbol) {
    if (!symbol) return symbol;
    return this.symbolMap[symbol] || this.symbolMap[String(symbol).toUpperCase()] || symbol;
  }

  async _getBinanceExchangeInfo() {
    const now = Date.now();
    if (this._binanceExchangeInfoCache && now - this._binanceExchangeInfoLoadedAt < 5 * 60 * 1000) {
      return this._binanceExchangeInfoCache;
    }
    if (this._binanceExchangeInfoPromise) return this._binanceExchangeInfoPromise;
    this._binanceExchangeInfoPromise = this._binancePublicRequest('/fapi/v1/exchangeInfo')
      .then(info => {
        this._binanceExchangeInfoCache = info;
        this._binanceExchangeInfoLoadedAt = Date.now();
        this._cacheBinanceInstrumentMetadata(info);
        return info;
      })
      .finally(() => {
        this._binanceExchangeInfoPromise = null;
      });
    return this._binanceExchangeInfoPromise;
  }

  async preloadInstrumentMetadata() {
    if (!this._isBinanceUsdmLike()) return null;
    await this._getBinanceExchangeInfo();
    return { symbols: this._binanceMetadataBySymbol.size };
  }

  async normalizeBinanceUsdmSymbol(input) {
    const symbolInput = String(input || '').trim();
    let normalized = symbolInput.toUpperCase();
    if (normalized.endsWith('.P')) normalized = normalized.slice(0, -2);
    if (normalized.includes(':')) {
      const pair = normalized.split(':')[0];
      const [base, quote] = pair.split('/');
      if (base && quote) normalized = `${base}${quote}`;
    } else if (normalized.includes('/')) {
      normalized = normalized.replace('/', '');
    }
    normalized = normalized.replace(/[^A-Z0-9]/g, '');

    const info = await this._getBinanceExchangeInfo();
    const exists = Array.isArray(info?.symbols) && info.symbols.some((s) => String(s?.symbol || '').toUpperCase() === normalized);
    if (!exists) {
      throw new Error(`Invalid futures symbol: ${symbolInput} normalized to ${normalized} but not found in exchangeInfo`);
    }
    return normalized;
  }


  _isBinanceUsdmLike() {
    const id = String(this.exchangeId || '').toLowerCase();
    return id === 'binance' || id === 'binanceusdm' || id === 'binance-futures' || id === 'binancefutures';
  }

  _binanceQuoteTypeToEndpoint(quoteType = 'book') {
    if (quoteType === 'last') return '/fapi/v2/ticker/price';
    if (quoteType === 'mark') return '/fapi/v1/premiumIndex';
    if (quoteType === 'book' || quoteType === 'execution') return '/fapi/v1/ticker/bookTicker';
    return undefined;
  }

  /**
   * Get the native exchange symbol (e.g., 'ETHUSDT' for Binance) from a CCXT mapped symbol ('ETH/USDT:USDT').
   * @param {string} mappedSymbol
   * @returns {string}
   */
  getNativeSymbol(mappedSymbol) {
    try {
      if (!mappedSymbol) return mappedSymbol;
      if (this.exchange.markets && this.exchange.markets[mappedSymbol]) {
        return this.exchange.markets[mappedSymbol].id || mappedSymbol;
      }
      const market = this.exchange.market(mappedSymbol);
      return market?.id || mappedSymbol;
    } catch {
      return mappedSymbol;
    }
  }


  async _getBinanceTickSizeForQuote(symbolOrMappedSymbol) {
    if (!this._isBinanceUsdmLike()) return undefined;
    try {
      const nativeSymbol = await this.normalizeBinanceUsdmSymbol(symbolOrMappedSymbol);
      const filters = await this._getBinanceSymbolFilters(nativeSymbol);
      const tick = Number(filters?.tickSize);
      return Number.isFinite(tick) && tick > 0 ? tick : undefined;
    } catch {
      return undefined;
    }
  }

  async _resolveQuoteTickSize(mappedSymbol, originalSymbol) {
    if (this._isBinanceUsdmLike()) {
      const binanceTick = await this._getBinanceTickSizeForQuote(originalSymbol || mappedSymbol);
      if (Number.isFinite(binanceTick) && binanceTick > 0) return binanceTick;
    }

    const marketTick = this._getTickSizeFromMarket(mappedSymbol);
    if (Number.isFinite(marketTick) && marketTick > 0) return marketTick;

    return undefined;
  }

  async _updateTickerCache(mappedSymbol, ticker, allowOrderBookFallback) {
    if (!mappedSymbol || !ticker) return;
    const quote = await this._parseQuoteFromTicker(mappedSymbol, ticker, allowOrderBookFallback, mappedSymbol);
    if (!quote) return;
    this._tickerCache.set(mappedSymbol, quote);
  }

  async _parseQuoteFromTicker(mappedSymbol, t, allowOrderBookFallback = true, originalSymbol) {
    if (!t) return null;
    // Надійне діставання bid/ask: спочатку з уніфікованих полів, далі з info, і як fallback — orderbook
    let bid = Number.isFinite(t.bid) ? Number(t.bid)
      : (t.info && Number.isFinite(Number(t.info.bidPrice)) ? Number(t.info.bidPrice)
        : (t.info && Number.isFinite(Number(t.info.bestBid)) ? Number(t.info.bestBid)
          : (t.info && Number.isFinite(Number(t.info.b)) ? Number(t.info.b) : undefined)));

    let ask = Number.isFinite(t.ask) ? Number(t.ask)
      : (t.info && Number.isFinite(Number(t.info.askPrice)) ? Number(t.info.askPrice)
        : (t.info && Number.isFinite(Number(t.info.bestAsk)) ? Number(t.info.bestAsk)
          : (t.info && Number.isFinite(Number(t.info.a)) ? Number(t.info.a) : undefined)));

    if (allowOrderBookFallback && (!Number.isFinite(bid) || !Number.isFinite(ask)) && typeof this.exchange.fetchOrderBook === 'function') {
      try {
        const ob = await this.exchange.fetchOrderBook(mappedSymbol, 5);
        if (!Number.isFinite(bid) && Array.isArray(ob?.bids) && ob.bids.length) {
          const v = Number(ob.bids[0][0]);
          if (Number.isFinite(v)) bid = v;
        }
        if (!Number.isFinite(ask) && Array.isArray(ob?.asks) && ob.asks.length) {
          const v = Number(ob.asks[0][0]);
          if (Number.isFinite(v)) ask = v;
        }
      } catch {
        // ігноруємо помилку фолу до ордербука
      }
    }

    let price = Number.isFinite(t.last) ? Number(t.last)
      : (Number.isFinite(bid) && Number.isFinite(ask)) ? (bid + ask) / 2
        : (Number.isFinite(Number(t.close)) ? Number(t.close)
          : (Number.isFinite(Number(t.info?.lastPrice)) ? Number(t.info.lastPrice) : undefined));

    const tickSize = await this._resolveQuoteTickSize(mappedSymbol, originalSymbol || mappedSymbol);
    const quote = { bid, ask, price };
    if (Number.isFinite(tickSize) && tickSize > 0) {
      quote.tickSize = tickSize;
      quote.tickSource = this._isBinanceUsdmLike() ? 'binance-exchangeInfo' : 'ccxt-market';
    }
    return quote;
  }

  // Витягнути найбільш надійний ідентифікатор ордера з відповіді біржі
  _resolveOrderId(res) {
    try {
      const info = res?.info || {};
      const id = res?.id || res?.clientOrderId || info?.orderId || info?.origClientOrderId || info?.clientOrderId || info?.data?.orderId;
      return id ? String(id) : '';
    } catch {
      return '';
    }
  }



  _shouldUseBinanceBracketFlow({ ccxtType, order }) {
    if (!this._isBinanceUsdmLike() || ccxtType !== 'limit') return false;
    const absSl = firstPositiveFiniteNumber(order.stopLossPrice, order.slPrice);
    const slPts = firstPositiveFiniteNumber(order.sl, order.stopPts, order?.meta?.stopPts);
    return absSl !== undefined || slPts !== undefined;
  }

  _makeBracketIds(bracketId) {
    return {
      entryClientOrderId: `br_${bracketId}_entry`,
      tpClientAlgoId: `br_${bracketId}_tp`,
      slClientAlgoId: `br_${bracketId}_sl`
    };
  }



  _resolveBinanceBracketPrices({ order, direction, entryPrice, tickSize }) {
    const absTp = firstPositiveFiniteNumber(order.takeProfitPrice, order.tpPrice);
    const absSl = firstPositiveFiniteNumber(order.stopLossPrice, order.slPrice);
    const tpPts = firstPositiveFiniteNumber(order.tp, order.takePts, order?.meta?.takePts);
    const slPts = firstPositiveFiniteNumber(order.sl, order.stopPts, order?.meta?.stopPts);
    if (absSl === undefined && slPts === undefined) throw new Error('Missing SL value (absolute or points)');

    const usesPointStop = absSl === undefined;
    const usesPointTp = absTp === undefined && tpPts !== undefined;
    if (!usesPointStop && !usesPointTp) {
      return { takeProfitPrice: absTp, stopLossPrice: absSl, source: 'absolute' };
    }

    const tick = Number(tickSize) > 0 ? Number(tickSize) : 0.01;
    const entry = Number(entryPrice);
    if (!Number.isFinite(entry) || entry <= 0) throw new Error('Invalid entry price for TP/SL resolver');
    const isLong = direction === 'LONG';
    const takeProfitPrice = absTp !== undefined
      ? absTp
      : tpPts !== undefined
        ? entry + (isLong ? 1 : -1) * tpPts * tick
        : undefined;
    const stopLossPrice = absSl !== undefined
      ? absSl
      : entry + (isLong ? -1 : 1) * slPts * tick;
    const source = (absTp !== undefined || absSl !== undefined) ? 'mixed' : 'points';
    return { takeProfitPrice, stopLossPrice, source };
  }

  _extractProtectiveOrderPrice(order = {}) {
    const raw = order.triggerPrice ?? order.stopPrice ?? order.price ?? order.info?.triggerPrice ?? order.info?.stopPrice ?? order.info?.price;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }

  _protectiveOrderPriceMatches(expected, actual, tickSize) {
    const exp = Number(expected);
    const act = Number(actual);
    if (!Number.isFinite(exp) || !Number.isFinite(act)) return true;
    const tick = Number(tickSize);
    const tolerance = Number.isFinite(tick) && tick > 0 ? tick / 2 : 1e-9;
    return Math.abs(exp - act) <= tolerance;
  }

  _handleManualProtectiveOrderModification(bracket, leg, openOrder, actualPrice) {
    const expectedKey = leg === 'tp' ? 'takeProfitPrice' : 'stopLossPrice';
    const expectedPrice = bracket?.[expectedKey];
    const strategy = this.protectiveOrders?.manualModificationStrategy || 'adopt';
    const log = {
      bracketId: bracket.bracketId,
      symbol: bracket.symbol,
      leg,
      clientAlgoId: leg === 'tp' ? bracket.tpClientAlgoId : bracket.slClientAlgoId,
      expectedPrice,
      brokerPrice: String(actualPrice),
      strategy
    };
    if (strategy === 'stop-managing') {
      bracket.status = 'EXTERNALLY_MODIFIED';
      bracket.externalModification = { leg, expectedPrice, brokerPrice: String(actualPrice), clientAlgoId: log.clientAlgoId, detectedAt: Date.now() };
      bracket.updatedAt = Date.now();
      console.warn(`[${this.provider}] Protective order manually modified; stopping bracket auto-management`, log);
      this.events.emit('bracket:protection_modified', { provider: this.provider, ...log, action: 'stop-managing' });
      return;
    }
    bracket[expectedKey] = String(actualPrice);
    bracket.externalModification = { leg, previousExpectedPrice: expectedPrice, brokerPrice: String(actualPrice), clientAlgoId: log.clientAlgoId, detectedAt: Date.now(), adopted: true };
    bracket.updatedAt = Date.now();
    console.warn(`[${this.provider}] Protective order manually modified; adopting broker price`, log);
    this.events.emit('bracket:protection_modified', { provider: this.provider, ...log, action: 'adopt' });
  }

  _detectManualProtectiveOrderModifications(bracket, openOrders = []) {
    const byId = new Map((Array.isArray(openOrders) ? openOrders : []).map((x) => [String(x?.clientAlgoId || ''), x]));
    for (const leg of ['tp', 'sl']) {
      const id = leg === 'tp' ? bracket.tpClientAlgoId : bracket.slClientAlgoId;
      if (!id) continue;
      const openOrder = byId.get(String(id));
      if (!openOrder) continue;
      const actualPrice = this._extractProtectiveOrderPrice(openOrder);
      const expectedPrice = leg === 'tp' ? bracket.takeProfitPrice : bracket.stopLossPrice;
      if (!this._protectiveOrderPriceMatches(expectedPrice, actualPrice, bracket.tickSize)) {
        this._handleManualProtectiveOrderModification(bracket, leg, openOrder, actualPrice);
      }
    }
  }

  async _placeBinanceBracketEntry({ order, symbol, side, amount, price, params, cid }) {
    const now = Date.now();
    const bracketId = String(order.bracketId || order.strategyId || cid || crypto.randomBytes(6).toString('hex'));
    const ids = this._makeBracketIds(bracketId);
    const nativeSymbol = await this.normalizeBinanceUsdmSymbol(symbol);
    const direction = String(side).toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';
    const hedgePos = String(params.positionSide || '').toUpperCase();
    const hedgeMode = hedgePos === 'LONG' || hedgePos === 'SHORT';
    const positionSide = hedgeMode ? hedgePos : 'BOTH';
    const { tickSize, stepSize, minNotional } = await this._getBinanceSymbolFilters(nativeSymbol);
    const priceRounded = this._roundToStep(price, tickSize || 0.01, 'round');
    let effectiveAmount = amount;
    const riskUsd = Number(order?.meta?.riskUsd);
    let stopPts = Number(order.sl ?? order.stopPts ?? order?.meta?.stopPts);
    if ((!Number.isFinite(stopPts) || stopPts <= 0) && Number.isFinite(Number(order.stopLossPrice ?? order.slPrice))) {
      const slAbs = Number(order.stopLossPrice ?? order.slPrice);
      stopPts = Math.round(Math.abs(priceRounded - slAbs) / tickSize);
    }
    if (Number.isFinite(riskUsd) && riskUsd > 0) {
      if (!Number.isFinite(stopPts) || stopPts <= 0) {
        return { status: 'rejected', provider: this.provider, reason: 'Unable to calculate Binance risk-based qty: missing stopPts/stopLossPrice' };
      }
      effectiveAmount = orderCalc.qty({
        riskUsd,
        stopPts,
        tickSize,
        lot: Number(order.lot ?? order.meta?.lot ?? 1),
        instrumentType: order.instrumentType
      });
      if (!Number.isFinite(effectiveAmount) || effectiveAmount <= 0) {
        return { status: 'rejected', provider: this.provider, reason: `Unable to calculate Binance risk-based qty: computed amount=${effectiveAmount}` };
      }
    }
    const qtyRounded = this._roundToStep(effectiveAmount, stepSize || 0.000001, 'floor');
    console.log('[EXEC][BINANCE_SIZE]', { symbol: nativeSymbol, riskUsd, stopPts, exchangeTickSize: tickSize, stepSize, inputAmount: amount, effectiveAmount, qtyRounded, priceRounded, source: 'exchangeInfo' });
    if ((qtyRounded * priceRounded) < minNotional) return { status: 'rejected', provider: this.provider, reason: 'MIN_NOTIONAL validation failed' };
    const { takeProfitPrice, stopLossPrice, source } = this._resolveBinanceBracketPrices({ order, direction, entryPrice: priceRounded, tickSize });
    const tp = takeProfitPrice === undefined
      ? undefined
      : String(this._roundToStep(takeProfitPrice, tickSize || 0.01, 'round'));
    const sl = String(this._roundToStep(stopLossPrice, tickSize || 0.01, 'round'));

    const entryReq = { symbol: nativeSymbol, side: direction === 'LONG' ? 'BUY' : 'SELL', type: 'LIMIT', timeInForce: 'GTC', quantity: String(qtyRounded), price: String(priceRounded), newClientOrderId: ids.entryClientOrderId };
    if (hedgeMode) entryReq.positionSide = positionSide;
    const entryRes = await this._binanceSignedRequest('POST', '/fapi/v1/order', entryReq);

    this._brackets.set(bracketId, { bracketId, symbol: nativeSymbol, mappedSymbol: symbol, positionSide, direction, entryClientOrderId: ids.entryClientOrderId, tpClientAlgoId: null, slClientAlgoId: null, entryOrderId: Number(entryRes?.orderId || 0) || null, status: 'ENTRY_PLACED', expectedQty: String(qtyRounded), actualQty: null, entryPrice: String(priceRounded), takeProfitPrice: tp, stopLossPrice: sl, protectionPriceSource: source, tickSize: String(tickSize), pendingId: cid, origOrder: order, uiConfirmed: false, uiRejected: false, createdAt: now, updatedAt: now });
    this._entryClientToBracket.set(ids.entryClientOrderId, bracketId);
    this.pending.set(cid, { order, createdAt: now });
    setImmediate(() => {
      const bracket = this._brackets.get(bracketId);
      if (bracket && !['CANCELED','CLOSED'].includes(bracket.status)) this._confirmBracketPending(bracket, entryRes);
    });
    this._startBracketEntryWatcher(bracketId).catch(() => {});
    return { status: 'ok', provider: this.provider, providerOrderId: `pending:${cid}`, raw: { enqueued: true, bracketId, entry: entryRes } };
  }



  _confirmBracketPending(bracket, entryOrder = {}) {
    if (!bracket || bracket.uiConfirmed || bracket.uiRejected) return;
    const pendingId = bracket.pendingId || bracket.bracketId;
    const pending = this.pending.get(pendingId);
    bracket.uiConfirmed = true;
    bracket.confirmedAt = Date.now();
    this.pending.delete(pendingId);
    const ticket = String(bracket.entryOrderId || entryOrder?.orderId || bracket.entryClientOrderId || '');
    const mappedSymbol = bracket.mappedSymbol || this.mapSymbol?.(bracket.origOrder?.symbol || bracket.symbol) || bracket.symbol;
    bracket.lifecycleTicket = ticket;
    bracket.mappedSymbol = mappedSymbol;
    this._registerTrackedTicket(ticket, mappedSymbol);
    this.events.emit('order:confirmed', {
      pendingId,
      ticket,
      mtOrder: {
        ...entryOrder,
        bracketId: bracket.bracketId,
        entryClientOrderId: bracket.entryClientOrderId,
        tpClientAlgoId: bracket.tpClientAlgoId,
        slClientAlgoId: bracket.slClientAlgoId,
        takeProfitPrice: bracket.takeProfitPrice,
        stopLossPrice: bracket.stopLossPrice,
        protectionStatus: bracket.status
      },
      origOrder: pending?.order || bracket.origOrder
    });
  }

  _markBracketOpened(bracket, entryOrder = {}) {
    if (!bracket) return false;
    const ticket = String(bracket.lifecycleTicket || bracket.entryOrderId || entryOrder?.orderId || bracket.entryClientOrderId || '');
    const mappedSymbol = bracket.mappedSymbol || this.mapSymbol?.(bracket.origOrder?.symbol || bracket.symbol) || bracket.symbol;
    bracket.lifecycleTicket = ticket;
    bracket.mappedSymbol = mappedSymbol;
    this._registerTrackedTicket(ticket, mappedSymbol);
    return this._emitPositionOpened(ticket, {
      symbol: mappedSymbol,
      size: Number(bracket.actualQty || entryOrder?.executedQty || entryOrder?.cumQty || bracket.expectedQty || 0),
      bracketId: bracket.bracketId
    }, bracket.origOrder);
  }

  _rejectBracketPending(bracket, reason, raw = undefined) {
    if (!bracket || bracket.uiConfirmed || bracket.uiRejected) return;
    const pendingId = bracket.pendingId || bracket.bracketId;
    const pending = this.pending.get(pendingId);
    bracket.uiRejected = true;
    bracket.rejectedAt = Date.now();
    this.pending.delete(pendingId);
    this.events.emit('order:rejected', {
      pendingId,
      reason: reason || bracket.lastError || 'Binance bracket rejected',
      msg: raw,
      origOrder: pending?.order || bracket.origOrder
    });
  }

  async _placeBracketProtection(bracket) {
    if (bracket?.protectionPromise) return bracket.protectionPromise;
    const visibilityGraceMs = Math.max(
      0,
      Number(this.exchange?.options?.protectionVisibilityGraceMs) || 15000
    );
    if (
      bracket?.status === 'PROTECTED'
      && Number.isFinite(bracket.protectionPlacedAt)
      && Date.now() - bracket.protectionPlacedAt < visibilityGraceMs
    ) return;
    const task = this._placeBracketProtectionOnce(bracket);
    bracket.protectionPromise = task;
    try {
      return await task;
    } finally {
      if (bracket.protectionPromise === task) bracket.protectionPromise = null;
    }
  }

  async _placeBracketProtectionOnce(bracket) {
    try {
      const qty = String(bracket.actualQty || bracket.expectedQty);
      const closeSide = bracket.direction === 'LONG' ? 'SELL' : 'BUY';
      const common = { algoType: 'CONDITIONAL', symbol: bracket.symbol, side: closeSide, type: '', quantity: qty, workingType: 'MARK_PRICE' };
      if (bracket.positionSide !== 'BOTH') common.positionSide = bracket.positionSide; else common.reduceOnly = 'true';
      const tpId = this._makeBracketIds(bracket.bracketId).tpClientAlgoId;
      const slId = this._makeBracketIds(bracket.bracketId).slClientAlgoId;
      const open = await this._binanceSignedRequest('GET', '/fapi/v1/openAlgoOrders', { symbol: bracket.symbol }).catch(() => []);
      const mark = await this._binancePublicRequest('/fapi/v1/premiumIndex', { symbol: bracket.symbol }).catch(() => ({}));
      const markPrice = Number(mark?.markPrice);
      const tpNum = positiveFiniteNumber(bracket.takeProfitPrice);
      const slNum = positiveFiniteNumber(bracket.stopLossPrice);
      const hasTp = tpNum !== undefined;
      if (slNum === undefined) throw new Error('Missing stop-loss price for Binance protection');
      if (Number.isFinite(markPrice)) {
        const slOk = bracket.direction === 'LONG' ? slNum < markPrice : slNum > markPrice;
        const tpOk = !hasTp || (bracket.direction === 'LONG' ? tpNum > markPrice : tpNum < markPrice);
        if (!slOk || !tpOk) {
          const tpDescription = hasTp ? `TP=${tpNum}, ` : '';
          throw new Error(`Invalid protection prices: ${bracket.direction} requires protection around mark, got ${tpDescription}SL=${slNum}, mark=${markPrice}`);
        }
      }
      const openIds = new Set((Array.isArray(open) ? open : []).map((x) => String(x.clientAlgoId || '')));
      let createdTp = false;
      const tpReq = hasTp
        ? { ...common, type: 'TAKE_PROFIT_MARKET', triggerPrice: bracket.takeProfitPrice, clientAlgoId: tpId }
        : null;
      const slReq = { ...common, type: 'STOP_MARKET', triggerPrice: bracket.stopLossPrice, clientAlgoId: slId };
      const protectionLog = { bracketId: bracket.bracketId, direction: bracket.direction, entryPrice: bracket.entryPrice, markPrice, tickSize: bracket.tickSize, source: bracket.protectionPriceSource };
      if (tpReq) protectionLog.tpReq = tpReq;
      protectionLog.slReq = slReq;
      console.log(`[${this.provider}] Binance bracket protection request`, protectionLog);
      if (tpReq && !openIds.has(tpId)) {
        await this._binanceSignedRequest('POST', '/fapi/v1/algoOrder', tpReq);
        createdTp = true;
      }
      if (tpReq) {
        bracket.tpClientAlgoId = tpId;
        this._algoClientToBracket.set(tpId, bracket.bracketId);
      } else {
        bracket.tpClientAlgoId = null;
        this._algoClientToBracket.delete(tpId);
      }
      if (!openIds.has(slId)) {
        try {
          await this._binanceSignedRequest('POST', '/fapi/v1/algoOrder', slReq);
        } catch (e) {
          const allowPartial = !!this.exchange?.options?.allowPartialProtection;
          if (createdTp && !allowPartial) {
            try { await this._binanceSignedRequest('DELETE', '/fapi/v1/algoOrder', { symbol: bracket.symbol, clientAlgoId: tpId }); } catch {}
            bracket.tpClientAlgoId = null;
            this._algoClientToBracket.delete(tpId);
          }
          throw e;
        }
      }
      bracket.slClientAlgoId = slId;
      this._algoClientToBracket.set(slId, bracket.bracketId);
      bracket.status = 'PROTECTED';
      bracket.protectionPlacedAt = Date.now();
      bracket.lastError = undefined;
      bracket.updatedAt = Date.now();
    } catch (error) {
      bracket.status = 'ERROR';
      bracket.lastError = error?.message || String(error);
      console.error(`[${this.provider}] Binance bracket protection failed`, { bracketId: bracket.bracketId, error: bracket.lastError });
      bracket.updatedAt = Date.now();
      this.events.emit('bracket:protection_failed', { provider: this.provider, symbol: bracket.symbol, bracketId: bracket.bracketId, error: bracket.lastError });
      throw error;
    }
  }

  async _startBracketEntryWatcher(bracketId) {
    if (this._bracketEntryWatchers.has(bracketId)) return;
    const t = setInterval(() => { this._pollBracketEntryUntilFilled(bracketId).catch(() => {}); }, 1000);
    this._bracketEntryWatchers.set(bracketId, { startedAt: Date.now(), timer: t });
    await this._pollBracketEntryUntilFilled(bracketId);
  }

  async _pollBracketEntryUntilFilled(bracketId) {
    const bracket = this._brackets.get(bracketId);
    const watcher = this._bracketEntryWatchers.get(bracketId);
    if (!bracket || !watcher) return;
    const timeoutMs = Number(this.exchange?.options?.bracketEntryFillTimeoutMs || 0);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0 && Date.now() - watcher.startedAt > timeoutMs) {
      clearInterval(watcher.timer);
      this._bracketEntryWatchers.delete(bracketId);
      return;
    }
    const o = await this._binanceSignedRequest('GET', '/fapi/v1/order', { symbol: bracket.symbol, origClientOrderId: bracket.entryClientOrderId });
    const st = String(o?.status || '').toUpperCase();
    if (st === 'FILLED') {
      bracket.status = 'ENTRY_FILLED';
      bracket.actualQty = String(o?.executedQty || o?.cumQty || bracket.expectedQty);
      bracket.updatedAt = Date.now();
      this._confirmBracketPending(bracket, o);
      this._markBracketOpened(bracket, o);
      try {
        await this._placeBracketProtection(bracket);
      } catch (error) {
        bracket.status = 'ERROR';
        bracket.lastError = error?.message || String(error);
        this._rejectBracketPending(bracket, `Entry filled but protection failed: ${bracket.lastError}`, error);
      }
      clearInterval(watcher.timer); this._bracketEntryWatchers.delete(bracketId);
      return;
    }
    if (st === 'PARTIALLY_FILLED') { bracket.status = 'ENTRY_PARTIALLY_FILLED'; bracket.actualQty = String(o?.executedQty || o?.cumQty || ''); bracket.updatedAt = Date.now(); this._confirmBracketPending(bracket, o); this._markBracketOpened(bracket, o); return; }
    if (['CANCELED','REJECTED','EXPIRED'].includes(st)) { bracket.status = 'CANCELED'; bracket.updatedAt = Date.now(); this._rejectBracketPending(bracket, `Entry order finished with status ${st}`, o); clearInterval(watcher.timer); this._bracketEntryWatchers.delete(bracketId); }
  }

  _registerTrackedTicket(ticket, symbol) {
    const normalizedTicket = String(ticket || '').trim();
    if (!normalizedTicket || !symbol) return false;
    this._ticketToSymbol.set(normalizedTicket, symbol);
    this._positionClosedTickets.delete(normalizedTicket);
    return true;
  }

  _emitPositionOpened(ticket, order = {}, origOrder = undefined) {
    const normalizedTicket = String(ticket || '').trim();
    if (!normalizedTicket || this._ticketOpened.has(normalizedTicket)) return false;
    this._ticketOpened.add(normalizedTicket);
    this.events.emit('position:opened', { ticket: normalizedTicket, order, origOrder });
    return true;
  }

  _emitPositionClosed(ticket, trade = {}) {
    const normalizedTicket = String(ticket || '').trim();
    if (!normalizedTicket || this._positionClosedTickets.has(normalizedTicket)) return false;
    this._positionClosedTickets.add(normalizedTicket);
    this._ticketOpened.delete(normalizedTicket);
    const profit = Number(trade?.profit);
    const normalizedTrade = Number.isFinite(profit)
      ? { ...trade, profit, pnlStatus: 'reported' }
      : { ...trade, profit: undefined, pnlStatus: trade?.pnlStatus || 'unavailable' };
    this.events.emit('position:closed', { ticket: normalizedTicket, trade: normalizedTrade });
    return true;
  }

  _markBracketClosed(bracket) {
    if (!bracket) return false;
    const ticket = String(bracket.lifecycleTicket || bracket.entryOrderId || bracket.entryClientOrderId || '');
    if (!this._ticketOpened.has(ticket)) return false;
    bracket.status = 'CLOSED';
    bracket.updatedAt = Date.now();
    return this._emitPositionClosed(ticket, { pnlStatus: 'unavailable' });
  }

  _startWatchLoop() {
    if (this._watchTimer || typeof this.exchange.fetchPositions !== 'function') return;
    this._watchTimer = setInterval(() => {
      this._watchOnce().catch(() => {});
    }, Math.max(500, this.watchIntervalMs));
    // перша ітерація
    this._watchOnce().catch(() => {});
  }

  async _watchOnce() {
    try {
      // якщо нема нічого відстежувати — пропускаємо (економимо ліміти)
      if (this._ticketToSymbol.size === 0) return;

      // 1) Позиції: будуємо map символ -> net size
      let positions;
      try { positions = await this.exchange.fetchPositions(); } catch { return; }
      const sizeBySymbol = new Map();
      const pnlBySymbol = new Map();

      for (const p of positions || []) {
        const sym = p?.symbol || p?.info?.symbol || p?.info?.instId;
        if (!sym) continue;
        // спробуємо нормалізувати розмір
        const sz = Number(p?.contracts ?? p?.positionAmt ?? p?.size ?? p?.info?.positionAmt ?? p?.info?.pos ?? 0);
        const net = Number(sizeBySymbol.get(sym) || 0) + (Number.isFinite(sz) ? sz : 0);
        sizeBySymbol.set(sym, net);
        const upnl = Number(p?.unrealizedPnl ?? p?.info?.unrealizedPnl ?? p?.info?.upl ?? 0);
        pnlBySymbol.set(sym, upnl);
      }

      // 2) Для кожного ticket (оригінальна заявка) дивимось символ і зміну стану
      for (const [ticket, sym] of this._ticketToSymbol.entries()) {
        const szNow = Number(sizeBySymbol.get(sym) || 0);
        const wasOpen = this._ticketOpened.has(ticket);
        if (!wasOpen && szNow !== 0) {
          // відкрилася позиція
          this._emitPositionOpened(ticket, { symbol: sym, size: szNow });
        } else if (wasOpen && szNow === 0) {
          // позиція закрилась
          const profit = pnlBySymbol.has(sym) ? Number(pnlBySymbol.get(sym)) : undefined;
          this._emitPositionClosed(ticket, { profit });
        }
      }
    } catch {
      // ignore watcher errors
    }
  }

  // Підписка на внутрішні події адаптера (сумісно з wireAdapter)
  on(event, fn) { this.events.on(event, fn); return () => this.events.off(event, fn); }

  // Зупинка очікування відкриття основного ордера (до моменту підтвердження)
  stopOpenOrder(cid) {
    const rec = this.pending.get(cid);
    if (!rec) return;
    this.pending.delete(cid);
    // Емітимо відмову, щоб UI зняв "pending"
    this.events.emit('order:rejected', {
      pendingId: cid,
      reason: 'RETRY_STOPPED',
      origOrder: rec.order
    });
  }

  /**
   * Створення reduce-only SL/TP захисних ордерів.
   * - SL: stop-market з тригером stopPrice (reduceOnly)
   * - TP: limit ордер на протилежну сторону за tpPrice (reduceOnly)
   * Повертає масив id дочірніх ордерів (може бути порожнім/частковим).
   */
  async _placeProtectiveOrders({ mappedSymbol, side, amount, entryPrice, slPts, tpPts, tickSize, baseParams = {} }) {
    const childIds = [];
    const opposite = side === 'buy' ? 'sell' : 'buy';
    const tick = Number(tickSize) > 0 ? Number(tickSize) : 1;

    const reduceParams = { ...baseParams };
    // популярний ключ у ccxt
    reduceParams.reduceOnly = true;
    // інколи біржі сприймають альтернативний snake_case
    reduceParams.reduce_only = true;
    // Дефолт для багатьох бірж (зокрема Binance Futures)
    if (!reduceParams.timeInForce) reduceParams.timeInForce = 'GTC';

    // Розрахунок рівнів
    const hasSL = Number.isFinite(slPts) && Number(slPts) > 0 && Number.isFinite(entryPrice);
    const hasTP = Number.isFinite(tpPts) && Number(tpPts) > 0 && Number.isFinite(entryPrice);

    const slPrice = hasSL
      ? (side === 'buy' ? (entryPrice - Number(slPts) * tick) : (entryPrice + Number(slPts) * tick))
      : undefined;

    const tpPrice = hasTP
      ? (side === 'buy' ? (entryPrice + Number(tpPts) * tick) : (entryPrice - Number(tpPts) * tick))
      : undefined;

    // Binance Futures: частина умовних ордерів тепер вимагає Algo API endpoint.
    // Намагаємось ставити SL/TP через algo endpoint, а createOrder залишаємо як fallback.
    const tryBinanceAlgoOrder = async ({ kind, triggerPrice, limitPrice }) => {
      if (this.exchangeId !== 'binance') return null;
      const nativeSymbol = this.getNativeSymbol(mappedSymbol);
      if (!nativeSymbol) return null;

      const orderType = kind === 'SL' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET';
      const req = {
        symbol: nativeSymbol,
        side: String(opposite || '').toUpperCase(),
        quantity: this.exchange.amountToPrecision(mappedSymbol, amount),
        reduceOnly: 'true',
        stopPrice: this.exchange.priceToPrecision(mappedSymbol, triggerPrice),
        workingType: 'CONTRACT_PRICE',
        priceProtect: 'TRUE',
        timeInForce: 'GTC',
        type: orderType,
      };
      if (Number.isFinite(limitPrice) && limitPrice > 0) {
        req.type = kind === 'SL' ? 'STOP' : 'TAKE_PROFIT';
        req.price = this.exchange.priceToPrecision(mappedSymbol, limitPrice);
      }

      const posSide = String(baseParams.positionSide || '').toUpperCase();
      if (posSide === 'LONG' || posSide === 'SHORT') req.positionSide = posSide;

      const fns = [
        ['fapiPrivatePostAlgoOrder', this.exchange.fapiPrivatePostAlgoOrder],
        ['fapiPrivate_post_algoorder', this.exchange.fapiPrivate_post_algoorder],
        ['fapiPrivatePostAlgoOrders', this.exchange.fapiPrivatePostAlgoOrders],
        ['fapiPrivate_post_algoorders', this.exchange.fapiPrivate_post_algoorders],
      ].filter(([, fn]) => typeof fn === 'function');
      if (!fns.length) {
        console.warn(`[${this.provider}] Binance algo method not found in ccxt instance; trying signed /fapi/v1/algoOrder for ${kind}`, {
          mappedSymbol,
          nativeSymbol,
          availableAlgoKeys: Object.keys(this.exchange || {}).filter(k => k.toLowerCase().includes('algo')).slice(0, 50)
        });
        const algoReq = {
          algoType: 'CONDITIONAL',
          symbol: nativeSymbol,
          side: String(opposite || '').toUpperCase(),
          type: req.type,
          quantity: req.quantity,
          triggerPrice: req.stopPrice,
          workingType: 'MARK_PRICE',
          clientAlgoId: `${kind.toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
        };
        if (String(baseParams?.positionSide || '').toUpperCase() === 'LONG' || String(baseParams?.positionSide || '').toUpperCase() === 'SHORT') {
          algoReq.positionSide = String(baseParams.positionSide).toUpperCase();
        } else {
          algoReq.reduceOnly = 'true';
        }
        const res = await this._binanceSignedRequest('POST', '/fapi/v1/algoOrder', algoReq);
        const algoId = String(res?.algoId || res?.clientAlgoId || '').trim();
        if (algoId) return { id: algoId, raw: res };
        return null;
      }
      console.log(`[${this.provider}] Trying Binance algo ${kind}`, {
        methodCandidates: fns.map(([name]) => name),
        request: req
      });
      for (const [name, fn] of fns) {
        const res = await fn.call(this.exchange, req);
        const algoId = String(res?.algoId || res?.orderId || res?.clientOrderId || '').trim();
        if (algoId) {
          console.log(`[${this.provider}] Binance algo ${kind} placed`, { method: name, algoId, response: res });
          return { id: algoId, raw: res };
        }
        console.warn(`[${this.provider}] Binance algo ${kind} no id in response`, { method: name, response: res });
      }
      return null;
    };

    // SL: спершу намагаємось чистий stop-market (без price), фолбек — stop-limit
    if (hasSL && Number.isFinite(slPrice) && slPrice > 0) {
      const slParams = { ...reduceParams, stopPrice: slPrice };
      try {
        // 0) Для Binance USDⓈ-M часто працює саме closePosition STOP_MARKET через createOrder.
        // Це не OCO/брекет, але коректно закриває відкриту позицію по тригеру.
        if (this._isBinanceUsdmLike()) {
          try {
            const p = {
              ...slParams,
              closePosition: true,
              workingType: slParams.workingType || 'CONTRACT_PRICE',
              priceProtect: slParams.priceProtect ?? 'TRUE',
            };
            const slClosePos = await this.exchange.createOrder(mappedSymbol, 'stop_market', opposite, undefined, undefined, p);
            const slCloseId = this._resolveOrderId(slClosePos);
            if (slCloseId) {
              childIds.push(slCloseId);
              slParams._algoPlaced = true;
            }
          } catch (closeErr) {
            console.warn(`[${this.provider}] Binance closePosition STOP_MARKET SL failed, trying algo/createOrder fallback`, closeErr?.message || String(closeErr));
          }
        }

        // 0) Binance Algo API
        try {
          if (slParams._algoPlaced) throw new Error('SL_ALREADY_PLACED');
          const algoSL = await tryBinanceAlgoOrder({ kind: 'SL', triggerPrice: slPrice });
          if (algoSL?.id) {
            childIds.push(algoSL.id);
            slParams._algoPlaced = true;
          }
        } catch (algoErr) {
          if (String(algoErr?.message || '') === 'SL_ALREADY_PLACED') {
            // skip algo attempt
          } else {
          console.warn(`[${this.provider}] Binance algo SL failed, fallback to createOrder`, algoErr?.message || String(algoErr));
          }
        }

        if (slParams._algoPlaced) {
          delete slParams._algoPlaced;
          // already placed via algo endpoint
        } else {
        // 1) Спроба створити чистий stop-market (без price)
        // Binance: деривативи — STOP_MARKET, spot — STOP_LOSS
        let slOrder;
        try {
          const mkt = typeof this.exchange.market === 'function' ? this.exchange.market(mappedSymbol) : null;
          const isDeriv = !!(mkt && (mkt.contract || mkt.swap || mkt.future));
          const stopType =
            (this.exchangeId === 'binance')
              ? (isDeriv ? 'STOP_MARKET' : 'STOP_LOSS')
              : 'STOP_MARKET';
          slOrder = await this.exchange.createOrder(mappedSymbol, stopType, opposite, amount, undefined, slParams);
        } catch (e1) {
          // 2) Фолбек: stop-limit (деякі біржі вимагають наявність price разом зі stopPrice)
          slOrder = await this.exchange.createOrder(mappedSymbol, 'stop', opposite, amount, slPrice, slParams);
        }
        const slId = this._resolveOrderId(slOrder);
        if (slId) childIds.push(slId);
        }
      } catch (e) {
        console.error(`[${this.provider}] Failed to place SL order:`, e?.message || String(e));
      }
    }

    // TP: спочатку умовний ордер (уникнути миттєвого матчу без позиції):
    // 1) TAKE_PROFIT_MARKET зі stopPrice (reduceOnly)
    // 2) TAKE_PROFIT (limit) з price=tpPrice і stopPrice
    // 3) fallback: звичайний limit (може бути відхилений на деяких біржах)
    if (hasTP && Number.isFinite(tpPrice) && tpPrice > 0) {
      let placed = false;
      // 0) Binance Algo API
      try {
        const algoTP = await tryBinanceAlgoOrder({ kind: 'TP', triggerPrice: tpPrice });
        const tpId = algoTP?.id;
        if (tpId) {
          childIds.push(tpId);
          placed = true;
        }
      } catch (algoErr) {
        console.warn(`[${this.provider}] Binance algo TP failed, fallback to createOrder`, algoErr?.message || String(algoErr));
      }

      // 1) TP market on trigger
      if (!placed) {
        try {
          const p = { ...reduceParams, stopPrice: tpPrice };
          const tpOrder = await this.exchange.createOrder(mappedSymbol, 'take_profit_market', opposite, amount, undefined, p);
          const tpId = this._resolveOrderId(tpOrder);
          if (tpId) {
            childIds.push(tpId);
            placed = true;
          }
        } catch (_) {}
      }

      // 2) TP limit on trigger
      if (!placed) {
        try {
          const p = { ...reduceParams, stopPrice: tpPrice };
          const tpOrder = await this.exchange.createOrder(mappedSymbol, 'take_profit', opposite, amount, tpPrice, p);
          const tpId = this._resolveOrderId(tpOrder);
          if (tpId) {
            childIds.push(tpId);
            placed = true;
          }
        } catch (_) {}
      }

      // 3) Fallback: plain limit (reduceOnly). Може бути відхилений біржею — логируем і йдемо далі.
      if (!placed) {
        try {
          const tpOrder = await this.exchange.createOrder(mappedSymbol, 'limit', opposite, amount, tpPrice, reduceParams);
          const tpId = this._resolveOrderId(tpOrder);
          if (tpId) childIds.push(tpId);
        } catch (e) {
          console.error(`[${this.provider}] Failed to place TP order:`, e?.message || String(e));
        }
      }
    }

    return childIds;
  }

  /**
   * Вотчер батьківського ордера: якщо основний ордер буде скасований — скасувати дочірні SL/TP.
   * Перевіряємо статус раз на 2 секунди до 5 хвилин або до завершення (canceled/closed).
   */
  _startParentWatcher(parentId, mappedSymbol) {
    if (!parentId || this._parentWatchers.has(parentId)) return;

    const startedAt = Date.now();
    const timer = setInterval(async () => {
      try {
        const age = Date.now() - startedAt;
        if (age > 5 * 60 * 1000) { // 5 хв — зупинимо вотчер
          clearInterval(timer);
          this._parentWatchers.delete(parentId);
          return;
        }
        const ord = await this.exchange.fetchOrder(parentId, mappedSymbol);
        const st = String(ord?.status || '').toLowerCase();
        if (st === 'canceled') {
          clearInterval(timer);
          this._parentWatchers.delete(parentId);
          await this._cancelChildOrders(parentId);
          // повідомимо UI про відміну ордера
          this.events.emit('order:cancelled', { ticket: parentId });
        } else if (st === 'closed') {
          clearInterval(timer);
          this._parentWatchers.delete(parentId);
        }
      } catch {
        // ігноруємо, спробуємо наступного разу
      }
    }, 2000);

    this._parentWatchers.set(parentId, timer);
  }

  async _cancelChildOrders(parentId) {
    const link = this._childOrdersByParent.get(parentId);
    if (!link) return;
    const { symbol: mappedSymbol, children } = link;
    await this.ensureReady();
    for (const cid of children || []) {
      try {
        if (this.exchangeId === 'binance' && String(cid).length > 20) {
           // Ймовірно algoId для Binance Futures
           try {
             const nativeSymbol = this.getNativeSymbol(mappedSymbol);
             await this._binanceSignedRequest('DELETE', '/fapi/v1/algoOrder', { symbol: nativeSymbol, clientAlgoId: cid });
             continue;
           } catch (e) {
             // якщо не вдалося через fapi - спробуємо звичайним cancelOrder
           }
        }
        await this.exchange.cancelOrder(cid, mappedSymbol);
      } catch {
        // Спроба відміни по clientOrderId/origClientOrderId (актуально для умовних ордерів на деяких біржах)
        try {
          await this.exchange.cancelOrder(undefined, mappedSymbol, { origClientOrderId: cid, clientOrderId: cid });
        } catch {
          // остання спроба — ігноруємо помилку
        }
      }
    }
    this._childOrdersByParent.delete(parentId);
  }

  // Класифікація ордеру як SL або TP за його типом
  _classifyOrderAsSLorTP(ord) {
    try {
      const t = String(ord?.type || ord?.orderType || ord?.info?.orderType || ord?.info?.type || '').toLowerCase();
      if (!t) return null;
      if (t.includes('take')) return 'TP';
      if (t.includes('stop') && !t.includes('take')) return 'SL';
      if (t.includes('stop_loss') || t.includes('stoploss') || t === 'stop') return 'SL';
      return null;
    } catch {
      return null;
    }
  }

  async _openOrdersSym(sym) {
    try {
      await this.ensureReady();
      let simpleOrders = await this.exchange.fetchOpenOrders(sym);

      let conditionalOrders = await this.exchange.fetchOpenOrders(sym, params => ({
        ...params,
        stop: true,
        trigger: true,
        conditional: true
      }));

      let algoOrders = [];
      if (this._isBinanceUsdmLike()) {
        const nativeSymbol = this.getNativeSymbol(sym);
        const getOpenAlgo =
          this.exchange.fapiPrivateGetOpenAlgoOrders
          || this.exchange.fapiPrivate_get_openalgoorders;
        if (typeof getOpenAlgo === 'function') {
          algoOrders = await getOpenAlgo.call(this.exchange, { symbol: nativeSymbol, stop: true });
        } else {
          try {
            algoOrders = await this._binanceSignedRequest('GET', '/fapi/v1/openAlgoOrders', { symbol: nativeSymbol });
          } catch (e) {
            console.warn(`[${this.provider}] raw openAlgoOrders failed for ${sym}:`, e?.message || String(e));
          }
        }
      }

      console.log("Open orders sym", this.exchangeId,  simpleOrders, conditionalOrders, algoOrders );
      return [
        ...simpleOrders,
        ...conditionalOrders,
        ...algoOrders
      ];
    } catch (e) {
      console.error(`[${this.provider}] Failed to fetch open orders for symbol ${sym}`, e);
      return [];
    }
  }

  async _openOrders() {
    try {
      await this.ensureReady();
      let simpleOrders = await this.exchange.fetchOpenOrders();
      let conditionalOrders = await this.exchange.fetchOpenOrders(params => ({
        ...params,
        stop: true,
        trigger: true,
        conditional: true
      }));

      let algoOrders = [];
      if (this._isBinanceUsdmLike()) {
        const getOpenAlgo =
          this.exchange.fapiPrivateGetOpenAlgoOrders
          || this.exchange.fapiPrivate_get_openalgoorders;
        if (typeof getOpenAlgo === 'function') {
          algoOrders = await getOpenAlgo.call(this.exchange);
        } else if (typeof this.exchange.request === 'function') {
          try {
            algoOrders = await this.exchange.request('openAlgoOrders', 'fapiPrivate', 'GET', {});
          } catch (e) {
            console.warn(`[${this.provider}] raw openAlgoOrders failed:`, e?.message || String(e));
          }
        }
      }
      console.log("Open orders", this.exchangeId, simpleOrders, conditionalOrders, algoOrders );

      return [
        ...simpleOrders,
        ...conditionalOrders,
        ...algoOrders
      ];

    } catch (e) {
      console.error(`[${this.provider}] Failed to fetch open orders`, e);
      return [];
    }
  }


  async _ensureProtectiveOrdersForTicket(ticket) {
    try {
      await this.ensureReady();
      const mappedSymbol = this._ticketToSymbol.get(ticket);
      if (!mappedSymbol) return;

      // Зчитуємо бажану конфіг
      const cfg = this._desiredProtectionByTicket.get(ticket) || {};
      let { side, amount, slPts, tpPts, tickSize } = cfg;

      // Отримаємо поточний розмір позиції та середню ціну входу
      let positions = [];
      try { positions = await this.exchange.fetchPositions(); } catch { positions = []; }
      const pos = (positions || []).find(p =>
        (p?.symbol || p?.info?.symbol || p?.info?.instId) === mappedSymbol
      );

      const rawSz = Number(
        pos?.contracts ?? pos?.positionAmt ?? pos?.size ?? pos?.info?.positionAmt ?? pos?.info?.pos ?? 0
      );
      const netSize = Number.isFinite(rawSz) ? rawSz : 0;

      // Визначимо сторону й кількість з позиції, якщо не вдалося зберегти раніше
      if (!side) side = netSize >= 0 ? 'buy' : 'sell';
      if (!Number.isFinite(amount) || amount <= 0) amount = Math.abs(netSize);

      // Якщо розміру немає — немає що захищати
      if (!Number.isFinite(amount) || amount <= 0) return;

      // Визначимо entryPrice
      let entryPrice =
        Number(pos?.entryPrice) ||
        Number(pos?.info?.entryPrice) ||
        Number(pos?.info?.avgPrice) ||
        Number(pos?.info?.avgPx) ||
        Number(pos?.info?.avg_entry_price);

      if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
        // Фолбек — поточний ринок
        const q = await this.getQuote(mappedSymbol);
        entryPrice = Number(q?.price);
      }
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) return;

      // Визначимо tickSize
      const tick = Number.isFinite(Number(tickSize)) && Number(tickSize) > 0
        ? Number(tickSize)
        : this._getTickSizeFromMarket(mappedSymbol);

      // Перевіримо існування SL/TP у відкритих ордерах
      let openOrders = await this._openOrdersSym(mappedSymbol);

      const opposite = side === 'buy' ? 'sell' : 'buy';
      const hasReduce = (o) => !!(o?.reduceOnly || o?.info?.reduce_only || o?.info?.reduceOnly);
      const isOpposite = (o) => String(o?.side || '').toLowerCase() === opposite;

      let hasSL = false;
      let hasTP = false;
      for (const o of openOrders || []) {
        if (!isOpposite(o) || !hasReduce(o)) continue;
        const kind = this._classifyOrderAsSLorTP(o);
        if (kind === 'SL') hasSL = true;
        if (kind === 'TP') hasTP = true;
      }

      // Якщо сл/тп не налаштовано користувачем — не створюємо їх відповідно
      const wantSL = Number.isFinite(Number(slPts)) && Number(slPts) > 0;
      const wantTP = Number.isFinite(Number(tpPts)) && Number(tpPts) > 0;

      const needSL = wantSL && !hasSL;
      const needTP = wantTP && !hasTP;

      if (!needSL && !needTP) return;

      // Створимо відсутні (частково)
      const children = await this._placeProtectiveOrders({
        mappedSymbol,
        side,
        amount,
        entryPrice,
        slPts: needSL ? Number(slPts) : undefined,
        tpPts: needTP ? Number(tpPts) : undefined,
        tickSize: tick,
        baseParams: this.defaultParams || {}
      });

      if (children && children.length) {
        const exist = this._childOrdersByParent.get(ticket);
        const merged = exist ? Array.from(new Set([...(exist.children || []), ...children])) : children;
        this._childOrdersByParent.set(ticket, { symbol: mappedSymbol, children: merged });
      }
    } catch {
      // ignore
    }
  }

  // Скасувати всі захисні ордери (SL/TP) після виходу з позиції
  async _cancelAllProtectionForTicket(ticket) {
    try {
      await this.ensureReady();
      const mappedSymbol = this._ticketToSymbol.get(ticket);
      if (!mappedSymbol) return;

      // 1) Спробуємо відмінити ті, що ми створювали/відстежували
      try { await this._cancelChildOrders(ticket); } catch {}

      // 2) Підчистимо можливі інші reduce-only SL/TP для цього символу
      let openOrders = await this._openOrdersSym(mappedSymbol);


      const cfg = this._desiredProtectionByTicket.get(ticket) || {};
      const side = String(cfg?.side || '').toLowerCase();
      const opposite = side === 'buy' ? 'sell' : (side === 'sell' ? 'buy' : null);

      const hasReduce = (o) => !!(o?.reduceOnly || o?.info?.reduce_only || o?.info?.reduceOnly);
      for (const o of openOrders || []) {
        const isOpposite = opposite ? String(o?.side || '').toLowerCase() === opposite : true;
        if (!hasReduce(o) || !isOpposite) continue;
        const kind = this._classifyOrderAsSLorTP(o);
        if (!kind) continue;
        try {
          const oid = o?.id || o?.algoId;
          if (this.exchangeId === 'binance' && o?.algoId) {
            try {
              const nativeSymbol = this.getNativeSymbol(mappedSymbol);
              await this.exchange.fapiPrivateDeleteAlgoOpenOrders({ symbol: nativeSymbol, algoId: o.algoId });
              continue;
            } catch (e) {
              // console.log('Failed to cancel algo order via fapi, falling back to standard cancel', e);
               // fallback to standard cancel
            }
          }
          await this.exchange.cancelOrder(oid);
        } catch {
          try {
            const cid = o?.clientOrderId || o?.info?.origClientOrderId || o?.info?.clientOrderId;
            await this.exchange.cancelOrder(undefined, mappedSymbol, { origClientOrderId: cid, clientOrderId: cid });
          } catch {
            // ignore last attempt
          }
        }
      }

      // 3) Зупинимо вотчер для батьківського, якщо був
      const t = this._parentWatchers.get(ticket);
      if (t) { clearInterval(t); this._parentWatchers.delete(ticket); }

      // 4) Очистимо стани
      this._childOrdersByParent.delete(ticket);
      this._desiredProtectionByTicket.delete(ticket);
      // не видаляємо _ticketToSymbol тут: він ще може бути корисний для історії подій/логів
    } catch {
      // ignore
    }
  }

  /**
   * Очікуваний нормалізований формат замовлення:
   * {
   *   symbol: 'BTC/USDT' або локальний символ, який буде змаплено через symbolMap
   *   side: 'buy' | 'sell',
   *   type: 'market' | 'limit' | 'stop' | 'stoplimit',
   *   qty: number,              // amount
   *   price?: number,           // для limit/stoplimit
   *   stopPrice?: number,       // для stop/stoplimit
   *   clientOrderId?: string,   // опціонально
   *   params?: object           // додаткові ccxt params
   * }
   */
  async placeOrder(order) {
    try {
      await this.ensureReady();
      if (!order || !order.symbol || !order.side || !order.type) {
        return { status: 'rejected', provider: this.provider, reason: 'Missing required fields: symbol, side, type' };
      }
      const symbol = this.mapSymbol(order.symbol);
      const side = order.side;
      const amount = Number(order.qty ?? order.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return { status: 'rejected', provider: this.provider, reason: 'Invalid qty/amount' };
      }

      // Визначення типу та параметрів для ccxt
      const typeIn = String(order.type).toLowerCase();
      let ccxtType = typeIn;
      const params = { ...(this.defaultParams || {}), ...(order.params || {}) };

      let cid = '';
      if (order?.meta?.cid) {
        cid = String(order.meta.cid).trim();
      } else if (order?.clientOrderId) {
        cid = String(order.clientOrderId).trim();
      } else if (order?.cid) {
        cid = String(order.cid).trim();
      }
      if (!cid) cid = crypto.randomBytes(6).toString('hex');
      if (!order.meta) order.meta = {};
      order.meta.cid = cid;
      if (!order.clientOrderId) {
        order.clientOrderId = cid;
      }

      // Підтримка stop/stoplimit через stopPrice у params (поширений шаблон у ccxt)
      if (typeIn === 'stop' || typeIn === 'stopmarket') {
        ccxtType = 'market';
        const stopPrice = Number(order.stopPrice ?? order.stop);
        if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
          return { status: 'rejected', provider: this.provider, reason: 'stopPrice required for stop orders' };
        }
        params.stopPrice = stopPrice;
      } else if (typeIn === 'stoplimit' || typeIn === 'stop_limit') {
        ccxtType = 'limit';
        const stopPrice = Number(order.stopPrice ?? order.stop);
        if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
          return { status: 'rejected', provider: this.provider, reason: 'stopPrice required for stoplimit orders' };
        }
        params.stopPrice = stopPrice;
      } else if (typeIn !== 'market' && typeIn !== 'limit') {
        return { status: 'rejected', provider: this.provider, reason: `Unsupported order type: ${order.type}` };
      }

      if (order.clientOrderId) {
        params.clientOrderId = String(order.clientOrderId);
      }

      let price = undefined;
      if (ccxtType === 'limit') {
        price = Number(order.price ?? order.limitPrice);
        if (!Number.isFinite(price) || price <= 0) {
          return { status: 'rejected', provider: this.provider, reason: 'price required for limit/stoplimit orders' };
        }
      }

      if (this._shouldUseBinanceBracketFlow({ ccxtType, order })) {
        return await this._placeBinanceBracketEntry({ order, symbol, side, amount, price, params, cid });
      }


      // --- Pending: повертаємо відразу, а виконання — асинхронно ---
      this.pending.set(cid, { order, createdAt: Date.now() });

      (async () => {
        try {
          const result = await this.exchange.createOrder(symbol, ccxtType, side, amount, price, params);
          const providerOrderId = String(result?.id ?? result?.clientOrderId ?? '');

          // Після створення — ставимо reduce‑only SL/TP та запускаємо вотчер скасування
          try {
            const entry = Number.isFinite(order.price) ? Number(order.price)
                        : Number.isFinite(order.limitPrice) ? Number(order.limitPrice)
                        : undefined;
            const slPts = Number(order.sl);
            const tpPts = Number(order.tp);
            const tickSize = Number(order.tickSize) > 0 ? Number(order.tickSize) : this._getTickSizeFromMarket(symbol);
            // console.log('entry', entry, 'slPts', slPts, 'tpPts', tpPts, 'tickSize', tickSize);
            // Збережемо бажану конфіг, щоб у разі відсутності SL/TP при вході забезпечити їх автоматично
            if (providerOrderId) {
              this._desiredProtectionByTicket.set(providerOrderId, {
                symbol,
                side,
                amount,
                slPts,
                tpPts,
                tickSize
              });
            }

            if (providerOrderId && Number.isFinite(entry)) {
              const children = await this._placeProtectiveOrders({
                mappedSymbol: symbol,
                side,
                amount,
                entryPrice: entry,
                slPts,
                tpPts,
                tickSize,
                baseParams: this.defaultParams || {}
              });
              if (children && children.length) {
                this._childOrdersByParent.set(providerOrderId, { symbol, children });
                this._startParentWatcher(providerOrderId, symbol);
              }
            }
          } catch {
            // не блокуємо підтвердження у разі помилок брекетів
          }

          // Підтвердження для UI
          if (this.pending.has(cid)) {
            this.pending.delete(cid);

            // збережемо прив'язку ticket -> symbol для подальшого трекінгу позиції
            if (providerOrderId) this._registerTrackedTicket(providerOrderId, symbol);

            this.events.emit('order:confirmed', {
              pendingId: cid,
              ticket: providerOrderId,
              mtOrder: result,
              origOrder: order
            });
          } else {
            // pending вже знятий (наприклад, stopOpenOrder) — можна спробувати відмінити ордер
            try { if (providerOrderId) await this.exchange.cancelOrder(providerOrderId, symbol); } catch {}
          }
        } catch (e) {
          const rec = this.pending.get(cid);
          this.pending.delete(cid);
          this.events.emit('order:rejected', {
            pendingId: cid,
            reason: e?.message || String(e),
            origOrder: (rec && rec.order) || order
          });
        }
      })();

      return {
        status: 'ok',
        provider: this.provider,
        providerOrderId: `pending:${cid}`,
        raw: { enqueued: true, cid },
      };
    } catch (err) {
      return {
        status: 'rejected',
        provider: this.provider,
        reason: err?.message || String(err),
        raw: { stack: err?.stack },
      };
    }
  }





  async _reconcileBrackets() {
    for (const b of this._brackets.values()) {
      if (['CLOSED','CANCELED'].includes(b.status)) continue;

      if (b.status === 'ENTRY_PLACED' || b.status === 'ENTRY_PARTIALLY_FILLED') {
        try {
          const o = await this._binanceSignedRequest('GET', '/fapi/v1/order', { symbol: b.symbol, origClientOrderId: b.entryClientOrderId });
          const st = String(o?.status || '').toUpperCase();
          if (st === 'FILLED') { b.status = 'ENTRY_FILLED'; b.actualQty = String(o?.executedQty || o?.cumQty || b.expectedQty); this._confirmBracketPending(b, o); this._markBracketOpened(b, o); try { await this._placeBracketProtection(b); } catch (error) { b.status = 'ERROR'; b.lastError = error?.message || String(error); this._rejectBracketPending(b, `Entry filled but protection failed: ${b.lastError}`, error); } }
          else if (st === 'PARTIALLY_FILLED') { b.status = 'ENTRY_PARTIALLY_FILLED'; b.actualQty = String(o?.executedQty || o?.cumQty || ''); this._confirmBracketPending(b, o); this._markBracketOpened(b, o); }
          else if (['CANCELED','REJECTED','EXPIRED'].includes(st)) { b.status = 'CANCELED'; this._rejectBracketPending(b, `Entry order finished with status ${st}`, o); }
          b.updatedAt = Date.now();
        } catch (orderError) {
          try {
            const trades = await this._binanceSignedRequest('GET', '/fapi/v1/userTrades', {
              symbol: b.symbol,
              orderId: b.entryOrderId
            });
            const entryTrades = (Array.isArray(trades) ? trades : []).filter((trade) => (
              String(trade?.orderId || '') === String(b.entryOrderId || '')
            ));
            const executedQty = entryTrades.reduce((sum, trade) => {
              const qty = Number(trade?.qty ?? trade?.quantity ?? 0);
              return sum + (Number.isFinite(qty) ? Math.abs(qty) : 0);
            }, 0);
            if (executedQty > 0) {
              const expectedQty = Number(b.expectedQty);
              const fullyFilled = Number.isFinite(expectedQty) && executedQty + 1e-12 >= expectedQty;
              b.actualQty = String(executedQty);
              b.status = fullyFilled ? 'ENTRY_FILLED' : 'ENTRY_PARTIALLY_FILLED';
              b.updatedAt = Date.now();
              this._confirmBracketPending(b, { orderId: b.entryOrderId, executedQty: b.actualQty });
              this._markBracketOpened(b, { orderId: b.entryOrderId, executedQty: b.actualQty });
              if (fullyFilled) {
                try { await this._placeBracketProtection(b); } catch (error) {
                  b.status = 'ERROR';
                  b.lastError = error?.message || String(error);
                }
              }
            }
          } catch (tradesError) {
            const now = Date.now();
            if (!b.lastEntryReconcileWarningAt || now - b.lastEntryReconcileWarningAt >= 60000) {
              b.lastEntryReconcileWarningAt = now;
              console.warn(`[${this.provider}] Unable to reconcile Binance bracket entry`, {
                bracketId: b.bracketId,
                entryOrderId: b.entryOrderId,
                orderError: orderError?.message || String(orderError),
                tradesError: tradesError?.message || String(tradesError)
              });
            }
          }
        }
        continue;
      }

      let posAmt = 0;
      let positionKnown = false;
      try {
        const all = await this._binanceSignedRequest('GET', '/fapi/v2/positionRisk', {});
        const row = (all || []).find((r) => String(r.symbol) === b.symbol && String(r.positionSide || 'BOTH') === b.positionSide);
        posAmt = Math.abs(Number(row?.positionAmt || 0));
        positionKnown = Array.isArray(all);
      } catch {}
      let open = [];
      try { open = await this._binanceSignedRequest('GET', '/fapi/v1/openAlgoOrders', { symbol: b.symbol }); } catch {}
      this._detectManualProtectiveOrderModifications(b, open);
      if (b.status === 'EXTERNALLY_MODIFIED') continue;

      const set = new Set((open || []).map((x) => String(x.clientAlgoId || '')));

      const lifecycleTicket = String(b.lifecycleTicket || b.entryOrderId || b.entryClientOrderId || '');
      const lifecycleOpened = this._ticketOpened.has(lifecycleTicket);
      if (['PROTECTED','CLOSING','ENTRY_FILLED','ERROR'].includes(b.status) && lifecycleOpened && positionKnown && posAmt === 0) { await this.cancelBracketProtection(b.bracketId); this._markBracketClosed(b); continue; }

      const expectsTp = positiveFiniteNumber(b.takeProfitPrice) !== undefined;
      const expectsSl = positiveFiniteNumber(b.stopLossPrice) !== undefined;
      const hasTp = !expectsTp || (b.tpClientAlgoId && set.has(b.tpClientAlgoId));
      const hasSl = !expectsSl || (b.slClientAlgoId && set.has(b.slClientAlgoId));
      if (posAmt > 0 && ['ENTRY_FILLED','PROTECTED','ERROR'].includes(b.status) && (!hasTp || !hasSl)) {
        try { await this._placeBracketProtection(b); } catch {}
      }
    }
  }

  async handleBinanceUserDataEvent(evt = {}) {
    const type = evt?.e;
    if (type === 'ORDER_TRADE_UPDATE') return this._onOrderTradeUpdate(evt);
    if (type === 'ACCOUNT_UPDATE') return this._onAccountUpdate(evt);
    if (type === 'ALGO_UPDATE') return this._onAlgoUpdate(evt);
  }

  async _onOrderTradeUpdate(evt) {
    const o = evt?.o || {};
    const cid = String(o?.c || '');
    const bracketId = this._entryClientToBracket.get(cid);
    if (!bracketId) return;
    const bracket = this._brackets.get(bracketId); if (!bracket) return;
    const status = String(o?.X || '').toUpperCase();
    if (status === 'FILLED') {
      bracket.status = 'ENTRY_FILLED'; bracket.actualQty = String(o?.z || o?.q || bracket.expectedQty); bracket.updatedAt = Date.now();
      this._confirmBracketPending(bracket, o);
      this._markBracketOpened(bracket, o);
      try { await this._placeBracketProtection(bracket); } catch (error) { bracket.status = 'ERROR'; bracket.lastError = error?.message || String(error); this._rejectBracketPending(bracket, `Entry filled but protection failed: ${bracket.lastError}`, error); }
    } else if (status === 'PARTIALLY_FILLED') {
      bracket.status = 'ENTRY_PARTIALLY_FILLED'; bracket.actualQty = String(o?.z || o?.q || ''); bracket.updatedAt = Date.now();
      this._confirmBracketPending(bracket, o);
      this._markBracketOpened(bracket, o);
    } else if (['CANCELED','EXPIRED','REJECTED'].includes(status)) {
      bracket.status = 'CANCELED'; bracket.updatedAt = Date.now();
      this._rejectBracketPending(bracket, `Entry order finished with status ${status}`, o);
    }
  }

  async _onAccountUpdate(evt) {
    const positions = evt?.a?.P || [];
    for (const p of positions) {
      const symbol = String(p?.s || ''); const ps = String(p?.ps || 'BOTH'); const pa = Number(p?.pa || 0);
      if (pa !== 0) continue;
      for (const b of this._brackets.values()) {
        const lifecycleTicket = String(b.lifecycleTicket || b.entryOrderId || b.entryClientOrderId || '');
        const lifecycleOpened = this._ticketOpened.has(lifecycleTicket);
        if (b.symbol === symbol && b.positionSide === ps && lifecycleOpened && !['CLOSED','CANCELED'].includes(b.status)) {
          b.status = 'CLOSING'; b.updatedAt = Date.now();
          await this.cancelBracketProtection(b.bracketId);
          this._markBracketClosed(b);
        }
      }
    }
  }

  async _onAlgoUpdate(evt) {
    const o = evt?.o || {}; const caid = String(o?.caid || '');
    const bracketId = this._algoClientToBracket.get(caid);
    if (!bracketId) return;
    const bracket = this._brackets.get(bracketId); if (!bracket) return;
    const x = String(o?.X || '').toUpperCase();
    if (['TRIGGERED','FINISHED'].includes(x)) {
      const other = caid.endsWith('_tp') ? bracket.slClientAlgoId : bracket.tpClientAlgoId;
      if (other) await this._binanceSignedRequest('DELETE', '/fapi/v1/algoOrder', { symbol: bracket.symbol, clientAlgoId: other }).catch(()=>{});
    }
    if (['REJECTED','EXPIRED'].includes(x)) { bracket.status = 'ERROR'; bracket.updatedAt = Date.now(); }
  }

  async cancelBracketProtection(bracketId) {
    const b = this._brackets.get(String(bracketId)); if (!b) return;
    const ids = [b.tpClientAlgoId, b.slClientAlgoId].filter(Boolean);
    for (const id of ids) {
      try { await this._binanceSignedRequest('DELETE', '/fapi/v1/algoOrder', { symbol: b.symbol, clientAlgoId: id }); } catch (e) {
        const m = String(e?.message || ''); if (!m.includes('not found') && !m.includes('already')) throw e;
      }
    }
    const open = await this._binanceSignedRequest('GET', '/fapi/v1/openAlgoOrders', { symbol: b.symbol }).catch(() => []);
    const rest = (Array.isArray(open) ? open : []).filter((x) => String(x?.clientAlgoId || '').startsWith(`br_${bracketId}_`));
    if (!rest.length) { b.tpClientAlgoId = null; b.slClientAlgoId = null; }
  }

  async cancelAllProtectionForSymbol(symbol) { return this._binanceSignedRequest('DELETE', '/fapi/v1/algoOpenOrders', { symbol }); }

  async cancelOrder(orderId, symbol) {
    try {
      await this.ensureReady();
      const ticket = String(orderId || '').trim();
      if (!ticket) {
        return { status: 'error', provider: this.provider, reason: 'orderId required' };
      }
      const mappedSymbol = symbol ? this.mapSymbol(symbol) : undefined;
      try {
        if (this.exchangeId === 'binance' && (String(ticket).length > 20 || String(ticket).match(/^\d+$/))) {
          // Для Binance Futures algoId зазвичай довгий або числовий.
          // Спробуємо видалити як algo order, якщо не вийде - звичайним cancelOrder.
          try {
            const nativeSymbol = mappedSymbol ? this.getNativeSymbol(mappedSymbol) : undefined;
            await this.exchange.fapiPrivateDeleteAlgoOpenOrders({ symbol: nativeSymbol, algoId: ticket });
            //також пробуємо видалити звичайний ордер
            await this.exchange.cancelOrder(ticket, mappedSymbol);
          } catch (e) {
            await this.exchange.cancelOrder(ticket, mappedSymbol);
          }
        } else {
          await this.exchange.cancelOrder(ticket, mappedSymbol);
        }
      } catch (err) {
        if (mappedSymbol) {
          try {
            await this.exchange.cancelOrder(undefined, mappedSymbol, {
              origClientOrderId: ticket,
              clientOrderId: ticket
            });
          } catch {
            throw err;
          }
        } else {
          throw err;
        }
      }
      try { await this._cancelChildOrders(ticket); } catch {}
      const watcher = this._parentWatchers.get(ticket);
      if (watcher) {
        clearInterval(watcher);
        this._parentWatchers.delete(ticket);
      }
      this._ticketToSymbol.delete(ticket);
      return { status: 'ok', provider: this.provider };
    } catch (err) {
      return { status: 'error', provider: this.provider, reason: err?.message || String(err) };
    }
  }

  /** @returns {Promise<any[]>} список відкритих ордерів */
  async listOpenOrders() {
    try {
      const orders = await this._openOrders();
      return orders || [];
    } catch {
      return [];
    }
  }

  /** @returns {Promise<any[]>} App-tracked open position records for lifecycle recovery. */
  async listOpenPositions(symbol) {
    const requestedSymbol = String(symbol || '').trim().toUpperCase();
    const positions = [];
    for (const bracket of this._brackets.values()) {
      const ticket = String(bracket.lifecycleTicket || bracket.entryOrderId || bracket.entryClientOrderId || '');
      if (!ticket || !this._ticketOpened.has(ticket) || ['CLOSED','CANCELED'].includes(bracket.status)) continue;
      const originalSymbol = String(bracket.origOrder?.symbol || bracket.origOrder?.ticker || bracket.mappedSymbol || bracket.symbol || '');
      const symbolAliases = [
        originalSymbol,
        bracket.mappedSymbol,
        bracket.symbol
      ].map(value => String(value || '').trim().toUpperCase());
      if (requestedSymbol && !symbolAliases.includes(requestedSymbol)) continue;
      const cid = String(bracket.pendingId || bracket.origOrder?.meta?.cid || '').trim();
      const qty = Number(bracket.actualQty || bracket.expectedQty || 0);
      positions.push({
        ticket,
        id: ticket,
        orderId: ticket,
        symbol: originalSymbol,
        qty,
        contracts: qty,
        clientOrderId: cid,
        comment: bracket.origOrder?.comment || (cid ? `cid:${cid}` : ''),
        side: bracket.origOrder?.side,
        __isPosition: true
      });
    }
    return positions;
  }

  /** @returns {Promise<any[]>} Closed order history used as a position-history fallback. */
  async listClosedPositions() {
    try {
      if (typeof this.exchange.fetchClosedOrders === 'function') {
        const orders = await this.exchange.fetchClosedOrders();
        return orders || [];
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Отримати котирування
   * @param {string} symbol - у форматі ccxt або локальний (буде змаплено)
   * @returns {Promise<{bid?:number, ask?:number, price?:number}|null>}
   */
  async getInstrumentMetadata(symbol) {
    try {
      if (this._isBinanceUsdmLike()) {
        const normalized = await this.normalizeBinanceUsdmSymbol(symbol);
        const filters = await this._getBinanceSymbolFilters(normalized);
        return {
          tickSize: filters.tickSize,
          quantityStep: filters.stepSize,
          minQty: filters.minQty,
          maxQty: filters.maxQty,
          minNotional: filters.minNotional,
          sources: {
            tickSize: 'binance-exchangeInfo',
            quantityStep: 'binance-exchangeInfo',
            minQty: 'binance-exchangeInfo',
            maxQty: 'binance-exchangeInfo',
            minNotional: 'binance-exchangeInfo'
          }
        };
      }

      await this.ensureReady();
      const mapped = this.mapSymbol(symbol);
      let market;
      try {
        market = (this.exchange.markets && this.exchange.markets[mapped]) || this.exchange.market(mapped);
      } catch {}

      const amountPrecision = market?.precision?.amount;
      let quantityStep;
      if (this.exchange?.precisionMode === ccxt.TICK_SIZE && Number(amountPrecision) > 0) {
        quantityStep = Number(amountPrecision);
      } else if (Number.isInteger(amountPrecision) && amountPrecision >= 0 && amountPrecision <= 18) {
        quantityStep = 10 ** (-amountPrecision);
      } else if (Number.isFinite(Number(amountPrecision)) && Number(amountPrecision) > 0) {
        quantityStep = Number(amountPrecision);
      }

      const source = 'ccxt-market';
      return {
        tickSize: this._getTickSizeFromMarket(mapped),
        quantityStep,
        minQty: Number(market?.limits?.amount?.min),
        maxQty: Number(market?.limits?.amount?.max),
        minNotional: Number(market?.limits?.cost?.min),
        contractSize: Number(market?.contractSize),
        sources: {
          tickSize: source,
          quantityStep: source,
          minQty: source,
          maxQty: source,
          minNotional: source,
          contractSize: 'ccxt-market'
        }
      };
    } catch (err) {
      console.error(`[${this.provider}] getInstrumentMetadata:error`, { symbol, message: err?.message || String(err) });
      return null;
    }
  }

  async getQuote(symbol, quoteType = 'book') {
    let normalizedSymbol;
    let endpoint = this._binanceQuoteTypeToEndpoint(quoteType);
    let ccxtSymbol;
    try {
      if (this._isBinanceUsdmLike()) {
        normalizedSymbol = await this.normalizeBinanceUsdmSymbol(symbol);
        ccxtSymbol = `${normalizedSymbol.slice(0, -4)}/${normalizedSymbol.slice(-4)}:USDT`;

        if (!endpoint) {
          throw new Error(`Unsupported quoteType: ${quoteType}`);
        }

        const response = await this._binancePublicRequest(endpoint, { symbol: normalizedSymbol });
        const tickSize = await this._resolveQuoteTickSize(ccxtSymbol, symbol);
        if (quoteType === 'last') {
          return { provider: 'binance-usdm', symbolInput: symbol, symbol: normalizedSymbol, normalizedSymbol, endpoint, type: 'last', price: Number(response?.price), tickSize, tickSource: Number.isFinite(tickSize) ? 'binance-exchangeInfo' : undefined, timestamp: response?.time, raw: response };
        }
        if (quoteType === 'mark') {
          return { provider: 'binance-usdm', symbolInput: symbol, symbol: normalizedSymbol, normalizedSymbol, endpoint, type: 'mark', price: Number(response?.markPrice), markPrice: Number(response?.markPrice), indexPrice: Number(response?.indexPrice), lastFundingRate: Number(response?.lastFundingRate), nextFundingTime: response?.nextFundingTime, tickSize, tickSource: Number.isFinite(tickSize) ? 'binance-exchangeInfo' : undefined, timestamp: response?.time, raw: response };
        }

        const bid = Number(response?.bidPrice);
        const ask = Number(response?.askPrice);
        const mid = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : undefined;
        if (quoteType === 'execution') {
          return { provider: 'binance-usdm', symbolInput: symbol, symbol: normalizedSymbol, normalizedSymbol, endpoint, type: 'execution', price: Number.isFinite(mid) ? mid : (Number.isFinite(ask) ? ask : bid), bid, ask, mid, suggestedBuyLimit: ask, suggestedSellLimit: bid, tickSize, tickSource: Number.isFinite(tickSize) ? 'binance-exchangeInfo' : undefined, timestamp: response?.time, raw: response };
        }
        const result = { provider: 'binance-usdm', symbolInput: symbol, symbol: normalizedSymbol, normalizedSymbol, endpoint, type: 'book', price: Number.isFinite(mid) ? mid : (Number.isFinite(ask) ? ask : bid), bid, bidQty: Number(response?.bidQty), ask, askQty: Number(response?.askQty), mid, tickSize, tickSource: Number.isFinite(tickSize) ? 'binance-exchangeInfo' : undefined, timestamp: response?.time, raw: response };
        return result;
      }

      await this.ensureReady();
      const mapped = this.mapSymbol(symbol);
      if (!mapped || typeof this.exchange.fetchTicker !== 'function') return null;
      const t = await this.exchange.fetchTicker(mapped);
      let quote = await this._parseQuoteFromTicker(mapped, t, true, symbol);
      if (quote && Number(quote.tickSize) === 0.01 && this._isBinanceUsdmLike()) {
        const realTick = await this._getBinanceTickSizeForQuote(symbol);
        if (Number.isFinite(realTick) && realTick > 0) quote = { ...quote, tickSize: realTick, tickSource: 'binance-exchangeInfo' };
        else { const q2 = { ...quote }; delete q2.tickSize; delete q2.tickSource; quote = q2; }
      }
      if (quote) this._tickerCache.set(mapped, quote);
      return quote || null;
    } catch (err) {
      console.error(`[${this.provider}] getQuote:error`, {
        provider: this.provider,
        stage: 'getQuote:error',
        symbolInput: symbol,
        normalizedSymbol,
        endpoint,
        isPublicRequest: true,
        hasTimestamp: false,
        hasSignature: false,
        ccxtSymbol,
        message: err?.message || String(err),
        name: err?.name
      });
      return null;
    }
  }

  async forgetQuote(symbol) {
    const mapped = this.mapSymbol(symbol);
    if (!mapped) return;
    this._tickerCache.delete(mapped);
    this._stopTickerTask(mapped);
  }

  async getHistoricBars({ symbol, timeframe = 'M1', limit = 50 } = {}) {
    try {
      await this.ensureReady();
      if (!symbol) return [];
      const mapped = this.mapSymbol(symbol);
      if (!mapped) return [];
      const tf = this._normalizeTimeframe(timeframe || 'M1');
      if (!tf) return [];
      const lim = Number.isFinite(Number(limit)) ? Number(limit) : 50;
      const bars = await this.exchange.fetchOHLCV(mapped, tf, undefined, lim);
      if (!Array.isArray(bars)) return [];
      return bars
        .map((b) => ({
          time: Number(b?.[0]),
          open: Number(b?.[1]),
          high: Number(b?.[2]),
          low: Number(b?.[3]),
          close: Number(b?.[4]),
          vol: Number(b?.[5])
        }))
        .filter(b => Number.isFinite(b.time));
    } catch {
      return [];
    }
  }
}

module.exports = { CCXTExecutionAdapter };
