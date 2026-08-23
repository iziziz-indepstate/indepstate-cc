function registerPendingOrdersIpcHandlers({
  ipcMain,
  pendingHub,
  queuePlaceOrder
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('ipcMain with handle() is required');
  }
  if (!pendingHub) {
    throw new Error('pendingHub is required');
  }
  if (typeof queuePlaceOrder === 'function') {
    ipcMain.handle('queue-place-order', async (_evt, payload) => queuePlaceOrder(payload));
  }
  ipcMain.handle('pending:preview-place', async (_evt, payload = {}) => pendingHub.previewPlacePending(payload));
  ipcMain.handle('queue-place-pending', async (_evt, payload) => pendingHub.queuePlacePending(payload));
  ipcMain.handle('pending:cancel', async (_evt, pendingId) => pendingHub.cancelPending(pendingId));
}

module.exports = {
  registerPendingOrdersIpcHandlers
};
