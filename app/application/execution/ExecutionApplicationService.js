const { orderPayloadToCreatePositionCommand } = require('../positions');
const { PositionCommand } = require('../../domain/positions');
const {
  normalizeCid,
  ensureCommentHasCid,
  ensureOrderCid,
  normalizeOrderPayload,
  validateOrder,
  executionOptionsForOrder,
  normalizeQuoteForValidation,
  normalizeEquityOrderForExecution
} = require('./orderPayload');

class ExecutionApplicationService {
  constructor({
    getAdapter,
    wireAdapter,
    instrumentInfo,
    orderCalc,
    tradeRules,
    events,
    positions,
    appendJsonl,
    execLog,
    nowTs = () => Date.now(),
    sendToRenderer = () => {},
    trackerPending,
    trackerIndex,
    pendingIndex,
    resolveOrderProviderName,
    resolveProviderName,
    providerCanResolveRiskQty,
    cardControllers,
    orderPayloadPolicies
  } = {}) {
    this.getAdapter = getAdapter;
    this.wireAdapter = wireAdapter;
    this.instrumentInfo = instrumentInfo;
    this.orderCalc = orderCalc;
    this.tradeRules = tradeRules;
    this.events = events;
    this.positions = positions;
    this.appendJsonl = appendJsonl;
    this.execLog = execLog;
    this.nowTs = nowTs;
    this.sendToRenderer = sendToRenderer;
    this.trackerPending = trackerPending || new Map();
    this.trackerIndex = trackerIndex || new Map();
    this.pendingIndex = pendingIndex || new Map();
    this.resolveOrderProviderName = resolveOrderProviderName;
    this.resolveProviderName = resolveProviderName;
    this.providerCanResolveRiskQty = providerCanResolveRiskQty;
    this.cardControllers = Array.isArray(cardControllers) ? cardControllers.filter(Boolean) : [];
    this.orderPayloadPolicies = orderPayloadPolicies;
  }

  pickProviderName(instrumentType) {
    return this.resolveProviderName({ instrumentType });
  }

  async queuePlaceOrder(payload) {
    const policyContext = { orderPayloadPolicies: this.orderPayloadPolicies };
    const order = normalizeOrderPayload(payload, policyContext);

    const v = validateOrder(order, policyContext);
    if (!v.ok) {
      const rej = { status: 'rejected', reason: v.reason };
      this.#append({ t: this.nowTs(), kind: 'place', valid: false, order, result: rej });
      return rej;
    }

    const providerName = this.resolveOrderProviderName(order);
    let execOrder;
    let cid = '';
    let tracksStandalonePosition = true;
    try {
      const ts = this.nowTs();
      const reqId = order?.meta?.requestId || `${ts}_${Math.random().toString(36).slice(2, 8)}`;
      if (!order.meta) order.meta = {};
      order.meta.requestId = reqId;
      cid = ensureOrderCid(order);

      const sideCode = String(order.side || '').toUpperCase();
      const sideDir = sideCode.startsWith('S') || sideCode === 'SELL' ? 'short' : 'long';
      this.trackerPending.set(reqId, {
        ticker: order.meta?.ticker || order.symbol,
        tp: order.meta?.takePts,
        sp: order.meta?.stopPts,
        side: sideDir,
        cid,
        price: order.price,
        qty: order.qty
      });

      execOrder = normalizeEquityOrderForExecution(order);
      const executionOptions = executionOptionsForOrder(execOrder, {
        ...policyContext,
        providerName,
        order,
        execOrder
      });
      execOrder.comment = ensureCommentHasCid(execOrder.comment, cid);
      if (!execOrder.meta) execOrder.meta = {};
      execOrder.meta.cid = cid;
      tracksStandalonePosition = this.shouldTrackStandalonePosition(execOrder, { providerName });
      if (tracksStandalonePosition) {
        try {
          const explicitPositionId = order.meta?.positionId;
          const createCommand = orderPayloadToCreatePositionCommand(execOrder, providerName);
          execOrder.meta.positionId = createCommand.positionId;
          if (explicitPositionId) {
            this.positions?.handle?.({
              ...createCommand,
              type: PositionCommand.OPEN,
              positionId: explicitPositionId,
              payload: execOrder
            });
          } else {
            this.positions?.createAndOpen?.(createCommand);
          }
        } catch (err) {
          console.warn('[positions] failed to record open request:', err?.message || String(err));
        }
      }

      const logOrder = {
        ...execOrder,
        cid,
        comment: execOrder.comment,
        sentAt: ts,
        meta: { ...(execOrder.meta || {}), cid, sentAt: ts, provider: providerName }
      };
      this.events?.emit('execution:order-message', logOrder);

      const adapter = this.getAdapter(providerName);
      this.wireAdapter(adapter, providerName);

      const requiresQuote = executionOptions.requiresQuote !== false;
      const usesRiskSizing = executionOptions.usesRiskSizing !== false;
      const usesTradeRules = executionOptions.usesTradeRules !== false;
      const isHedgeMarket = requiresQuote
        && execOrder.meta?.hedge === true
        && String(execOrder.type || '').toLowerCase() === 'market';
      const instrumentSnapshot = await this.instrumentInfo.get({
        provider: providerName,
        symbol: execOrder.symbol,
        instrumentType: execOrder.instrumentType,
        payload: execOrder
      }, { forceQuote: requiresQuote });
      const quote = normalizeQuoteForValidation(instrumentSnapshot?.quote);
      if (requiresQuote && !isHedgeMarket && (!quote || !Number.isFinite(quote.price))) {
        const rej = { status: 'rejected', provider: providerName, reason: 'No quote' };
        this.#append({ t: ts, kind: 'place', valid: true, reqId, cid, provider: providerName, order: execOrder, result: rej });
        return rej;
      }

      const riskUsd = Number(order?.meta?.riskUsd);
      const stopPts = Number(execOrder.sl);
      const isFixedQty = order?.meta?.fixedQty === true;
      const isRiskBased = !isFixedQty && Number.isFinite(riskUsd) && riskUsd > 0 && Number.isFinite(stopPts) && stopPts > 0;
      const tickResolution = this.instrumentInfo.getTickSizeResolution({
        provider: providerName,
        symbol: execOrder.symbol,
        instrumentType: execOrder.instrumentType,
        payload: execOrder
      }, { explicitTickSize: execOrder.tickSize });
      const effectiveTickSize = tickResolution.tickSize;
      const metadataQuantityStep = Number(instrumentSnapshot?.metadata?.quantityStep);
      if (Number.isFinite(metadataQuantityStep) && metadataQuantityStep > 0) {
        execOrder.meta = { ...(execOrder.meta || {}), quantityStep: execOrder.meta?.quantityStep || metadataQuantityStep };
      }

      if (usesRiskSizing && Number.isFinite(effectiveTickSize) && effectiveTickSize > 0) {
        execOrder.tickSize = effectiveTickSize;
        if (isRiskBased) {
          execOrder.qty = this.orderCalc.qty({
            riskUsd,
            stopPts,
            tickSize: effectiveTickSize,
            lot: execOrder.lot || order.lot || 1,
            instrumentType: execOrder.instrumentType,
            quantityStep: execOrder.meta?.quantityStep
          });
        }
      } else if (usesRiskSizing && isRiskBased) {
        if (!this.providerCanResolveRiskQty(providerName, adapter)) {
          const rej = { status: 'rejected', provider: providerName, reason: `No tickSize for ${execOrder.symbol}; cannot calculate risk-based qty for provider ${providerName}` };
          this.#append({ t: ts, kind: 'place', valid: true, reqId, cid, provider: providerName, order: execOrder, result: rej });
          return rej;
        }
        execOrder.meta.riskBasedQtyPending = true;
        execOrder.meta.riskUsd = riskUsd;
        execOrder.meta.stopPts = stopPts;
      }

      console.log('[EXEC][SIZE]', { symbol: execOrder.symbol, price: execOrder.price, riskUsd, stopPts, tickSize: execOrder.tickSize, lot: execOrder.lot, qty: execOrder.qty, tickSource: tickResolution.source });

      if (usesTradeRules) {
        const quoteForRules = isHedgeMarket && (!quote || !Number.isFinite(quote.price)) ? { price: 1 } : quote;
        const ruleOrder = execOrder.meta?.hedge === true
          ? { ...execOrder, sl: Number.isFinite(Number(execOrder.sl)) && Number(execOrder.sl) > 0 ? execOrder.sl : Number.POSITIVE_INFINITY }
          : execOrder;
        const rule = this.tradeRules.validate(ruleOrder, quoteForRules);
        if (!rule.ok) {
          const rej = { status: 'rejected', provider: providerName, reason: rule.reason };
          this.#append({ t: ts, kind: 'place', valid: true, reqId, cid, provider: providerName, order: execOrder, result: rej });
          return rej;
        }
      }

      console.log('[EXEC][REQ]', { provider: providerName, reqId, cid, symbol: execOrder.symbol, action: order.side, side: execOrder.side, type: execOrder.type, qty: execOrder.qty, price: execOrder.price, sl: execOrder.sl, tp: execOrder.tp });

      const result = await adapter.placeOrder(execOrder);
      const maybePending = String(result?.providerOrderId || '');
      if (maybePending.startsWith('pending:')) {
        const pendingId = normalizeCid(maybePending) || cid;
        this.pendingIndex.set(pendingId, { reqId, adapter, providerName, order: execOrder, ts, cid: pendingId });
        if (tracksStandalonePosition) {
          this.positions?.recordPlaced?.({
            positionId: execOrder.meta?.positionId,
            requestId: reqId,
            providerOrderId: result.providerOrderId,
            provider: providerName,
            result,
            payload: execOrder
          });
        }

        this.#append({
          t: ts,
          kind: 'place-queued',
          reqId,
          provider: providerName,
          pendingId,
          cid: pendingId,
          order: execOrder
        });

        this.sendToRenderer('execution:pending', {
          ts,
          reqId,
          provider: providerName,
          pendingId,
          cid: pendingId,
          parentRequestId: execOrder.meta?.parentRequestId,
          childIndex: execOrder.meta?.childIndex,
          childCount: execOrder.meta?.childCount,
          strategyId: execOrder.meta?.strategyId,
          order: execOrder
        });

        this.events?.emit('order:placed', { order: execOrder, result: { status: 'ok', provider: providerName, providerOrderId: result.providerOrderId, cid: pendingId } });
        console.log('[EXEC][QUEUED]', { reqId, pendingId, cid: pendingId });
        return { status: 'ok', provider: providerName, providerOrderId: result.providerOrderId, cid: pendingId };
      }

      const execRecord = {
        t: ts,
        kind: 'place',
        reqId,
        cid,
        valid: true,
        provider: (result && result.provider) || providerName,
        order: execOrder,
        result
      };
      this.#append(execRecord);

      this.sendToRenderer('execution:result', {
        ts,
        reqId,
        provider: execRecord.provider,
        status: result?.status || 'rejected',
        reason: result?.reason,
        providerOrderId: result?.providerOrderId,
        cid,
        parentRequestId: execOrder.meta?.parentRequestId,
        childIndex: execOrder.meta?.childIndex,
        childCount: execOrder.meta?.childCount,
        strategyId: execOrder.meta?.strategyId,
        payoff: result?.payoff || result?.raw?.payoff,
        raw: result?.raw,
        order: execOrder
      });

      const info = this.trackerPending.get(reqId);
      if (info && result?.status !== 'rejected' && result?.providerOrderId) {
        this.trackerIndex.set(String(result.providerOrderId), info);
      }
      this.trackerPending.delete(reqId);

      const lifecycleResult = result?.status === 'ok'
        ? { ...result, provider: execRecord.provider, cid }
        : { status: result?.status || 'rejected', provider: execRecord.provider, providerOrderId: result?.providerOrderId, reason: result?.reason, cid };
      this.events?.emit('order:placed', { order: execOrder, result: lifecycleResult });
      if (!tracksStandalonePosition) {
        // Extension child orders can be represented by their parent Position card.
      } else if (result?.status === 'ok' || result?.status === 'simulated') {
        this.positions?.recordPlaced?.({
          positionId: execOrder.meta?.positionId,
          requestId: reqId,
          providerOrderId: result.providerOrderId,
          provider: execRecord.provider,
          result,
          payload: execOrder
        });
      } else {
        this.positions?.recordRejected?.({
          positionId: execOrder.meta?.positionId,
          requestId: reqId,
          provider: execRecord.provider,
          reason: result?.reason,
          result
        });
      }

      console.log('[EXEC][RES]', { reqId, cid, status: result?.status, reason: result?.reason, providerOrderId: result?.providerOrderId });
      return result;
    } catch (err) {
      const rej = { status: 'rejected', reason: err.message || 'adapter error' };
      const errorCid = cid || normalizeCid(order?.meta?.cid);
      this.#append({ t: this.nowTs(), kind: 'place', valid: true, order, reqId: order?.meta?.requestId, cid: errorCid || undefined, error: String(err) });

      this.sendToRenderer('execution:result', {
        ts: this.nowTs(),
        reqId: order?.meta?.requestId,
        provider: providerName,
        status: 'rejected',
        reason: rej.reason,
        cid: errorCid || undefined,
        order
      });
      this.trackerPending.delete(order?.meta?.requestId);
      console.log('[EXEC][ERR]', { provider: providerName, reqId: order?.meta?.requestId, cid: errorCid || undefined, error: String(err) });
      this.events?.emit('order:placed', { order: execOrder, result: { status: 'rejected', provider: providerName, reason: rej.reason, cid: errorCid || undefined } });
      if (tracksStandalonePosition) {
        this.positions?.recordFailed?.({
          positionId: execOrder?.meta?.positionId,
          requestId: order?.meta?.requestId,
          provider: providerName,
          reason: rej.reason
        });
      }
      return rej;
    }
  }

  shouldTrackStandalonePosition(order, context = {}) {
    for (const controller of this.cardControllers) {
      if (typeof controller.shouldTrackStandalonePosition !== 'function') continue;
      const decision = controller.shouldTrackStandalonePosition(order, context);
      if (typeof decision === 'boolean') return decision;
    }
    return true;
  }

  #append(record) {
    this.appendJsonl?.(this.execLog, record);
  }
}

function createExecutionApplicationService(opts = {}) {
  return new ExecutionApplicationService(opts);
}

module.exports = {
  ExecutionApplicationService,
  createExecutionApplicationService
};
