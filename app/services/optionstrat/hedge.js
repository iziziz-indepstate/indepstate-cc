function normalizeStrategyCommand(row = {}) {
  return String(row.strategyCommand || row.command || row.name || '')
    .trim()
    .split(/\s+/)[0]
    .toLowerCase();
}

function oppositeSide(side) {
  if (side === 'buy') return 'sell';
  if (side === 'sell') return 'buy';
  return '';
}

function optionStratHedgeOpenSide(row = {}) {
  const command = normalizeStrategyCommand(row);
  if (command === 'lcs') return 'buy';
  if (command === 'sps') return 'sell';
  return '';
}

function buildOptionStratHedgePayload(action, row = {}) {
  const normalizedAction = String(action || '').trim().toLowerCase();
  const eventName = normalizedAction === 'close'
    ? 'optionstrat:close-clicked'
    : 'optionstrat:open-clicked';
  const hedgeOpenSide = optionStratHedgeOpenSide(row);
  const hedgeCloseSide = oppositeSide(hedgeOpenSide);
  const strategyCommand = normalizeStrategyCommand(row);
  return {
    eventName,
    payload: {
      strategyCommand,
      ticker: row.ticker || row.symbol || '',
      symbol: row.symbol || row.ticker || '',
      provider: row.provider || '',
      hedgeSymbol: 'UPRO',
      hedgeOpenSide,
      hedgeCloseSide
    }
  };
}

module.exports = {
  normalizeStrategyCommand,
  oppositeSide,
  optionStratHedgeOpenSide,
  buildOptionStratHedgePayload
};
