// Candle display/read permissions are independent of the trading symbol list.
const DEFAULT_SOURCES = Object.freeze({});
const DEFAULT_MAPPINGS = Object.freeze(Object.entries(DEFAULT_SOURCES)
  .map(([sourceSymbol, mt5Symbol]) => Object.freeze({ enabled: true, sourceSymbol, mt5Symbol })));

function brokerName(value) {
  if (typeof value !== 'string' || !value.length || value.length > 60 || value !== value.trim()
    || /[\x00-\x1f\x7f-\x9f"\\]/.test(value)) throw Error('Укажите точное имя инструмента MT5 (до 60 символов)');
  return value;
}

function mappings(config = {}) {
  if (config.mappings === undefined) return DEFAULT_MAPPINGS.map(row => ({ ...row }));
  if (!Array.isArray(config.mappings) || config.mappings.length > 32) throw Error('Допускается до 32 пар ТВ → MT5');
  const seen = new Set();
  return config.mappings.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.enabled !== 'boolean')
      throw Error(`Пара ${index + 1}: укажите, включена ли привязка`);
    const sourceSymbol = String(row.sourceSymbol || '').trim().toUpperCase();
    const mt5Symbol = typeof row.mt5Symbol === 'string' ? row.mt5Symbol.trim() : '';
    if (!row.enabled && !sourceSymbol && !mt5Symbol) return { enabled: false, sourceSymbol, mt5Symbol };
    if (!/^[A-Z0-9_.-]+:[A-Z0-9_.!#&+\/()-]+$/.test(sourceSymbol) || sourceSymbol.length > 160)
      throw Error(`Пара ${index + 1}: нужен полный символ ТВ, например CAPITALCOM:NAS100`);
    brokerName(mt5Symbol);
    if (row.enabled && seen.has(sourceSymbol)) throw Error(`Для ${sourceSymbol} включено несколько назначений MT5`);
    if (row.enabled) seen.add(sourceSymbol);
    return { enabled: row.enabled, sourceSymbol, mt5Symbol };
  });
}

function sourceMap(config = {}) {
  return Object.fromEntries(mappings(config).filter(row => row.enabled).map(row => [row.sourceSymbol, row.mt5Symbol]));
}

async function validateChanges(config, previous, getAdapter) {
  const next = mappings(config), before = new Set(Object.values(sourceMap(previous)));
  const symbols = [...new Set(next.filter(row => row.enabled).map(row => row.mt5Symbol))].filter(name => !before.has(name));
  if (symbols.length) await getAdapter().validateCandleSymbols(symbols);
  return next;
}

module.exports = { DEFAULT_SOURCES, DEFAULT_MAPPINGS, brokerName, mappings, sourceMap, validateChanges };
