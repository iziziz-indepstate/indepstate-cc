function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function signedOptionLegQty(leg) {
  const qty = Math.abs(Number(leg?.quantity ?? leg?.qty ?? 0));
  const side = String(leg?.side || '').toLowerCase();
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  return side === 'sell' || side === 'short' ? -qty : qty;
}

function optionLegToken(leg) {
  if (!leg || typeof leg !== 'object') return '';
  const qty = signedOptionLegQty(leg);
  if (!qty) return '';
  const optionCode = String(leg.option || '').toUpperCase().startsWith('P') ? 'P' : 'C';
  const strike = leg.strike ?? leg.price ?? '';
  return `${qty > 0 ? '+' : '-'}${Math.abs(qty)}${optionCode}${strike}`;
}

function optionLegs(legs) {
  const list = parseMaybeJson(legs);
  if (!Array.isArray(list)) return '';
  return list.map(optionLegToken).filter(Boolean).join('/');
}

function optionLegPair(legs) {
  const list = parseMaybeJson(legs);
  if (!Array.isArray(list)) return '';
  return list
    .map(leg => leg && typeof leg === 'object' ? leg.strike ?? leg.price ?? '' : '')
    .filter(value => value !== '')
    .join('/');
}

module.exports = { optionLegs, optionLegPair };
