function text(value) {
  return String(value || '').trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function hasLegs(value = {}) {
  return [
    value.legs,
    value.order?.legs,
    value.source?.legs,
    value.executionIntent?.legs,
    value.card?.data?.legs
  ].some(legs => Array.isArray(legs) && legs.length > 0);
}

function isOptionStratLike(value = {}) {
  const cardType = lower(value.cardType || value.card?.type);
  return value.instrumentType === 'OPT'
    || lower(value.event) === 'optionstrat'
    || lower(value.provider) === 'optionstrat'
    || cardType === 'option'
    || cardType === 'optionstrat'
    || hasLegs(value);
}

function positionIdSeedForInput(value = {}) {
  if (!isOptionStratLike(value)) return null;
  const explicit = text(value.positionId || value.sourcePositionId || value.meta?.positionId);
  if (explicit) return explicit;
  const ticker = text(value.ticker || value.symbol);
  const event = text(value.event);
  const time = text(value.time || value.sourceTime || value.meta?.sourceTime);
  if (ticker && event && time) return `${ticker}:${event}:${time}`;
  const sourceKey = text(value.sourceRowKey || value.meta?.sourceRowKey);
  return sourceKey || null;
}

function cardTypeForInput(value = {}) {
  return isOptionStratLike(value) ? 'option' : null;
}

function createOptionStratPositionInputAdapter() {
  return {
    id: 'optionstrat',
    positionIdSeedForInput,
    cardTypeForInput
  };
}

module.exports = {
  createOptionStratPositionInputAdapter,
  hasLegs,
  isOptionStratLike,
  cardTypeForInput,
  positionIdSeedForInput
};
