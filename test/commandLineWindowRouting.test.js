const assert = require('assert');
const Module = require('module');

function makeWindow(url) {
  return {
    isDestroyed: () => false,
    webContents: {
      getURL: () => url,
      send() {}
    }
  };
}

const levelTrackWindow = makeWindow('file:///app/services/levelTrack/window.html');
const mainWindow = makeWindow('file:///app/index.html');
const destroyedWindow = {
  isDestroyed: () => true,
  webContents: {
    getURL: () => 'file:///app/index.html',
    send() {}
  }
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle() {} },
      BrowserWindow: {
        getAllWindows: () => [levelTrackWindow, destroyedWindow, mainWindow]
      }
    };
  }
  return originalLoad(request, parent, isMain);
};

try {
  const manifestPath = require.resolve('../app/services/commandLine/manifest');
  delete require.cache[manifestPath];
  const { getOrderWindows, initService, isMainAppWindow } = require('../app/services/commandLine/manifest');
  assert.strictEqual(isMainAppWindow(levelTrackWindow), false);
  assert.strictEqual(isMainAppWindow(mainWindow), true);
  assert.deepStrictEqual(getOrderWindows(), [mainWindow]);

  levelTrackWindow.webContents.getURL = () => 'file:///app/services/levelTrack/window.html';
  mainWindow.isDestroyed = () => true;
  assert.deepStrictEqual(getOrderWindows(), []);

  const calls = [];
  const servicesApi = {
    commands: [],
    orderCards: {
      ingestRow(row, context) {
        calls.push({ method: 'ingestRow', row, context });
        return row;
      },
      remove(filter) {
        calls.push({ method: 'remove', filter });
        return { ok: true };
      }
    }
  };
  const commandLine = initService(servicesApi);
  assert.deepStrictEqual(commandLine.run('add AAPL 100 10'), { ok: true });
  assert.strictEqual(calls[0].method, 'ingestRow');
  assert.strictEqual(calls[0].row.ticker, 'AAPL');
  assert.deepStrictEqual(calls[0].context, { source: 'commandLine' });
  assert.deepStrictEqual(commandLine.run('rm producingLineId:line-1'), { ok: true });
  assert.deepStrictEqual(calls[1], { method: 'remove', filter: { producingLineId: 'line-1' } });

  console.log('commandLine window routing tests passed');
} finally {
  Module._load = originalLoad;
}
