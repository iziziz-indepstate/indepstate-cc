function normalizeId(value) {
  return String(value == null ? '' : value).trim();
}

function levelOrderRetryStopMatches(targetId, pendingId, rec = {}) {
  const target = normalizeId(targetId);
  if (!target) return false;

  const pid = normalizeId(pendingId);
  const reqId = normalizeId(rec.reqId);
  const cid = normalizeId(rec.cid || rec.order?.meta?.cid);
  const parentRequestId = normalizeId(rec.order?.meta?.parentRequestId);

  return target === pid
    || target === reqId
    || target === cid
    || target === parentRequestId;
}

function collectRetryStopEntries(pendingIndex, targetId) {
  const matches = [];
  if (!pendingIndex || typeof pendingIndex.entries !== 'function') return matches;
  for (const [pendingId, rec] of pendingIndex.entries()) {
    if (levelOrderRetryStopMatches(targetId, pendingId, rec)) {
      matches.push({ pendingId, rec });
    }
  }
  return matches;
}

function getRetryStopParentIds(targetId, matches = []) {
  const ids = new Set();
  const target = normalizeId(targetId);
  if (target) ids.add(target);
  for (const { rec } of matches) {
    const parent = normalizeId(rec?.order?.meta?.parentRequestId);
    if (parent) ids.add(parent);
  }
  return [...ids];
}

module.exports = {
  levelOrderRetryStopMatches,
  collectRetryStopEntries,
  getRetryStopParentIds
};
