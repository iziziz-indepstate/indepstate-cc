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
  const { getOrderWindows, isMainAppWindow } = require('../app/services/commandLine/manifest');
  assert.strictEqual(isMainAppWindow(levelTrackWindow), false);
  assert.strictEqual(isMainAppWindow(mainWindow), true);
  assert.deepStrictEqual(getOrderWindows(), [mainWindow]);

  levelTrackWindow.webContents.getURL = () => 'file:///app/services/levelTrack/window.html';
  mainWindow.isDestroyed = () => true;
  assert.deepStrictEqual(getOrderWindows(), []);
  console.log('commandLine window routing tests passed');
} finally {
  Module._load = originalLoad;
}
