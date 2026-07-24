const { Command } = require('./base');
const { digitsFallbackPoints } = require('../instrumentInfo/points');

function _normNum(val) {
  if (val == null) return null;
  const s = String(val).trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parsePts(token) {
  const n = digitsFallbackPoints(token);
  return Number.isFinite(n) ? n : null;
}

function parsePtsAuto(token, price) {
  if (token == null) return null;
  const s = String(token).trim();
  if (!s) return null;
  if (s.includes('.')) {
    const pr = _normNum(price);
    const val = _normNum(s);
    if (!Number.isFinite(pr) || !Number.isFinite(val)) return null;
    const diffPts = Math.abs(pr - val) / 0.01; // mimic input field conversion
    return Number.isFinite(diffPts) ? Math.round(diffPts) : null;
  }
  return parsePts(token);
}

function isSL(n) {
  return typeof n === 'number' && isFinite(n) && n > 0;
}

class AddCommand extends Command {
  constructor(opts = {}) {
    super(['add', 'a']);
    this.onAdd = opts.onAdd;
  }

  run(args) {
    let [ticker, priceStr, slStr, tpStr, riskStr] = args;
    if (!ticker || priceStr == null) {
      return { ok: false, error: 'Usage: add {ticker} {price} {sl} {tp} {risk}' };
    }
    const dot = ticker.indexOf('.');
    if (dot >= 0) {
      ticker = ticker.slice(0, dot).toUpperCase() + ticker.slice(dot);
    } else {
      ticker = ticker.toUpperCase();
    }
    const price = _normNum(priceStr);
    const sl = parsePtsAuto(slStr == null ? 10 : slStr, price);
    const tp = parsePtsAuto(tpStr, price);
    const risk = _normNum(riskStr);
    if (!Number.isFinite(price) || price <= 0) {
      return { ok: false, error: 'Invalid price' };
    }
    if (!isSL(sl)) {
      return { ok: false, error: 'Invalid SL' };
    }
    const row = {
      ticker,
      price,
      sl,
      time: Date.now(),
      event: 'manual'
    };
    if (tp != null) row.tp = tp;
    if (risk != null) row.risk = risk;
    if (typeof this.onAdd === 'function') this.onAdd(row);
    return { ok: true };
  }
}

module.exports = { AddCommand };
