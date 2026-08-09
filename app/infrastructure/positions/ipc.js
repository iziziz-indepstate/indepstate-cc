const { debugPositionEvents, positionDebugSummary } = require('../../debugPositionEvents');

function positionSnapshots(positionsService) {
  const snapshot = typeof positionsService?.snapshot === 'function'
    ? positionsService.snapshot()
    : {};
  return Array.isArray(snapshot.positions) ? snapshot.positions : [];
}

function registerPositionsIpcHandlers({ ipcMain, positionsService } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('ipcMain with handle() is required');
  }

  ipcMain.handle('positions:list', async () => positionSnapshots(positionsService));
  ipcMain.handle('positions:remove', async (_evt, payload = {}) => {
    if (!positionsService || typeof positionsService.remove !== 'function') {
      return { ok: false, reason: 'Positions service does not support remove' };
    }
    return positionsService.remove({
      positionId: payload.positionId || payload.id,
      reason: payload.reason
    });
  });
}

function createPositionsChangedPublisher({ positionsService, getMainWindow } = {}) {
  const events = positionsService?.events;
  if (!events || typeof events.on !== 'function') {
    return { dispose() {} };
  }

  const handler = (event, position) => {
    const mainWindow = typeof getMainWindow === 'function' ? getMainWindow() : null;
    const hasMainWindow = !!mainWindow;
    const destroyed = hasMainWindow && typeof mainWindow.isDestroyed === 'function' ? mainWindow.isDestroyed() : undefined;
    debugPositionEvents('positions:changed:send', {
      eventType: event?.type || '',
      ...positionDebugSummary(position),
      hasMainWindow,
      destroyed
    });
    if (!mainWindow || typeof mainWindow.isDestroyed !== 'function' || destroyed) return;
    mainWindow.webContents?.send?.('positions:changed', { event, position });
  };

  events.on('event', handler);
  return {
    dispose() {
      if (typeof events.off === 'function') events.off('event', handler);
      else if (typeof events.removeListener === 'function') events.removeListener('event', handler);
    }
  };
}

module.exports = {
  registerPositionsIpcHandlers,
  createPositionsChangedPublisher,
  positionSnapshots
};
