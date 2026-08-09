const fs = require('fs');

function readExecutionRows(execLog, rows) {
  let text = '';
  try {
    text = fs.readFileSync(execLog, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const lines = text.split('\n').filter(Boolean);
  const tail = lines.slice(-Math.max(1, rows));
  const result = [];
  for (const line of tail) {
    try {
      result.push(JSON.parse(line));
    } catch {
      // skip bad line
    }
  }
  return result;
}

function registerOrderListIpcHandlers({
  ipcMain,
  orderService,
  execLog
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('ipcMain with handle() is required');
  }
  ipcMain.handle('orders:list', async (_evt, arg) => {
    let file = 'webhooks';
    let rows = 100;
    if (typeof arg === 'number') {
      rows = arg;
    } else if (arg && typeof arg === 'object') {
      file = arg.file || file;
      rows = arg.rows || rows;
    }

    if (file === 'webhooks') {
      if (typeof orderService?.list === 'function') {
        return orderService.list({ rows });
      }
      if (typeof orderService?.getOrdersList === 'function') {
        return orderService.getOrdersList(rows);
      }
      return [];
    }
    if (file === 'executions') {
      return readExecutionRows(execLog, rows);
    }

    throw new Error(`Unknown file alias: ${file}`);
  });
}

module.exports = {
  registerOrderListIpcHandlers,
  readExecutionRows
};
