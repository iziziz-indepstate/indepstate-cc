function finiteNumber(value) {
  if (value == null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number > 0 ? number : undefined;
}

function normalizePreviewQuote(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const quote = {};
  for (const field of ['bid', 'ask', 'price']) {
    const value = finiteNumber(raw[field]);
    if (value !== undefined) quote[field] = value;
  }
  if (quote.price === undefined) {
    if (quote.bid !== undefined && quote.ask !== undefined) quote.price = (quote.bid + quote.ask) / 2;
    else if (quote.bid !== undefined) quote.price = quote.bid;
    else if (quote.ask !== undefined) quote.price = quote.ask;
  }
  const timestamp = finiteNumber(raw.timestamp ?? raw.time ?? raw.updatedAt);
  if (timestamp !== undefined) quote.timestamp = timestamp;
  return quote;
}

function buildInstrumentPreview(snapshot, {
  symbol,
  instrumentType,
  tickSize,
  quantityStep,
  contractSize
} = {}) {
  const metadata = snapshot?.metadata || {};
  const instrument = {
    symbol: snapshot?.symbol || symbol,
    instrumentType: snapshot?.instrumentType || instrumentType
  };
  const values = {
    tickSize: positiveNumber(tickSize) ?? positiveNumber(metadata.tickSize),
    quantityStep: positiveNumber(quantityStep) ?? positiveNumber(metadata.quantityStep),
    contractSize: positiveNumber(contractSize) ?? positiveNumber(metadata.contractSize),
    minQty: positiveNumber(metadata.minQty),
    maxQty: positiveNumber(metadata.maxQty),
    minNotional: positiveNumber(metadata.minNotional)
  };
  for (const [field, value] of Object.entries(values)) {
    if (value !== undefined) instrument[field] = value;
  }
  return instrument;
}

function validationError(code, field, message) {
  return {
    code: String(code || 'VALIDATION_FAILED'),
    field: String(field || 'order'),
    message: String(message || 'Validation failed')
  };
}

module.exports = {
  buildInstrumentPreview,
  normalizePreviewQuote,
  validationError
};
