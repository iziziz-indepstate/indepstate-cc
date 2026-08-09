function isRegularLegacyRow(row = {}) {
  const cardType = row?.cardType ?? row?.type ?? 'regular';
  return String(cardType || 'regular') === 'regular';
}

function shouldRouteRowToLegacyRuntime(row = {}) {
  return !isRegularLegacyRow(row);
}

module.exports = {
  isRegularLegacyRow,
  shouldRouteRowToLegacyRuntime
};
