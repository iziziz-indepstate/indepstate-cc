const loadConfig = require('../../config/load');

let cfg = {};
try {
  cfg = loadConfig('../services/instrumentInfo/config/tick-sizes.json');
} catch {
  cfg = {};
}

function configure(next = {}) {
  cfg = next && typeof next === 'object' ? JSON.parse(JSON.stringify(next)) : {};
  return cfg;
}

function wildcardToRegExp(pattern) {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
}

function getDefaultTickSize() {
  const value = Number(cfg?.defaultTickSize);
  return Number.isFinite(value) && value > 0 ? value : 0.01;
}

function findTickSizeOverride(symbol) {
  if (!symbol) return null;
  const bySymbol = cfg?.bySymbol || {};
  if (Object.prototype.hasOwnProperty.call(bySymbol, symbol)) {
    const value = Number(bySymbol[symbol]);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  for (const pattern of cfg?.patterns || []) {
    if (wildcardToRegExp(pattern.match).test(symbol)) {
      const value = Number(pattern.tickSize);
      return Number.isFinite(value) && value > 0 ? value : null;
    }
  }
  return null;
}

function findTickSizeFromConfig(symbol) {
  return findTickSizeOverride(symbol) || getDefaultTickSize();
}

function expandExpToDecimal(value) {
  const match = String(value).trim().match(/^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if (!match) return String(value);
  const sign = match[1] || '';
  const intPart = match[2] || '0';
  const fracPart = match[3] || '';
  const exponent = parseInt(match[4], 10) || 0;
  let digits = intPart + fracPart;
  if (exponent >= 0) {
    digits += '0'.repeat(exponent);
    return (sign === '-' ? '-' : '') + digits;
  }
  const shift = -exponent;
  const zerosToPrefix = Math.max(0, shift - intPart.length);
  return (sign === '-' ? '-' : '') + '0.' + '0'.repeat(zerosToPrefix) + digits;
}

function digitsFallbackPoints(deltaToken) {
  if (deltaToken == null) return undefined;
  let value = String(deltaToken).trim();
  if (!value) return undefined;
  value = value.replace(/,/g, '');
  if (/e/i.test(value)) value = expandExpToDecimal(value);
  value = value.replace(/[^0-9.]/g, '').replace('.', '').replace(/^0+/, '');
  if (!value) return 0;
  const points = parseInt(value, 10);
  return Number.isFinite(points) ? Math.abs(points) : undefined;
}

function toPoints(hookTick, symbol, deltaPrice, priceHint, deltaTokenForFallback) {
  const delta = Number(deltaPrice);
  if (Number.isFinite(hookTick) && hookTick > 0 && Number.isFinite(delta)) {
    return Math.round(delta / hookTick);
  }
  const tickSize = findTickSizeFromConfig(symbol);
  if (Number.isFinite(tickSize) && tickSize > 0 && Number.isFinite(delta)) {
    return Math.round(delta / tickSize);
  }
  const fallback = digitsFallbackPoints(deltaTokenForFallback ?? deltaPrice);
  return Number.isFinite(fallback) ? fallback : undefined;
}

function resolveTickSize({ symbol, explicitTickSize, quoteTickSize, quoteTickSource, fallbackTickSize } = {}) {
  const quoteTick = Number(quoteTickSize);
  if (Number.isFinite(quoteTick) && quoteTick > 0 && String(quoteTickSource || '').trim()) return quoteTick;
  const override = Number(findTickSizeOverride(symbol));
  if (Number.isFinite(override) && override > 0) return override;
  const explicit = Number(explicitTickSize);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const fallback = Number(fallbackTickSize);
  if (Number.isFinite(fallback) && fallback > 0) return fallback;
  return getDefaultTickSize();
}

module.exports = {
  configure,
  digitsFallbackPoints,
  findTickSizeOverride,
  findTickSizeFromConfig,
  getDefaultTickSize,
  resolveTickSize,
  toPoints
};
