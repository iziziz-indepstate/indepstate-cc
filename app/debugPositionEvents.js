function isDebugPositionEventsEnabled() {
  const env = typeof process !== 'undefined' ? process.env : null;
  return String(env?.ISCC_DEBUG_POSITION_EVENTS || '').trim() === '1';
}

function positionDebugSummary(position = {}) {
  return {
    id: position?.id || '',
    ticker: position?.ticker || position?.symbol || position?.card?.data?.ticker || position?.card?.data?.symbol || '',
    cardType: position?.card?.type || position?.source?.cardType || ''
  };
}

function sendRendererPositionDebugEvent(payload) {
  if (typeof window === 'undefined') return;
  try {
    const { ipcRenderer } = require('electron');
    ipcRenderer?.send?.('debug:position-events', payload);
  } catch {
  }
}

function debugPositionEvents(scope, details = {}, level = 'log') {
  if (!isDebugPositionEventsEnabled()) return;
  const payload = { scope, details, level };
  sendRendererPositionDebugEvent(payload);
  const method = level === 'warn' ? 'warn' : 'log';
  console[method]?.('[position-events]', scope, details);
}

module.exports = {
  isDebugPositionEventsEnabled,
  positionDebugSummary,
  debugPositionEvents
};
