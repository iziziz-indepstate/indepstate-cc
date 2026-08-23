const { detectInstrumentType } = require('../../instruments');
const { PositionCommand } = require('../../../domain/positions');
const { calculateLimitBidTradePlan } = require('../domain/strategy');
const { collectRetryStopEntries, getRetryStopParentIds } = require('../domain/retryStop');
const { generateCid } = require('../../../application/execution/orderPayload');
const {
  buildInstrumentPreview,
  normalizePreviewQuote,
  validationError
} = require('../../../application/previewContract');
const {
  buildLevelOrderIntentKey,
  cloneJson,
  findLevelOrderTerminalTickets
} = require('./levelOrderRuntime');

function rejectedLevelOrderPreview({ provider, reason, errors, quote, instrument } = {}) {
  return {
    ok: false,
    status: 'rejected',
    ...(provider ? { provider } : {}),
    reason,
    errors,
    ...(quote !== undefined ? { quote } : {}),
    ...(instrument ? { instrument } : {})
  };
}

function levelOrderPlanError(reason) {
  const message = reason || 'Invalid level order';
  if (message === 'Unsupported level order action') return validationError('INVALID_ACTION', 'action', message);
  if (message === 'Level > 0 required') return validationError('INVALID_LEVEL', 'level', message);
  if (message === 'Tick size required') return validationError('TICK_SIZE_UNAVAILABLE', 'tickSize', message);
  if (message === 'Risk $ > 0 required') return validationError('INVALID_RISK', 'riskUsd', message);
  if (message === 'Stop offset pts > 0 required') return validationError('INVALID_STOP_OFFSET', 'stopOffsetPts', message);
  if (message === 'Ask quote required') return validationError('QUOTE_UNAVAILABLE', 'quote.ask', message);
  if (message === 'Bid/Ask quote required') return validationError('QUOTE_UNAVAILABLE', 'quote', message);
  if (message === 'Bid quote required') return validationError('QUOTE_UNAVAILABLE', 'quote.bid', message);
  if (message === 'Calculated quantity is 0') return validationError('INVALID_QUANTITY', 'qty', message);
  if (/^Cannot (?:buy|sell) when /.test(message)) return validationError('LEVEL_CONDITION_FAILED', 'level', message);
  return validationError('INVALID_LEVEL_ORDER', 'order', message);
}

class LevelOrderApplicationService {
  constructor({
    getAdapter,
    wireAdapter,
    instrumentInfo,
    orderCalc,
    appendJsonl,
    execLog,
    nowTs = () => Date.now(),
    sendToRenderer = () => {},
    resolveProviderName,
    queuePlaceOrder,
    positions,
    pendingIndex,
    trackerPending,
    levelOrderIntentRegistry,
    runtime
  } = {}) {
    this.getAdapter = getAdapter;
    this.wireAdapter = wireAdapter;
    this.instrumentInfo = instrumentInfo;
    this.orderCalc = orderCalc;
    this.appendJsonl = appendJsonl;
    this.execLog = execLog;
    this.nowTs = nowTs;
    this.sendToRenderer = sendToRenderer;
    this.resolveProviderName = resolveProviderName;
    this.queuePlaceOrder = queuePlaceOrder;
    this.positions = positions;
    this.pendingIndex = pendingIndex || new Map();
    this.trackerPending = trackerPending || new Map();
    this.levelOrderIntentRegistry = levelOrderIntentRegistry || new Map();
    this.runtime = runtime;
  }

  getActiveLevelOrderIntent(intentKey, ttlMs = 10 * 60 * 1000) {
    const rec = this.levelOrderIntentRegistry.get(intentKey);
    if (!rec) return null;
    if (this.nowTs() - Number(rec.updatedAt || 0) > ttlMs) {
      this.levelOrderIntentRegistry.delete(intentKey);
      return null;
    }
    if (['placing', 'unknown', 'partial'].includes(rec.status)) return rec;
    return null;
  }

  async previewLevelOrder(payload = {}) {
    payload = payload && typeof payload === 'object' ? payload : {};
    const symbol = String(payload.ticker || payload.symbol || '').trim();
    const instrumentType = payload.instrumentType || detectInstrumentType(symbol);
    if (!symbol) {
      const reason = 'Symbol required';
      return rejectedLevelOrderPreview({
        reason,
        errors: [validationError('SYMBOL_REQUIRED', 'ticker', reason)]
      });
    }

    let providerName;
    try {
      providerName = this.resolveProviderName({ payload, symbol, instrumentType, meta: payload.meta });
    } catch (err) {
      const reason = err?.message || 'Provider resolution failed';
      return rejectedLevelOrderPreview({
        reason,
        errors: [validationError('PROVIDER_RESOLUTION_FAILED', 'provider', reason)]
      });
    }

    let quote;
    let instrument;
    try {
      const instrumentSnapshot = await this.instrumentInfo.get({ provider: providerName, symbol, instrumentType, payload }, { forceQuote: true });
      quote = normalizePreviewQuote(instrumentSnapshot?.quote);
      const bid = Number(quote?.bid);
      const ask = Number(quote?.ask);
      const tickSize = this.instrumentInfo.resolveTickSize(
        { provider: providerName, symbol, instrumentType, payload },
        { explicitTickSize: payload.tickSize }
      );
      instrument = buildInstrumentPreview(instrumentSnapshot, {
        symbol,
        instrumentType,
        tickSize,
        quantityStep: payload.minLot,
        contractSize: payload.contractSize
      });
      const plan = calculateLimitBidTradePlan({
        action: payload.action,
        ticker: symbol,
        instrumentType,
        level: payload.level,
        riskUsd: payload.riskUsd,
        stopOffsetPts: payload.stopOffsetPts,
        maxLot: payload.maxLot,
        minLot: payload.minLot ?? instrumentSnapshot?.metadata?.quantityStep,
        takeProfitPts: payload.takeProfitPts,
        bid,
        ask,
        buyPriceSource: payload.buyPriceSource,
        sellPriceSource: payload.sellPriceSource,
        tickSize,
        lot: payload.lot || 1,
        orderCalculator: this.orderCalc
      });
      if (!plan.ok) {
        return rejectedLevelOrderPreview({
          provider: providerName,
          reason: plan.reason,
          errors: [levelOrderPlanError(plan.reason)],
          quote,
          instrument
        });
      }

      return {
        ok: true,
        status: 'ok',
        provider: providerName,
        plan,
        errors: [],
        quote,
        instrument
      };
    } catch (err) {
      const reason = err?.message || 'Level order preview failed';
      return rejectedLevelOrderPreview({
        provider: providerName,
        reason,
        errors: [validationError('PREVIEW_FAILED', 'order', reason)],
        quote,
        instrument
      });
    }
  }

  async queueLevelOrder(payload = {}) {
    payload = payload && typeof payload === 'object' ? payload : {};
    const preview = await this.previewLevelOrder(payload);
    if (!preview.ok) {
      this.#append({
        t: this.nowTs(),
        kind: 'level-order',
        valid: false,
        reqId: payload.requestId,
        provider: preview.provider,
        payload,
        quote: preview.quote,
        result: preview
      });
      return preview;
    }

    const symbol = preview.instrument?.symbol || String(payload.ticker || payload.symbol || '').trim();
    const instrumentType = preview.instrument?.instrumentType || payload.instrumentType || detectInstrumentType(symbol);
    const providerName = preview.provider;
    const plan = preview.plan;
    const strategyId = payload.strategyId || generateCid();
    const requestId = payload.requestId || `${this.nowTs()}_${Math.random().toString(36).slice(2, 8)}`;

    try {
      const intentKey = buildLevelOrderIntentKey({ providerName, symbol, instrumentType, payload, plan });
      const existingIntent = this.getActiveLevelOrderIntent(intentKey);
      if (existingIntent) {
        this.#append({
          t: this.nowTs(),
          kind: 'level-order-dedup',
          reqId: requestId,
          provider: providerName,
          strategyId,
          intentKey,
          existingStatus: existingIntent.status
        });
        if (existingIntent.promise) return cloneJson(await existingIntent.promise);
        return cloneJson(existingIntent.result);
      }

      const adapter = this.getAdapter(providerName);
      this.wireAdapter(adapter, providerName);
      const intentRecord = { status: 'placing', updatedAt: this.nowTs(), result: null, promise: null };
      this.levelOrderIntentRegistry.set(intentKey, intentRecord);
      this.positions?.handle?.({
        type: PositionCommand.OPEN,
        positionId: payload.positionId,
        payload: {
          ...payload,
          provider: providerName,
          strategyId,
          requestId,
          instrumentType
        },
        openingPolicy: { kind: 'levelOrder', config: { strategy: 'limitBidTrade' } }
      });
      const placementPromise = (async () => {
        const results = [];
        for (let i = 0; i < plan.childQtys.length; i += 1) {
          const childReqId = `${requestId}_${i + 1}`;
          const childPayload = {
            ticker: symbol,
            event: 'levelOrder',
            price: plan.referencePrice,
            kind: plan.orderKind,
            instrumentType,
            tickSize: plan.tickSize,
            provider: providerName,
            meta: {
              requestId: childReqId,
              qty: plan.childQtys[i],
              stopPts: plan.stopPts,
              takePts: plan.takeProfitPts,
              riskUsd: plan.riskUsd,
              fixedQty: true,
              strategy: 'limitBidTrade',
              strategyId,
              parentRequestId: requestId,
              childIndex: i + 1,
              childCount: plan.childQtys.length,
              level: plan.level,
              bid: plan.bid,
              ask: plan.ask,
              priceSource: plan.priceSource,
              referencePrice: plan.referencePrice,
              stopOffsetPts: plan.stopOffsetPts,
              minLot: plan.minLot,
              quantityStep: plan.minLot,
              pointSize: payload.pointSize,
              stopPrice: plan.stopPrice,
              levelOrderIntentKey: intentKey
            }
          };
          const res = await this.queuePlaceOrder(childPayload);
          results.push({ requestId: childReqId, qty: plan.childQtys[i], result: res });
          this.#recordChildPlacement({
            parentPositionId: payload.positionId,
            parentRequestId: requestId,
            strategyId,
            providerName,
            childPayload,
            childResult: res,
            childCount: plan.childQtys.length
          });
          if (!res || res.status === 'rejected' || res.status === 'error') {
            const accepted = results.filter(item => item.result && item.result.status !== 'rejected' && item.result.status !== 'error');
            const result = accepted.length
              ? {
                  status: 'unknown',
                  provider: providerName,
                  reason: res?.reason || 'Level order child state unknown after partial placement',
                  providerOrderId: `level:${strategyId}`,
                  strategyId,
                  partial: true,
                  raw: { plan, results }
                }
              : {
                  status: 'rejected',
                  provider: providerName,
                  reason: res?.reason || 'Level order child rejected',
                  raw: { plan, results }
                };
            if (accepted.length) {
              this.runtime.startLevelOrderPositionMonitor({
                adapter,
                providerName,
                requestId,
                strategyId,
                symbol,
                children: results
              });
            }
            this.#recordPartialResult({
              parentPositionId: payload.positionId,
              parentRequestId: requestId,
              providerName,
              strategyId,
              plan,
              results,
              result
            });
            this.#append({ t: this.nowTs(), kind: 'level-order', valid: true, reqId: requestId, provider: providerName, strategyId, intentKey, plan, result });
            return result;
          }
        }

        const ok = {
          status: 'ok',
          provider: providerName,
          providerOrderId: `level:${strategyId}`,
          strategyId,
          raw: { plan, results }
        };
        this.runtime.startLevelOrderPositionMonitor({
          adapter,
          providerName,
          requestId,
          strategyId,
          symbol,
          children: results
        });
        this.#recordPartialResult({
          parentPositionId: payload.positionId,
          parentRequestId: requestId,
          providerName,
          strategyId,
          plan,
          results,
          result: ok
        });
        this.#append({ t: this.nowTs(), kind: 'level-order', valid: true, reqId: requestId, provider: providerName, strategyId, intentKey, plan, result: ok });
        return ok;
      })();
      intentRecord.promise = placementPromise;
      try {
        const finalResult = await placementPromise;
        intentRecord.result = cloneJson(finalResult);
        intentRecord.status = finalResult?.status || 'unknown';
        intentRecord.updatedAt = this.nowTs();
        intentRecord.promise = null;
        if (intentRecord.status === 'ok' || intentRecord.status === 'rejected') {
          this.levelOrderIntentRegistry.delete(intentKey);
        }
        return finalResult;
      } catch (error) {
        this.levelOrderIntentRegistry.delete(intentKey);
        throw error;
      }
    } catch (err) {
      const reason = err?.message || String(err);
      this.#append({ t: this.nowTs(), kind: 'level-order', valid: true, reqId: requestId, provider: providerName, strategyId, payload, error: reason });
      return { status: 'rejected', provider: providerName, reason };
    }
  }

  async stopRetry(reqId) {
    const matches = collectRetryStopEntries(this.pendingIndex, reqId);
    const parentIds = getRetryStopParentIds(reqId, matches);
    let terminalCancelled = 0;
    const terminalErrors = [];

    for (const parentId of parentIds) {
      this.runtime.stopLevelOrderPositionMonitor(parentId);
      const terminalResult = await this.runtime.cancelGroupedOrderUnopenedTickets(parentId);
      terminalCancelled += terminalResult.cancelled;
      terminalErrors.push(...terminalResult.errors);
    }

    for (const { pendingId, rec } of matches) {
      rec.adapter?.stopOpenOrder?.(pendingId);
      this.pendingIndex.delete(pendingId);
      this.trackerPending.delete(rec.reqId);
      this.sendToRenderer('execution:retry-stopped', {
        reqId: rec.reqId,
        pendingId,
        parentRequestId: rec.order?.meta?.parentRequestId
      });
    }

    for (const parentId of parentIds) {
      this.sendToRenderer('execution:retry-stopped', {
        reqId: parentId,
        parentRequestId: parentId,
        stopped: matches.length
      });
    }

    return { status: 'ok', stopped: matches.length, terminalCancelled, terminalErrors };
  }

  async closeLevelOrderPositions(payload = {}) {
    const symbol = typeof payload.symbol === 'string' ? payload.symbol : String(payload.symbol || '');
    const instrumentType = payload.instrumentType || detectInstrumentType(symbol);
    const providerName = this.resolveProviderName({
      provider: payload.provider,
      payload,
      symbol,
      instrumentType,
      meta: payload.meta
    });
    const explicitTickets = Array.isArray(payload.tickets) ? payload.tickets : [];
    const expectedIds = Array.isArray(payload.expectedIds) ? payload.expectedIds : [];
    if (!symbol) return { status: 'error', provider: providerName, reason: 'symbol required' };
    try {
      const adapter = this.getAdapter(providerName);
      this.wireAdapter(adapter, providerName);
      if (typeof adapter?.cancelOrder !== 'function') {
        return { status: 'unsupported', provider: providerName, reason: 'cancelOrder is not supported' };
      }
      let tickets = explicitTickets.map(value => String(value || '').trim()).filter(Boolean);
      if (expectedIds.length && (typeof adapter.listOpenPositions === 'function' || typeof adapter.listOpenOrders === 'function')) {
        const openPositions = typeof adapter.listOpenPositions === 'function'
          ? await adapter.listOpenPositions(symbol)
          : await adapter.listOpenOrders(symbol);
        tickets = findLevelOrderTerminalTickets(openPositions, { symbol, expectedIds, explicitTickets: tickets });
      }
      const results = [];
      const errors = [];
      for (const ticket of tickets) {
        try {
          const result = await adapter.cancelOrder(ticket, symbol);
          results.push({ ticket, result });
          this.#append({ t: this.nowTs(), kind: 'level-order-close-position', provider: providerName, symbol, ticket, result });
        } catch (err) {
          const reason = err?.message || String(err);
          errors.push({ ticket, reason });
          this.#append({ t: this.nowTs(), kind: 'level-order-close-position', provider: providerName, symbol, ticket, error: reason });
        }
      }
      if (!tickets.length) {
        const res = { status: 'error', provider: providerName, reason: 'No matching open level-order positions found' };
        this.#append({ t: this.nowTs(), kind: 'level-order-close-position', provider: providerName, symbol, expectedIds, result: res });
        return res;
      }
      return { status: errors.length ? 'partial' : 'ok', provider: providerName, symbol, closed: results.length, results, errors };
    } catch (err) {
      const reason = err?.message || String(err || '');
      this.#append({ t: this.nowTs(), kind: 'level-order-close-position', provider: providerName, symbol, expectedIds, explicitTickets, error: reason });
      return { status: 'error', provider: providerName, reason };
    }
  }

  #append(record) {
    this.appendJsonl?.(this.execLog, record);
  }

  #recordChildPlacement({ parentPositionId, parentRequestId, strategyId, providerName, childPayload, childResult, childCount }) {
    const meta = childPayload?.meta || {};
    const cmd = {
      positionId: parentPositionId,
      requestId: meta.requestId,
      parentRequestId,
      childIndex: meta.childIndex,
      childCount,
      pendingId: childResult?.cid,
      cid: childResult?.cid,
      ticket: childResult?.ticket,
      providerOrderId: childResult?.providerOrderId,
      provider: childResult?.provider || providerName,
      result: childResult,
      payload: childPayload,
      order: childPayload,
      origOrder: childPayload,
      reason: childResult?.reason
    };
    if (childResult?.status === 'rejected' || childResult?.status === 'error') {
      this.positions?.recordRejected?.(cmd);
      return;
    }
    this.positions?.recordPlaced?.(cmd);
  }

  #recordPartialResult({ parentPositionId, parentRequestId, providerName, strategyId, plan, results, result }) {
    if (!parentPositionId) return;
    const expectedChildren = plan?.childQtys?.length || results?.length || 0;
    for (let index = 0; index < expectedChildren; index += 1) {
      const child = results[index];
      if (child) continue;
      this.positions?.recordPlaced?.({
        positionId: parentPositionId,
        requestId: `${parentRequestId}_${index + 1}`,
        parentRequestId,
        childIndex: index + 1,
        childCount: expectedChildren,
        provider: providerName,
        providerOrderId: '',
        result: { status: 'unknown', provider: providerName, strategyId },
        payload: { meta: { requestId: `${parentRequestId}_${index + 1}`, parentRequestId, childIndex: index + 1, childCount: expectedChildren, strategyId } },
        reason: result?.reason
      });
    }
  }
}

function createLevelOrderApplicationService(opts = {}) {
  return new LevelOrderApplicationService(opts);
}

module.exports = {
  LevelOrderApplicationService,
  createLevelOrderApplicationService
};
