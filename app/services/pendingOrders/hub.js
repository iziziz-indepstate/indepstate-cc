const fs = require('fs');
const path = require('path');
const events = require('../events');
const { PendingOrderService } = require('./service');
const { createStrategyFactory } = require('./factory');
const servicesApi = require('../servicesApi');
const tradeRules = require('../tradeRules');
const orderCalc = servicesApi.orderCalculator || require('../orderCalculator');
const { resolveProvider: defaultResolveProvider } = require('../brokerage/providerResolver');
const { createInstrumentInfoService } = require('../instrumentInfo');
const { validationError } = require('../../application/previewContract');

const userData = require('electron')?.app?.getPath('userData') || path.join(__dirname, '..', '..');
const LOG_DIR = path.join(userData, 'logs');
const EXEC_LOG = path.join(LOG_DIR, 'executions.jsonl');

function nowTs() { return Date.now(); }

function rejectedPendingPreview({ provider, pending, reason, errors, quote, instrument } = {}) {
  return {
    ok: false,
    status: 'rejected',
    ...(provider ? { provider } : {}),
    ...(pending ? { pending } : {}),
    reason,
    errors,
    ...(quote !== undefined ? { quote } : {}),
    ...(instrument ? { instrument } : {})
  };
}

function pendingOrderOptions(pending, runtime = {}) {
  return {
    price: pending.price,
    side: pending.side,
    strategy: pending.strategy,
    tickSize: pending.tickSize,
    stopOffsetPts: pending.meta?.stopPts,
    bars: pending.bars,
    priceSource: pending.priceSource,
    historyBars: pending.historyBars,
    historyTimeframe: pending.historyTimeframe,
    historyLoader: runtime.historyLoader,
    getQuote: runtime.getQuote,
    symbol: pending.symbol
  };
}

function pendingStrategyParams(options) {
  const params = { price: options.price, side: options.side };
  for (const field of [
    'tickSize',
    'bars',
    'stopOffsetPts',
    'priceSource',
    'historyBars',
    'historyTimeframe',
    'historyLoader',
    'getQuote',
    'symbol'
  ]) {
    if (options[field] != null) params[field] = options[field];
  }
  return params;
}

function appendJsonl(file, obj) {
  try { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); }
  catch (e) { console.error('appendJsonl error:', e); }
}

const TF_SECONDS = {
  M1: 60,
  M5: 300,
  M15: 900,
  M30: 1800,
  H1: 3600,
  H4: 14400,
  D1: 86400
};

async function waitFor(fn, attempts = 10, delay = 100) {
  for (let i = 0; i < attempts; i++) {
    const value = fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  return fn();
}

async function fetchAdapterHistory(adapter, symbol, timeframe = 'M1', limit = 15) {
  if (!adapter || !symbol) return [];
  if (typeof adapter.getHistoricBars === 'function') {
    try {
      const res = await adapter.getHistoricBars({ symbol, timeframe, limit });
      return Array.isArray(res) ? res : [];
    } catch (err) {
      console.error('pending: getHistoricBars failed', err);
      return [];
    }
  }
  const client = adapter?.client;
  if (!client || typeof client.get_historic_data !== 'function') return [];
  const seconds = TF_SECONDS[timeframe] || TF_SECONDS.M1;
  const end = Math.floor(Date.now() / 1000);
  const start = end - seconds * Math.max(5, limit + 5);
  try {
    await client.get_historic_data({ symbol, time_frame: timeframe, start, end });
  } catch (err) {
    console.error('pending: get_historic_data failed', err);
    return [];
  }
  const key = `${symbol}_${timeframe}`;
  const data = await waitFor(() => client.historic_data?.[key], 10, 100);
  if (!data) return [];
  return Object.entries(data)
    .map(([time, o]) => ({
      time: Number(time),
      open: Number(o?.open),
      high: Number(o?.high),
      low: Number(o?.low),
      close: Number(o?.close)
    }))
    .filter(b => Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.close))
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

class PendingOrderHub {
  constructor({ strategies = {}, strategyConfig, subscribe, queuePlaceOrder, wireAdapter, mainWindow, getAdapter, resolveProvider, instrumentInfo } = {}) {
    this.strategies = strategies;
    this.subscribe = subscribe;
    this.createStrategy = createStrategyFactory(strategyConfig, strategies);
    this.services = new Map(); // key: provider:symbol -> service
    this.subscriptions = new Map(); // provider -> Set(symbol)
    this.pendingIndex = new Map(); // pendingId -> { reqId, provider, symbol, side }
    if (typeof queuePlaceOrder !== 'function') {
      throw new Error('queuePlaceOrder callback required');
    }
    this.queuePlaceOrder = queuePlaceOrder;
    this.wireAdapter = wireAdapter;
    this.mainWindow = mainWindow;
    this.getAdapter = getAdapter || servicesApi.brokerage?.getAdapter;
    this.resolveProvider = resolveProvider || servicesApi.brokerage?.resolveProvider || defaultResolveProvider;
    this.instrumentInfo = instrumentInfo || servicesApi.instrumentInfo || createInstrumentInfoService({
      brokerage: {
        getAdapter: this.getAdapter,
        resolveProvider: this.resolveProvider
      }
    });

    events.on('bar', ({ provider, symbol, tf, open, high, low, close, time, timestamp }) => {
      if (tf !== 'M1') return;
      const svc = this.services.get(`${provider}:${symbol}`);
      const barTime = time ?? timestamp;
      if (svc) svc.onBar({ open, high, low, close, time: barTime });
    });
  }

  configureStrategies(strategyConfig) {
    this.createStrategy = createStrategyFactory(strategyConfig, this.strategies);
    for (const service of this.services.values()) {
      service.configureStrategies(this.createStrategy);
    }
  }

  ensureService(provider, symbol) {
    const key = `${provider}:${symbol}`;
    let svc = this.services.get(key);
    if (!svc) {
      svc = new PendingOrderService({ createStrategy: this.createStrategy });
      this.services.set(key, svc);
    }
    const subs = this.subscriptions.get(provider) || new Set();
    if (!subs.has(symbol)) {
      subs.add(symbol);
      this.subscriptions.set(provider, subs);
      try { this.subscribe?.(provider, [...subs]); } catch {}
    }
    return svc;
  }

  addOrder(provider, symbol, opts) {
    const svc = this.ensureService(provider, symbol);
    const localId = svc.addOrder(opts);
    return `${provider}:${symbol}:${localId}`;
  }

  previewPlacePending(payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      const reason = 'Invalid pending order payload';
      return rejectedPendingPreview({
        reason,
        errors: [validationError('INVALID_PAYLOAD', 'pending', reason)]
      });
    }

    const symbol = String(payload.ticker || payload.symbol || '').trim();
    const price = Number(payload.price);
    const side = String(payload.side || '').trim().toLowerCase();
    const strategy = payload.strategy == null
      ? 'consolidation'
      : String(payload.strategy).trim();
    const pending = {
      ...payload,
      symbol,
      ticker: symbol,
      price,
      side,
      strategy,
      meta: payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta)
        ? { ...payload.meta }
        : {}
    };

    const errors = [];
    if (!symbol) errors.push(validationError('SYMBOL_REQUIRED', 'symbol', 'Symbol required'));
    if (!Number.isFinite(price) || price <= 0) {
      errors.push(validationError('INVALID_PRICE', 'price', 'Price must be greater than 0'));
    }
    if (side !== 'long' && side !== 'short') {
      errors.push(validationError('INVALID_SIDE', 'side', 'Side must be long or short'));
    }
    if (!strategy) errors.push(validationError('STRATEGY_REQUIRED', 'strategy', 'Strategy required'));
    if (errors.length) {
      return rejectedPendingPreview({ pending, reason: errors[0].message, errors });
    }

    let providerName;
    try {
      const resolution = this.resolveProvider({
        provider: pending.provider,
        payload: pending,
        symbol,
        instrumentType: pending.instrumentType,
        meta: pending.meta
      });
      providerName = String(resolution?.provider || '').trim().toLowerCase();
      if (!providerName) throw new Error('Provider resolution returned no provider');
      pending.provider = providerName;
    } catch (err) {
      const reason = err?.message || 'Provider resolution failed';
      return rejectedPendingPreview({
        pending,
        reason,
        errors: [validationError('PROVIDER_RESOLUTION_FAILED', 'provider', reason)]
      });
    }

    try {
      const options = pendingOrderOptions(pending, { getQuote: async () => null });
      const strategyInstance = this.createStrategy(options.strategy, pendingStrategyParams(options));
      if (!strategyInstance || typeof strategyInstance.onBar !== 'function') {
        throw new Error(`Invalid pending strategy: ${strategy}`);
      }
    } catch (err) {
      const reason = err?.message || 'Pending strategy could not be constructed';
      return rejectedPendingPreview({
        provider: providerName,
        pending,
        reason,
        errors: [validationError('INVALID_STRATEGY', 'strategy', reason)]
      });
    }

    return {
      ok: true,
      status: 'ok',
      provider: providerName,
      pending,
      errors: []
    };
  }

  queuePlacePending(payload = {}) {
    const preview = this.previewPlacePending(payload);
    if (!preview.ok) return preview;

    const pending = preview.pending;
    const symbol = pending.symbol;
    const providerName = preview.provider;
    const adapter = this.getAdapter(providerName);
    try { this.wireAdapter?.(adapter, providerName); } catch {}

    const ts = nowTs();
    const reqId = pending.meta?.requestId || `${ts}_${Math.random().toString(36).slice(2,8)}`;
    pending.meta.requestId = reqId;
    if (!payload.meta || typeof payload.meta !== 'object' || Array.isArray(payload.meta)) payload.meta = {};
    payload.meta.requestId = reqId;

    const historyBars = pending.historyBars;
    const historyTimeframe = pending.historyTimeframe;
    const historyLoader = adapter
      ? async ({ limit, timeframe } = {}) => fetchAdapterHistory(
        adapter,
        symbol,
        timeframe || historyTimeframe || 'M1',
        Math.max(1, Number(limit) || Number(historyBars) || 15)
      )
      : null;
    const getInstrumentSnapshot = async (options = {}) => {
      try {
        return await this.instrumentInfo?.get({
          provider: providerName,
          symbol,
          instrumentType: pending.instrumentType,
          payload: pending
        }, options);
      } catch (err) {
        console.error('pending: instrument info failed', err);
        return null;
      }
    };
    const getQuote = adapter
      ? async () => {
        try { return (await getInstrumentSnapshot())?.quote || null; }
        catch (err) {
          console.error('pending: getQuote failed', err);
          return null;
        }
      }
      : async () => null;

    let pendingId;
    try {
      pendingId = this.addOrder(providerName, symbol, {
        ...pendingOrderOptions(pending, { historyLoader, getQuote }),
        onExecute: async ({ limitPrice, stopLoss, takeProfit }) => {
          this.pendingIndex.delete(pendingId);

          const instrumentSnapshot = await getInstrumentSnapshot({ forceQuote: true });
          const effectiveTickSize = this.instrumentInfo?.resolveTickSize(
            { provider: providerName, symbol, instrumentType: pending.instrumentType, payload: pending },
            { explicitTickSize: pending.tickSize }
          ) || instrumentSnapshot?.metadata?.tickSize;

          let stopPts;
          let takePts;
          let qty;
          const risk = Number(pending.meta?.riskUsd);

          if (Number.isFinite(effectiveTickSize) && effectiveTickSize > 0) {
            stopPts = orderCalc.stopPts({
              tickSize: effectiveTickSize,
              symbol,
              entryPrice: limitPrice,
              stopPrice: stopLoss,
              instrumentType: pending.instrumentType
            });
            takePts = orderCalc.takePts(stopPts);
            if (Number.isFinite(risk) && risk > 0) {
              qty = orderCalc.qty({
                riskUsd: risk,
                stopPts,
                tickSize: effectiveTickSize,
                lot: pending.lot,
                instrumentType: pending.instrumentType,
                quantityStep: instrumentSnapshot?.metadata?.quantityStep
              });
            } else {
              qty = Number(pending.meta?.qty || pending.qty || 0);
            }
          } else {
            stopPts = Number(pending.meta?.stopPts ?? pending.sl);
            takePts = Number(pending.meta?.takePts ?? pending.tp);
            qty = Number(pending.meta?.qty || pending.qty || 0);
          }

          const hasStopPts = Number.isFinite(stopPts) && stopPts > 0;
          const stopLossPrice = Number(stopLoss);
          const hasStopLossPrice = Number.isFinite(stopLossPrice) && stopLossPrice > 0;
          if (!hasStopPts && !hasStopLossPrice) {
            throw new Error(`No stop points/stop loss for ${symbol}; cannot execute pending order`);
          }

          const finalPayload = {
            symbol,
            side: pending.side === 'long' ? 'buy' : 'sell',
            type: 'limit',
            price: limitPrice,
            provider: providerName,
            instrumentType: pending.instrumentType,
            tickSize: effectiveTickSize,
            qty,
            sl: hasStopPts ? stopPts : undefined,
            tp: Number.isFinite(takePts) && takePts > 0 ? takePts : undefined,
            stopLossPrice: hasStopPts ? undefined : stopLossPrice,
            takeProfitPrice: Number.isFinite(takePts) && takePts > 0 ? undefined : (Number.isFinite(Number(takeProfit)) ? Number(takeProfit) : undefined),
            meta: {
              ...pending.meta,
              ...(Number(instrumentSnapshot?.metadata?.quantityStep) > 0 ? { quantityStep: Number(instrumentSnapshot.metadata.quantityStep) } : {}),
              riskUsd: Number.isFinite(risk) ? risk : pending.meta?.riskUsd,
              ...(hasStopPts ? { stopPts } : {}),
              ...(Number.isFinite(takePts) && takePts > 0 ? { takePts } : {}),
              ...(!Number.isFinite(effectiveTickSize) || effectiveTickSize <= 0 ? { riskBasedQtyPending: true } : {})
            }
          };
          try {
            await this.queuePlaceOrder(finalPayload);
          } catch (err) {
            console.error('pending order execution failed', err);
          }
        },
        onCancel: () => {
          this.pendingIndex.delete(pendingId);
          appendJsonl(EXEC_LOG, {
            t: nowTs(),
            kind: 'pending-cancelled',
            reqId,
            provider: providerName,
            pendingId,
            order: { symbol, side: pending.side, strategy: pending.strategy }
          });
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('execution:result', {
              status: 'rejected',
              reason: 'trigger not satisfied',
              reqId,
              order: { symbol, side: pending.side, meta: pending.meta }
            });
          }
        }
      });
    } catch (err) {
      const reason = err?.message || String(err);
      const rejected = rejectedPendingPreview({
        provider: providerName,
        pending,
        reason,
        errors: [validationError('PENDING_REGISTRATION_FAILED', 'pending', reason)]
      });
      appendJsonl(EXEC_LOG, {
        t: ts,
        kind: 'pending-rejected',
        reqId,
        provider: providerName,
        order: { symbol, side: pending.side, strategy: pending.strategy },
        result: rejected
      });
      return rejected;
    }

    appendJsonl(EXEC_LOG, {
      t: ts,
      kind: 'place-queued',
      reqId,
      provider: providerName,
      pendingId,
      order: { symbol, side: pending.side, strategy: pending.strategy }
    });

    this.pendingIndex.set(pendingId, { reqId, provider: providerName, symbol, side: pending.side });

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('execution:pending', {
        ts,
        reqId,
        provider: providerName,
        pendingId,
        order: { symbol }
      });
    }

    return { status: 'ok', provider: providerName, providerOrderId: `pending:${pendingId}` };
  }

  cancelPending(pendingId) {
    const rec = this.pendingIndex.get(pendingId);
    if (!rec) return { status: 'not-found' };
    this.pendingIndex.delete(pendingId);
    const [provider, symbol, local] = pendingId.split(':');
    const svc = this.services.get(`${provider}:${symbol}`);
    if (svc) svc.cancelOrder(Number(local));

    appendJsonl(EXEC_LOG, {
      t: nowTs(),
      kind: 'pending-cancelled',
      reqId: rec.reqId,
      provider: rec.provider,
      pendingId,
      order: { symbol: rec.symbol, side: rec.side }
    });

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('execution:result', {
        status: 'cancelled',
        reason: 'cancelled',
        reqId: rec.reqId,
        order: { symbol: rec.symbol, side: rec.side, meta: { requestId: rec.reqId } }
      });
    }
    return { status: 'ok' };
  }
}

function createPendingOrderHub(opts) {
  return new PendingOrderHub(opts);
}

module.exports = { PendingOrderHub, createPendingOrderHub };
