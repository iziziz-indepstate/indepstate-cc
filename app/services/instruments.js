function detectInstrumentType(symbol) {
  return /\.?USD[TC]\.P$/.test(symbol.toUpperCase()) ? 'CX' :
  /\.?(?:USD|EUR|GBP|CHF|MXN|JPY|AUD|CAD|NZD|PLN|SGD|TRY)(?:\.C)?$/.test(symbol.toUpperCase()) ? 'FX' :  'EQ';
}

function stripExchangePrefix(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const colonIndex = raw.indexOf(':');
  return colonIndex >= 0 ? raw.slice(colonIndex + 1).trim() : raw;
}


module.exports = { detectInstrumentType, stripExchangePrefix };
