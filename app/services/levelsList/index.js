const { Command } = require('../commands/base');

const VALID_SOURCES = new Set(['level', 'price']);
const DEFAULT_SOURCES = ['level', 'price'];

function normalizeSources(sources) {
  const list = Array.isArray(sources) ? sources : DEFAULT_SOURCES;
  const out = [];
  for (const source of list) {
    const key = String(source || '').trim().toLowerCase();
    if (VALID_SOURCES.has(key) && !out.includes(key)) out.push(key);
  }
  return out.length ? out : DEFAULT_SOURCES.slice();
}

function parseNumber(value) {
  if (value == null) return null;
  const text = String(value).trim().replace(',', '.');
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

function formatLevel(value) {
  const num = parseNumber(value);
  if (!Number.isFinite(num)) return '';
  return String(Math.round((num + Number.EPSILON) * 100) / 100);
}

function sourcesForMode(mode, configuredSources) {
  const normalizedMode = String(mode || '').trim().toLowerCase();
  if (!normalizedMode || normalizedMode === 'all') {
    return { ok: true, sources: normalizeSources(configuredSources) };
  }
  if (VALID_SOURCES.has(normalizedMode)) {
    return { ok: true, sources: [normalizedMode] };
  }
  return { ok: false, error: 'Usage: levelsList [all|level|price]' };
}

function buildLevelsList(rows, opts = {}) {
  const sourceResult = sourcesForMode(opts.mode, opts.sources);
  if (!sourceResult.ok) return sourceResult;

  const lines = [];
  for (const row of (Array.isArray(rows) ? rows : []).slice().reverse()) {
    const ticker = String(row?.ticker || '').trim();
    if (!ticker) continue;

    let level = null;
    for (const source of sourceResult.sources) {
      level = parseNumber(row?.[source]);
      if (Number.isFinite(level)) break;
    }
    if (!Number.isFinite(level)) continue;
    lines.push(`${ticker} ${formatLevel(level)}`);
  }

  return {
    ok: true,
    count: lines.length,
    text: lines.length ? `${lines.join('\n')}\n` : ''
  };
}

class LevelsListCommand extends Command {
  constructor(opts = {}) {
    super(['levelsList']);
    this.getRows = opts.getRows;
    this.writeText = opts.writeText;
    this.getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : () => ({});
  }

  async run(args, context = {}) {
    const mode = Array.isArray(args) && args.length ? args[0] : '';
    const config = this.getConfig() || {};
    const sourceResult = sourcesForMode(mode, config.sources);
    if (!sourceResult.ok) return sourceResult;

    if (typeof this.getRows !== 'function') {
      return { ok: false, error: 'Order cards reader is not available' };
    }
    let rows;
    try {
      rows = await this.getRows(context);
    } catch (error) {
      return { ok: false, error: error?.message || 'Order cards window is not available' };
    }
    if (!Array.isArray(rows)) {
      return { ok: false, error: 'Order cards window is not available' };
    }

    const built = buildLevelsList(rows, { sources: sourceResult.sources });
    if (!built.ok) return built;

    if (typeof this.writeText !== 'function') {
      return { ok: false, error: 'Clipboard is not available' };
    }
    try {
      this.writeText(built.text);
    } catch (error) {
      return { ok: false, error: error?.message || 'Clipboard is not available' };
    }
    return { ok: true, count: built.count, text: built.text };
  }
}

module.exports = {
  LevelsListCommand,
  buildLevelsList,
  normalizeSources,
  sourcesForMode,
  parseNumber,
  formatLevel
};
