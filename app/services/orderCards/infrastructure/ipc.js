function parseListArgs(arg) {
  let file = 'webhooks';
  let rows = 100;
  if (typeof arg === 'number') {
    rows = arg;
  } else if (arg && typeof arg === 'object') {
    file = arg.file || file;
    rows = arg.rows || rows;
  }
  return { file, rows };
}

function registerOrderCardsIpcHandlers({
  ipcMain,
  servicesApi,
  orderService
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('ipcMain with handle() is required');
  }
  ipcMain.handle('order-cards:list', async (_evt, arg) => {
    const { file, rows } = parseListArgs(arg);
    if (file !== 'webhooks') {
      throw new Error(`Unknown order-cards file alias: ${file}`);
    }

    const service = servicesApi?.orderCards || orderService;
    if (typeof service?.list === 'function') {
      return service.list({ rows });
    }
    if (typeof service?.getOrdersList === 'function') {
      return service.getOrdersList(rows);
    }
    return [];
  });
}

module.exports = {
  parseListArgs,
  registerOrderCardsIpcHandlers
};
