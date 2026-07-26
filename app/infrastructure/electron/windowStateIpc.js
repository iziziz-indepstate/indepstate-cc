function registerWindowStateIpcHandlers({
  ipcMain,
  getWindowStateSnapshot,
  setWindowState
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('ipcMain with handle() is required');
  }
  ipcMain.handle('window:get-state', () => getWindowStateSnapshot());
  ipcMain.handle('window:set-state', (_evt, state) => setWindowState(state));
}

module.exports = {
  registerWindowStateIpcHandlers
};
