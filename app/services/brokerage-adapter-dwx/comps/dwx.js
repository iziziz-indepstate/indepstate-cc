// services/brokerage-adapter-dwx/comps/dwx.js
const { ExecutionAdapter } = require('../../brokerage/comps/base');

const { dwx_client } = require('./dwx_client');
const { EventEmitter } = require('events');
const crypto = require('crypto');

class DWXAdapter extends ExecutionAdapter {
  /**
   * cfg: {
   *   provider?: 'dwx-mt5',
   *   metatraderDirPath: string,
   *   verbose?: boolean,
   *   event_handler?: { ... }    // ваши внешние колбэки (необязательно)
   * }
   */
  constructor(cfg) {
    super();
    if (!cfg?.metatraderDirPath) throw new Error('[DWXAdapter] metatraderDirPath is required');

    this.cfg = {
      openOrderRetryDelayMs: cfg?.openOrderRetryDelayMs ?? 500,
    };

    this.provider = cfg.provider || 'dwx-mt5';
    this.verbose = !!cfg.verbose;

    // Внутренний эмиттер для подтверждений
    this.events = new EventEmitter();

    // Оборачиваем внешний handler, чтобы ловить события и мы, и вы
    const userHandler = cfg.event_handler || {};
    const self = this;

    const internalHandler = {
      on_order_event() {
        // Снимем подтверждения по DWX_Orders.txt
        self.#reconcilePendingWithOpenOrders();
        // Пробросим наружу
        userHandler.on_order_event?.();
      },
      on_message(msg) {
        // Попробуем вытащить cid из message/comment и подтвердить/завернуть
        self.#consumeMessage(msg);
        userHandler.on_message?.(msg);
      },
      on_tick: (...a) => userHandler.on_tick?.(...a),
      on_bar_data: (...a) => userHandler.on_bar_data?.(...a),
      on_historic_data(symbol, timeframe, data) {
        self.events.emit('dwx:historic_data', { symbol, timeframe, data });
        userHandler.on_historic_data?.(symbol, timeframe, data);
      },
      on_historic_trades() {
        // при появлении новых исторических сделок проверим закрытие позиций
        self.events.emit('dwx:historic_trades');
        self.#reconcilePendingWithOpenOrders();
        userHandler.on_historic_trades?.();
      },
    };

    this.client = new dwx_client({
      metatrader_dir_path: cfg.metatraderDirPath,
      verbose: this.verbose,
      event_handler: internalHandler,
    });

    // Python-логика: при наличии handler надо дернуть start()
    this.client.start();

    // pending: cid -> { order, order_type, createdAt, cycles }
    this.pending = new Map();
    // для дельты открытых ордеров
    this._lastTickets = new Set();
    // мета-информация по тикетам: open_time, profit и т.п.
    this._ticketMeta = new Map();
    // symbols we have subscribed to for market data
    this._subscribedSymbols = new Set();
    this._historicTradesRequestChain = Promise.resolve();
    this._historicBarsRequestChain = Promise.resolve();
  }

  /**
   * Подписка на внутренние события адаптера (подтверждения для UI)
   * - 'order:confirmed' ({pendingId, ticket, mtOrder, origOrder})
   * - 'order:rejected'  ({pendingId, reason, msg, origOrder})
   */
  on(event, fn) { this.events.on(event, fn); return () => this.events.off(event, fn); }

  /**
   * normalized order -> отправка в DWX, возвращаем enqueued + pendingId
   */
  async placeOrder(order) {
    const reason = validate(order);
    if (reason) return { status: 'rejected', provider: this.provider, reason, raw: { order } };

    // берём cid из заказа (если есть) или генерируем свой и проставляем его в comment
    let cid = '';
    if (order?.meta?.cid) {
      cid = String(order.meta.cid).trim();
    } else if (order?.clientOrderId) {
      cid = String(order.clientOrderId).trim();
    }
    if (!cid) cid = randomId();
    if (!order.meta) order.meta = {};
    order.meta.cid = cid;
    const comment = appendCidToComment(order.comment, cid);
    order.commentWithCid = comment;

    // маппинг типа
    let order_type = order.side;
    if (order.type === 'limit') order_type = order.side === 'buy' ? 'buylimit' : 'selllimit';
    else if (order.type === 'stop') order_type = order.side === 'buy' ? 'buystop' : 'sellstop';

    // начнём отслеживать pending до отправки, чтобы не пропустить ранние сообщения
    this.#trackPending(cid, order, order_type);
    this.#sendOrder(order, order_type).catch((e) => {
      this.#rejectPending(cid, e?.message || String(e), e?.message || String(e));
    });

    return {
      status: 'ok',
      provider: this.provider,
      providerOrderId: `pending:${cid}`,
      raw: { enqueued: true, cid },
    };

  }

  /** ---------- внутреннее ---------- */
  async #sendOrder(order, order_type) {
    let sl = 0.0;
    let tp = 0.0;
    const price = Number(order.price);
    const tickSize = Number(order.tickSize);
    const slPts = Number(order.sl);
    const tpPts = Number(order.tp);
    const canPriceProtection = Number.isFinite(price)
      && Number.isFinite(tickSize)
      && tickSize > 0;

    if (canPriceProtection) {
      if (Number.isFinite(tpPts) && tpPts > 0) {
        tp = order.side === 'buy'
          ? price + (tpPts * tickSize)
          : price - (tpPts * tickSize);
      }
      if (Number.isFinite(slPts) && slPts > 0) {
        sl = order.side === 'buy'
          ? price - (slPts * tickSize)
          : price + (slPts * tickSize);
      }
    }

    await this.client.open_order(
      order.symbol,
      order_type,
      order.qty,
      Number.isFinite(price) ? price : 0,
      sl,
      tp,
      order.magic ?? 0,
      order.commentWithCid ?? order.comment ?? '',
      order.expiration ?? 0
    );
  }

  stopOpenOrder(cid) {
    this.#cancelPending(cid);
  }

  #cancelPending(cid) {
    const p = this.pending.get(cid);
    if (!p) return;
    this.pending.delete(cid);
  }

  async cancelOrder(ticket) {
    const t = String(ticket || '').trim();
    if (!t) {
      return { status: 'error', provider: this.provider, reason: 'ticket required' };
    }
    try {
      await this.client.close_order(t, 0);
      return { status: 'ok', provider: this.provider };
    } catch (err) {
      return { status: 'error', provider: this.provider, reason: err?.message || String(err) };
    }
  }

  #trackPending(cid, order, order_type) {
    this.pending.set(cid, {
      order,
      order_type,
      createdAt: Date.now(),
      cycles: 0,
      retryEnabled: order?.meta?.retry !== false
    });
  }

  async #retryOrder(cid) {
    const p = this.pending.get(cid);
    if (!p) return;
    await new Promise(r => setTimeout(r, this.cfg.openOrderRetryDelayMs));
    try {
      p.cycles++;
      this.events.emit('order:retry', { pendingId: cid, count: p.cycles });
      await this.#sendOrder(p.order, p.order_type);
    } catch (e) {
      this.#rejectPending(cid, e?.message || String(e));
    }
  }

  #confirmPending(cid, ticket, mtOrder) {
    const p = this.pending.get(cid);
    if (!p) return;
    this.pending.delete(cid);
    this.events.emit('order:confirmed', { pendingId: cid, ticket: String(ticket ?? ''), mtOrder, origOrder: p.order });
  }

  #rejectPending(cid, reason, msg) {
    const p = this.pending.get(cid);
    if (!p) return;
    this.pending.delete(cid);
    this.events.emit('order:rejected', { pendingId: cid, reason: reason || 'Unknown', msg, origOrder: p.order });
  }

  #consumeMessage(msg) {
    // Форматы на MQL стороне бывают разные. Ищем cid в явном поле или в comment/строке.
    const asStr = typeof msg === 'string' ? msg : JSON.stringify(msg);
    const cid = extractCid(asStr);
    if (cid && this.pending.has(cid)) {
      // Ошибка OPEN_ORDER → ретрай; INFO/OK → попробуем вытащить ticket и подтвердить.
      const isError = msg?.type === 'ERROR' && msg?.error_type === 'OPEN_ORDER';
      if (isError) {
        const pending = this.pending.get(cid);
        if (pending?.retryEnabled === false) {
          this.#rejectPending(cid, msg?.message || msg?.reason || 'OPEN_ORDER rejected', msg);
        } else {
          this.#retryOrder(cid);
        }
      } else {
        const ticket = msg?.ticket ?? (asStr.match(/ticket\\D+(\\d+)/i)?.[1]);
        this.#confirmPending(cid, ticket, undefined);
      }
    }
  }

  #reconcilePendingWithOpenOrders() {
    const nowTickets = new Set(Object.keys(this.client.open_orders || {}));
    const newTickets = [...nowTickets].filter(t => !this._lastTickets.has(t));
    const removedTickets = [...this._lastTickets].filter(t => !nowTickets.has(t));

    // обновляем информацию по текущим ордерам
    for (const t of nowTickets) {
      const ord = this.client.open_orders[t];
      if (!ord) continue;
      let meta = this._ticketMeta.get(t);
      if (!meta) {
        meta = {
          initialOpenTime: ord.open_time,
          lastOpenTime: ord.open_time,
          profit: ord.pnl,
          opened: false,
        };
        this._ticketMeta.set(t, meta);
      } else {
        if (!meta.opened && ord.open_time !== meta.initialOpenTime) {
          meta.opened = true;
          this.events.emit('position:opened', { ticket: t, order: ord });
        }
        meta.lastOpenTime = ord.open_time;
        meta.profit = ord.pnl;
      }
    }

    if (newTickets.length) {
      for (const t of newTickets) {
        const ord = this.client.open_orders[t];
        if (!ord) continue;
        const cid = extractCid(ord.comment || '');
        if (cid && this.pending.has(cid)) {
          this.#confirmPending(cid, t, ord);
        } else {
          const hitCid = findHeuristicMatchCid(this.pending, ord);
          if (hitCid) this.#confirmPending(hitCid, t, ord);
        }
      }
    }

    if (removedTickets.length) {
      for (const t of removedTickets) {
        const meta = this._ticketMeta.get(t) || {};
        const profit = meta.profit;
        this._ticketMeta.delete(t);
        if (typeof profit === 'number' && profit !== 0) {
          this.events.emit('position:closed', { ticket: t, trade: { profit } });
        } else {
          this.events.emit('order:cancelled', { ticket: t });
        }
      }
    }

    this._lastTickets = nowTickets;
  }

  async getQuote(symbol) {
    symbol = String(symbol || '').trim();
    if (!symbol) return null;
    if (!this._subscribedSymbols.has(symbol)) {
      this._subscribedSymbols.add(symbol);
      try { await this.client.subscribe_symbols([...this._subscribedSymbols]); } catch {}
    }
    const md = this.client.market_data?.[symbol];
    if (!md) return null;
    const bid = Number(md.bid);
    const ask = Number(md.ask);
    let price;
    if (Number.isFinite(bid) && Number.isFinite(ask)) price = (bid + ask) / 2;
    else if (Number.isFinite(bid)) price = bid;
    else if (Number.isFinite(ask)) price = ask;
    const tickSize = undefined;
    return { bid, ask, price, tickSize };
  }

  async forgetQuote(symbol) {
    symbol = String(symbol || '').trim();
    if (!symbol) return;
    if (this._subscribedSymbols.delete(symbol)) {
      try { await this.client.subscribe_symbols([...this._subscribedSymbols]); } catch {}
    }
  }

  async listOpenOrders() {
    return Object.values(this.client.open_orders || {});
  }

  async findClosedTradeByCid(cid, lookbackDays = 30, timeoutMs = 2000) {
    if (!cid) return null;
    let timer;
    const trades = await new Promise(resolve => {
      const handler = () => {
        clearTimeout(timer);
        this.events.off('dwx:historic_trades', handler);
        resolve(Object.values(this.client.historic_trades || {}));
      };
      timer = setTimeout(() => {
        this.events.off('dwx:historic_trades', handler);
        resolve(Object.values(this.client.historic_trades || {}));
      }, timeoutMs);
      this.events.on('dwx:historic_trades', handler);
      try { this.client.get_historic_trades(lookbackDays); } catch {}
    });
    if (!trades.length) return null;
    trades.sort((a, b) => parseDealTime(a?.deal_time) - parseDealTime(b?.deal_time));
    const tIn = trades.find(t => includesCid(t?.comment, cid) && normalizeEntry(t?.entry) === 'in');
    if (!tIn) return null;
    const tOut = trades.find(
      t => normalizeEntry(t?.entry) === 'out'
        && t?.symbol === tIn.symbol
        && parseDealTime(t?.deal_time) >= parseDealTime(tIn.deal_time)
    );
    return tOut ? { ...tOut, entry: tIn } : null;
  }

  async listClosedPositions() {
    return Object.values(this.client.historic_trades || {});
  }

  async getDealsHistory({ from, to = new Date(), filters = {}, timeoutMs = 5000 } = {}) {
    const fromDate = coerceDate(from, 'from');
    const toDate = coerceDate(to, 'to');
    if (toDate.getTime() < fromDate.getTime()) {
      throw new Error('to must be greater than or equal to from');
    }

    const lookbackDays = calculateLookbackDays(fromDate, new Date());
    const trades = await requestHistoricTradesSerialized(this, lookbackDays, timeoutMs);
    return filterDwxDeals(trades, { from: fromDate, to: toDate, filters });
  }

  async getHistoricBars({ symbol, timeframe = 'M1', from, to, limit = 5000, timeoutMs = 5000 } = {}) {
    const normalizedSymbol = String(symbol || '').trim();
    if (!normalizedSymbol) throw new Error('symbol is required');
    const normalizedTimeframe = String(timeframe || 'M1').trim().toUpperCase();
    const fromDate = coerceDate(from, 'from');
    const toDate = coerceDate(to, 'to');
    if (toDate.getTime() < fromDate.getTime()) {
      throw new Error('to must be greater than or equal to from');
    }

    const data = await requestHistoricBarsSerialized(this, {
      symbol: normalizedSymbol,
      timeframe: normalizedTimeframe,
      from: fromDate,
      to: toDate,
      timeoutMs
    });
    return filterDwxBars(data, {
      from: fromDate,
      to: toDate,
      limit,
      symbol: normalizedSymbol,
      timeframe: normalizedTimeframe
    });
  }
}

/** ---------- helpers ---------- */

function validate(o = {}) {
  if (!o.symbol) return 'symbol is required';
  if (!['buy', 'sell'].includes(o.side)) return 'side must be buy|sell';
  if (!['market', 'limit', 'stop'].includes(o.type)) return 'type must be market|limit|stop';
  if ((o.type === 'limit' || o.type === 'stop') && typeof o.price !== 'number') return 'price is required for limit/stop';
  if (typeof o.qty !== 'number' || o.qty <= 0) return 'volume must be > 0';
  return null;
}

function randomId() { return crypto.randomBytes(6).toString('hex'); }

function appendCidToComment(comment, cid) {
  const c = (comment || '').trim();
  if (!cid) return c;
  if (includesCid(c, cid)) return c;
  if (/cid[:=]\s*[a-f0-9]+/i.test(c)) {
    return c.replace(/cid[:=]\s*[a-f0-9]+/i, `cid:${cid}`);
  }
  return c ? `${c} | cid:${cid}` : `cid:${cid}`;
}

function extractCid(s) {
  const m = String(s).match(/cid[:=]\s*([a-f0-9]{8,})/i);
  return m ? m[1] : null;
}

function includesCid(comment, cid) {
  return String(comment || '').includes(cid);
}

function normalizeEntry(entry) {
  const e = String(entry || '').toLowerCase();
  if (e === 'in' || e === 'entry_in') return 'in';
  if (e === 'out' || e === 'entry_out') return 'out';
  return e;
}

function parseDealTime(s) {
  if (!s) return 0;
  if (typeof s === 'number') return s;
  const [datePart, timePart] = String(s).split(' ');
  if (!datePart || !timePart) return 0;
  const [y, m, d] = datePart.split('.').map(Number);
  const [H, M, S] = timePart.split(':').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1, H || 0, M || 0, S || 0);
  return dt.getTime();
}

function coerceDate(value, name) {
  const date = value instanceof Date ? value : new Date(String(value || ''));
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${name} must be a valid date`);
  }
  return date;
}

function calculateLookbackDays(from, now = new Date()) {
  const diffMs = now.getTime() - coerceDate(from, 'from').getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 1;
  return Math.max(1, Math.ceil(diffMs / 86400000));
}

async function requestHistoricTradesSerialized(adapter, lookbackDays, timeoutMs = 5000) {
  const previous = adapter._historicTradesRequestChain || Promise.resolve();
  const next = previous.catch(() => {}).then(() => requestHistoricTrades(adapter, lookbackDays, timeoutMs));
  adapter._historicTradesRequestChain = next.catch(() => {});
  return next;
}

async function requestHistoricTrades(adapter, lookbackDays, timeoutMs = 5000) {
  let timer;
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      adapter.events?.off?.('dwx:historic_trades', done);
      resolve(Object.values(adapter.client?.historic_trades || {}));
    };

    timer = setTimeout(done, Math.max(1, Number(timeoutMs) || 5000));
    adapter.events?.on?.('dwx:historic_trades', done);
    try {
      adapter.client?.get_historic_trades?.(lookbackDays);
    } catch {
      done();
    }
  });
}

async function requestHistoricBarsSerialized(adapter, args) {
  const previous = adapter._historicBarsRequestChain || Promise.resolve();
  const next = previous.catch(() => {}).then(() => requestHistoricBars(adapter, args));
  adapter._historicBarsRequestChain = next.catch(() => {});
  return next;
}

async function requestHistoricBars(adapter, { symbol, timeframe, from, to, timeoutMs = 5000 } = {}) {
  const key = `${symbol}_${timeframe}`;
  const start = Math.floor(coerceDate(from, 'from').getTime() / 1000);
  const end = Math.floor(coerceDate(to, 'to').getTime() / 1000);
  let timer;
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      adapter.events?.off?.('dwx:historic_data', onHistoricData);
      resolve(adapter.client?.historic_data?.[key] || {});
    };
    const onHistoricData = (event = {}) => {
      if (event.symbol === symbol && String(event.timeframe || '').toUpperCase() === timeframe) {
        done();
      }
    };

    timer = setTimeout(done, Math.max(1, Number(timeoutMs) || 5000));
    adapter.events?.on?.('dwx:historic_data', onHistoricData);
    try {
      adapter.client?.get_historic_data?.({ symbol, time_frame: timeframe, start, end });
    } catch {
      done();
    }
  });
}

function filterDwxBars(data, { from, to, limit = 5000 } = {}) {
  const fromMs = coerceDate(from, 'from').getTime();
  const toMs = coerceDate(to, 'to').getTime();
  const lim = clampPositiveInt(limit, 5000, 5000);
  return Object.entries(data || {})
    .map(([time, raw]) => normalizeDwxBar(time, raw))
    .filter(bar => {
      if (!bar) return false;
      const barMs = new Date(bar.time).getTime();
      return Number.isFinite(barMs) && barMs >= fromMs && barMs <= toMs;
    })
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
    .slice(0, lim);
}

function normalizeDwxBar(time, raw = {}) {
  const timeMs = parseBarTime(time);
  const open = numberOr(raw.open);
  const high = numberOr(raw.high);
  const low = numberOr(raw.low);
  const close = numberOr(raw.close);
  if (!timeMs || ![open, high, low, close].every(Number.isFinite)) return null;

  const bar = {
    time: new Date(timeMs).toISOString(),
    open,
    high,
    low,
    close,
    raw
  };
  const volume = numberOr(raw.volume, raw.tick_volume, raw.real_volume);
  if (Number.isFinite(volume)) bar.volume = volume;
  return bar;
}

function parseBarTime(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0;
    return value < 100000000000 ? value * 1000 : value;
  }
  const s = String(value || '').trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return parseBarTime(Number(s));
  const parsed = new Date(s).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampPositiveInt(value, fallback, max) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

function filterDwxDeals(trades, { from, to, filters = {} } = {}) {
  const fromMs = coerceDate(from, 'from').getTime();
  const toMs = coerceDate(to, 'to').getTime();
  return Object.values(trades || {})
    .map(normalizeDwxDeal)
    .filter(deal => {
      const dealMs = deal.dealTime ? new Date(deal.dealTime).getTime() : 0;
      if (!Number.isFinite(dealMs) || dealMs < fromMs || dealMs > toMs) return false;
      return matchesDwxDealFilters(deal, filters);
    });
}

function normalizeDwxDeal(raw = {}) {
  const dealTimeMs = parseDealTime(raw.deal_time || raw.dealTime || raw.time);
  return {
    ticket: valueOr(raw.ticket, raw.order, raw.position_id, raw.deal),
    magic: valueOr(raw.magic, raw.magic_number),
    symbol: raw.symbol,
    lots: numberOr(raw.lots, raw.volume, raw.volume_initial),
    type: normalizeType(raw.type),
    entry: normalizeEntry(raw.entry),
    dealTime: dealTimeMs ? new Date(dealTimeMs).toISOString() : undefined,
    dealPrice: numberOr(raw.deal_price, raw.price, raw.open_price),
    pnl: numberOr(raw.pnl, raw.profit),
    commission: numberOr(raw.commission),
    swap: numberOr(raw.swap),
    comment: raw.comment,
    raw
  };
}

function matchesDwxDealFilters(deal, filters = {}) {
  if (filters.symbol && String(deal.symbol || '').toUpperCase() !== String(filters.symbol).toUpperCase()) return false;
  if (filters.magic != null && String(deal.magic ?? '') !== String(filters.magic)) return false;
  if (filters.type && String(deal.type || '').toLowerCase() !== String(filters.type).toLowerCase()) return false;
  if (filters.entry && String(deal.entry || '').toLowerCase() !== String(filters.entry).toLowerCase()) return false;
  if (filters.commentContains) {
    const haystack = String(deal.comment || '').toLowerCase();
    const needle = String(filters.commentContains).toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function normalizeType(value) {
  const type = String(value || '').toLowerCase();
  if (type.includes('buy')) return 'buy';
  if (type.includes('sell')) return 'sell';
  return type;
}

function valueOr(...values) {
  return values.find(v => v != null && v !== '');
}

function numberOr(...values) {
  const value = valueOr(...values);
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function findHeuristicMatchCid(pendingMap, mtOrder) {
  // Подбираем pending, который максимально похож
  const entries = [...pendingMap.entries()];
  const score = (p, o) => {
    let s = 0;
    if (p.order.symbol === o.symbol) s += 3;
    if (p.order.volume && roughlyEqual(p.order.volume, o.lots, 1e-4)) s += 2;
    if (p.order.side && sideMatches(p.order.side, o.type)) s += 2;
    if (p.order.price && roughlyEqual(p.order.price, o.open_price, 1e-4)) s += 1;
    if (p.order.sl && roughlyEqual(p.order.sl, o.sl, 1e-4)) s += 0.5;
    if (p.order.tp && roughlyEqual(p.order.tp, o.tp, 1e-4)) s += 0.5;
    return s;
  };
  let best = null;
  for (const [cid, p] of entries) {
    const sc = score(p, mtOrder);
    if (best === null || sc > best.sc) best = { cid, sc };
  }
  return best && best.sc >= 5 ? best.cid : null; // порог
}

function sideMatches(side, mtType) {
  const t = String(mtType).toLowerCase();
  if (side === 'buy') return t.includes('buy');
  if (side === 'sell') return t.includes('sell');
  return false;
}

function roughlyEqual(a, b, eps) {
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) <= (eps ?? 1e-6);
}

module.exports = {
  DWXAdapter,
  calculateLookbackDays,
  filterDwxBars,
  filterDwxDeals,
  normalizeDwxBar,
  normalizeDwxDeal,
  parseDealTime
};
