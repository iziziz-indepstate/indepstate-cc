function parseListRequest(arg) {
  let source = 'orderCards';
  let rows = 100;
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
    throw new Error('order-cards:list request must be an object');
  }
  if (Object.prototype.hasOwnProperty.call(arg, 'file')) {
    throw new Error('order-cards:list no longer accepts file aliases');
  }
  source = arg.source || source;
  rows = arg.rows || rows;
  return { source, rows };
}

function registerOrderCardsIpcHandlers({
  ipcMain,
  servicesApi
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('ipcMain with handle() is required');
  }
  ipcMain.handle('order-cards:list', async (_evt, arg) => {
    const { source, rows } = parseListRequest(arg);
    if (source !== 'orderCards') {
      throw new Error(`Unknown order-cards source: ${source}`);
    }

    const service = servicesApi?.orderCards;
    if (typeof service?.list === 'function') {
      return service.list({ source, rows });
    }
    return [];
  });
}

module.exports = {
  parseListRequest,
  registerOrderCardsIpcHandlers
};
