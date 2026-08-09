function isRegularLegacyRow(row = {}) {
  const cardType = row?.cardType ?? row?.type ?? 'regular';
  return String(cardType || 'regular') === 'regular';
}

function isSnapshotBackedRow(row = {}) {
  const cardType = row?.cardType ?? row?.type ?? '';
  return String(cardType || '').trim() === 'levelOrder';
}

function shouldCreatePositionSnapshot(row = {}) {
  const cardType = row?.cardType ?? row?.type ?? '';
  return ['levelOrder', 'option', 'optionstrat'].includes(String(cardType || '').trim());
}

function shouldRouteRowToLegacyRuntime(row = {}) {
  if (isSnapshotBackedRow(row)) return false;
  return !isRegularLegacyRow(row);
}

module.exports = {
  isRegularLegacyRow,
  isSnapshotBackedRow,
  shouldCreatePositionSnapshot,
  shouldRouteRowToLegacyRuntime
};
