function normalizeQuantityStep(value, fallback = 1) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveQuantityStep(meta = {}) {
  return normalizeQuantityStep(meta.quantityStep ?? meta.minLot, 1);
}

function normalizeOrderQty(qty, instrumentType, meta = {}) {
  const n = Number(qty || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const step = resolveQuantityStep(meta);
  if (instrumentType === 'EQ' && step >= 1) return Math.floor(n);
  return Number(n.toFixed(10));
}

function isValidOrderQty(qty, instrumentType, meta = {}) {
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) return false;
  const step = resolveQuantityStep(meta);
  if (instrumentType === 'EQ' && step >= 1) return n >= 1;
  return true;
}

module.exports = {
  normalizeQuantityStep,
  resolveQuantityStep,
  normalizeOrderQty,
  isValidOrderQty
};
