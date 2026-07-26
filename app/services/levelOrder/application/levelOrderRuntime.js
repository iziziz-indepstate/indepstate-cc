const { normalizeCid } = require('../../../application/execution/orderPayload');

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function roundIntentNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(12)) : null;
}

function buildLevelOrderIntentKey({ providerName, symbol, instrumentType, payload, plan }) {
  return stableStringify({
    provider: providerName,
    symbol: String(symbol || '').trim().toUpperCase(),
    instrumentType,
    action: String(payload?.action || '').toUpperCase(),
    level: roundIntentNumber(plan.level),
    referencePrice: roundIntentNumber(plan.referencePrice),
    tickSize: roundIntentNumber(plan.tickSize),
    riskUsd: roundIntentNumber(plan.riskUsd),
    stopPts: roundIntentNumber(plan.stopPts),
    stopOffsetPts: roundIntentNumber(plan.stopOffsetPts),
    takeProfitPts: roundIntentNumber(plan.takeProfitPts),
    minLot: roundIntentNumber(plan.minLot),
    childQtys: (plan.childQtys || []).map(roundIntentNumber),
    priceSource: plan.priceSource
  });
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function getTerminalPositionComment(position = {}) {
  return String(position.comment || position.comment_string || position.clientOrderId || position.id || position.ticket || '');
}

function isTerminalPendingOrder(position = {}) {
  if (position.__isPosition === true) return false;
  const type = String(position.type || position.order_type || position.cmd || '').toLowerCase();
  return type.includes('limit') || type.includes('stop') || type.includes('pending');
}

function terminalPositionQty(position = {}) {
  const candidates = [
    position.lots,
    position.volume,
    position.qty,
    position.size,
    position.contracts,
    position.volume_current
  ];
  for (const candidate of candidates) {
    const value = Math.abs(Number(candidate));
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function getTerminalPositionIdentifiers(position = {}) {
  const values = [
    position.ticket,
    position.order,
    position.order_id,
    position.orderId,
    position.position_id,
    position.positionId,
    position.id,
    position.comment,
    position.comment_string,
    position.clientOrderId
  ];
  const ids = new Set();
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (!text) continue;
    ids.add(text);
    const cid = normalizeCid(text);
    if (cid) ids.add(cid);
  }
  return ids;
}

function getTerminalPositionTicket(position = {}) {
  const values = [
    position.ticket,
    position.position_id,
    position.positionId,
    position.order,
    position.order_id,
    position.orderId,
    position.id
  ];
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function levelOrderChildCid(child = {}) {
  const raw = child.result?.providerOrderId || child.result?.cid || child.result?.raw?.cid || '';
  return normalizeCid(raw);
}

function levelOrderChildExpectedIds(child = {}) {
  const ids = new Set();
  const cid = levelOrderChildCid(child);
  if (cid) ids.add(cid);
  const ticket = String(child.providerOrderId || child.ticket || child.result?.ticket || '').trim();
  if (ticket) ids.add(ticket);
  return ids;
}

function normalizeSymbolForMatch(value) {
  return String(value || '').trim().toUpperCase();
}

function scanLevelOrderPositions(openOrders, children, symbol) {
  const expected = [];
  const expectedIds = new Set();
  for (const child of children || []) {
    const ids = levelOrderChildExpectedIds(child);
    const qty = Number(child.qty);
    if (ids.size && Number.isFinite(qty) && qty > 0) {
      expected.push({ ids, qty });
      for (const id of ids) expectedIds.add(id);
    }
  }
  const targetSymbol = normalizeSymbolForMatch(symbol);
  const matchedPositions = [];
  const foundIds = new Set();
  for (const pos of openOrders || []) {
    if (!pos || isTerminalPendingOrder(pos)) continue;
    if (targetSymbol && normalizeSymbolForMatch(pos.symbol) !== targetSymbol) continue;
    const posIds = getTerminalPositionIdentifiers(pos);
    const qty = terminalPositionQty(pos);
    const matchedIds = [...expectedIds].filter(id => posIds.has(id));
    if (!matchedIds.length) continue;
    matchedPositions.push(pos);
    for (const id of matchedIds) foundIds.add(id);
  }
  let expectedQty = 0;
  for (const exp of expected) expectedQty += exp.qty;
  let foundQty = 0;
  for (const pos of matchedPositions) foundQty += terminalPositionQty(pos);
  const foundTickets = matchedPositions.map(getTerminalPositionTicket).filter(Boolean);
  const anyCidFound = expectedIds.size > 0 && foundIds.size > 0;
  const qtyOk = expectedQty > 0 && foundQty + 1e-9 >= expectedQty;
  return {
    ready: anyCidFound && qtyOk,
    expectedQty,
    foundQty,
    expectedCids: expected.flatMap(exp => [...exp.ids]),
    foundCids: [...foundIds],
    foundTickets,
    matchedPositions: matchedPositions.length
  };
}

function findLevelOrderTerminalTickets(openPositions, { symbol, expectedIds = [], explicitTickets = [] } = {}) {
  const targetSymbol = normalizeSymbolForMatch(symbol);
  const ids = new Set((expectedIds || []).map(value => String(value || '').trim()).filter(Boolean));
  const tickets = new Set((explicitTickets || []).map(value => String(value || '').trim()).filter(Boolean));
  for (const pos of openPositions || []) {
    if (!pos || isTerminalPendingOrder(pos)) continue;
    if (targetSymbol && normalizeSymbolForMatch(pos.symbol) !== targetSymbol) continue;
    const posTicket = getTerminalPositionTicket(pos);
    if (posTicket && tickets.has(posTicket)) continue;
    const posIds = getTerminalPositionIdentifiers(pos);
    const matched = posTicket && tickets.has(posTicket)
      || [...ids].some(id => posIds.has(id));
    if (matched && posTicket) tickets.add(posTicket);
  }
  return [...tickets];
}

function createLevelOrderRuntime({
  getAdapter,
  wireAdapter,
  groupedOrderLifecycles,
  levelOrderPositionMonitors = new Map(),
  appendJsonl,
  execLog,
  nowTs = () => Date.now(),
  sendToRenderer = () => {}
} = {}) {
  function stopLevelOrderPositionMonitor(requestId) {
    const monitor = levelOrderPositionMonitors.get(requestId);
    if (monitor?.timer) clearTimeout(monitor.timer);
    levelOrderPositionMonitors.delete(requestId);
  }

  function emitLevelOrderPositionsReadyIfComplete(parentRequestId) {
    const snapshot = groupedOrderLifecycles.takeReadySnapshot(parentRequestId);
    if (!snapshot) return false;
    const payload = {
      requestId: parentRequestId,
      parentRequestId,
      provider: snapshot.provider,
      symbol: snapshot.symbol,
      expectedQty: snapshot.expectedQty,
      foundQty: snapshot.foundQty,
      expectedCids: snapshot.cids,
      foundCids: snapshot.cids,
      foundTickets: snapshot.openedTickets || snapshot.tickets || []
    };
    appendJsonl?.(execLog, { t: nowTs(), kind: 'level-order-positions-ready', source: 'lifecycle', ...payload });
    console.log('[LEVEL][POSITIONS_READY]', {
      requestId: parentRequestId,
      symbol: snapshot.symbol,
      foundQty: snapshot.foundQty,
      expectedQty: snapshot.expectedQty,
      source: 'lifecycle'
    });
    sendToRenderer('level-order:positions-ready', payload);
    stopLevelOrderPositionMonitor(parentRequestId);
    return true;
  }

  async function cancelGroupedOrderUnopenedTickets(groupId) {
    const group = groupedOrderLifecycles.get(groupId);
    if (!group) return { cancelled: 0, errors: [] };
    const adapter = getAdapter(group.provider);
    wireAdapter(adapter, group.provider);
    const errors = [];
    let cancelled = 0;
    for (const ticket of groupedOrderLifecycles.getUnopenedTickets(groupId)) {
      try {
        const result = await adapter.cancelOrder(ticket, group.symbol);
        cancelled += 1;
        appendJsonl?.(execLog, {
          t: nowTs(),
          kind: 'level-order-cancel-terminal',
          parentRequestId: groupId,
          provider: group.provider,
          ticket,
          symbol: group.symbol,
          result
        });
      } catch (err) {
        const reason = err?.message || String(err);
        errors.push({ ticket, reason });
        appendJsonl?.(execLog, {
          t: nowTs(),
          kind: 'level-order-cancel-terminal',
          parentRequestId: groupId,
          provider: group.provider,
          ticket,
          symbol: group.symbol,
          error: reason
        });
      }
    }
    return { cancelled, errors };
  }

  function startLevelOrderPositionMonitor({ adapter, providerName, requestId, strategyId, symbol, children, timeoutMs = 45000, intervalMs = 750 }) {
    if (
      !requestId
      || !adapter
      || (typeof adapter.listOpenPositions !== 'function' && typeof adapter.listOpenOrders !== 'function')
    ) return;
    stopLevelOrderPositionMonitor(requestId);
    const startedAt = Date.now();
    const monitor = { adapter, providerName, requestId, strategyId, symbol, children: children || [], timer: null };
    levelOrderPositionMonitors.set(requestId, monitor);

    const tick = async () => {
      try {
        const openPositions = typeof adapter.listOpenPositions === 'function'
          ? await adapter.listOpenPositions(symbol)
          : await adapter.listOpenOrders(symbol);
        const scan = scanLevelOrderPositions(openPositions, monitor.children, symbol);
        if (scan.ready) {
          stopLevelOrderPositionMonitor(requestId);
          const payload = {
            requestId,
            parentRequestId: requestId,
            provider: providerName,
            strategyId,
            symbol,
            expectedQty: scan.expectedQty,
            foundQty: scan.foundQty,
            expectedCids: scan.expectedCids,
            foundCids: scan.foundCids,
            foundTickets: scan.foundTickets
          };
          appendJsonl?.(execLog, { t: nowTs(), kind: 'level-order-positions-ready', ...payload });
          console.log('[LEVEL][POSITIONS_READY]', { requestId, symbol, foundQty: scan.foundQty, expectedQty: scan.expectedQty });
          sendToRenderer('level-order:positions-ready', payload);
          return;
        }
      } catch (err) {
        console.warn('[LEVEL][POSITIONS_POLL_ERR]', { requestId, error: err?.message || String(err) });
      }

      if (Date.now() - startedAt >= timeoutMs) {
        stopLevelOrderPositionMonitor(requestId);
        let sample = [];
        let scan = null;
        try {
          const openPositions = typeof adapter.listOpenPositions === 'function'
            ? await adapter.listOpenPositions(symbol)
            : await adapter.listOpenOrders(symbol);
          scan = scanLevelOrderPositions(openPositions, monitor.children, symbol);
          sample = (openPositions || []).slice(0, 10).map(pos => ({
            ticket: pos?.ticket,
            type: pos?.type || pos?.order_type || pos?.cmd,
            symbol: pos?.symbol,
            comment: pos?.comment || pos?.comment_string,
            qty: terminalPositionQty(pos),
            isPosition: pos?.__isPosition === true
          }));
        } catch {}
        console.warn('[LEVEL][POSITIONS_TIMEOUT]', { requestId, symbol, scan, sample });
        sendToRenderer('level-order:positions-timeout', { requestId, parentRequestId: requestId, provider: providerName, strategyId, symbol });
        return;
      }
      monitor.timer = setTimeout(tick, intervalMs);
      levelOrderPositionMonitors.set(requestId, monitor);
    };

    monitor.timer = setTimeout(tick, intervalMs);
    levelOrderPositionMonitors.set(requestId, monitor);
  }

  return {
    levelOrderPositionMonitors,
    stopLevelOrderPositionMonitor,
    emitLevelOrderPositionsReadyIfComplete,
    cancelGroupedOrderUnopenedTickets,
    startLevelOrderPositionMonitor
  };
}

module.exports = {
  stableStringify,
  roundIntentNumber,
  buildLevelOrderIntentKey,
  cloneJson,
  getTerminalPositionComment,
  isTerminalPendingOrder,
  terminalPositionQty,
  getTerminalPositionIdentifiers,
  getTerminalPositionTicket,
  levelOrderChildCid,
  levelOrderChildExpectedIds,
  normalizeSymbolForMatch,
  scanLevelOrderPositions,
  findLevelOrderTerminalTickets,
  createLevelOrderRuntime
};
