const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const electron = require('electron');
const { APP_ROOT, USER_ROOT } = require('../../config/load');

function start(opts = {}) {
  const logFile = path.join(USER_ROOT || APP_ROOT, 'logs', 'tv-proxy.txt');
  const log = opts.log ? (line => {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, line + '\n');
    } catch (e) {
      console.error('[tv-proxy log]', e.message);
    }
  }) : () => {};

  log(`[start] opts ${JSON.stringify(opts)}`);
  const proxyPort = opts.proxyPort || 8888;
  const listeners = Array.isArray(opts.listeners) ? opts.listeners.slice() : [];

  const roots = [];
  const asarRoot = electron.app?.getAppPath ? electron.app.getAppPath() : APP_ROOT;
  roots.push(asarRoot);
  if (USER_ROOT && USER_ROOT !== asarRoot) roots.push(USER_ROOT);
  if (APP_ROOT !== asarRoot) roots.push(APP_ROOT);
  let script;
  for (const root of roots) {
    const candidate = path.join(root, 'extensions', 'mitmproxy', 'tv-wslog.py');
    log(`[addon] try ${candidate}`);
    if (fs.existsSync(candidate)) { script = candidate; break; }
  }
  if (script) {
    log(`[addon] use ${script}`);
    if (script.includes('.asar')) {
      const extracted = path.join(USER_ROOT || APP_ROOT, 'tmp', 'tv-wslog.py');
      try {
        fs.mkdirSync(path.dirname(extracted), { recursive: true });
        fs.copyFileSync(script, extracted);
        script = extracted;
        log(`[addon] extracted to ${script}`);
      } catch (e) {
        log(`[addon] extract failed: ${e.message}`);
      }
    }
  } else {
    log('[addon] tv-wslog.py not found');
    console.error('[tv-proxy] tv-wslog.py not found');
    return { stop() {} };
  }
  const args = [
    '-s', script,
    '-p', String(proxyPort),
    '-q',
    '--set', 'console_eventlog_verbosity=error',
    '--set', 'console_flowlist_verbosity=error',
    '--set', 'flow_detail=0',
  ];
  log(`[spawn] mitmdump ${args.join(' ')}`);
  const proc = spawn('mitmdump', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`[tv-proxy] mitmdump started on 127.0.0.1:${proxyPort}`);

  proc.stdout.setEncoding('utf8');
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      log(`[stdout] ${line}`);
      try {
        const rec = JSON.parse(line);
        for (const fn of listeners) {
          try { fn(rec); } catch {}
        }
      } catch {}
    }
  });

  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) log(`[stderr] ${line}`);
    }
  });

  proc.on('exit', (code, sig) => {
    const msg = `[exit] code=${code} sig=${sig || ''}`;
    log(msg);
    console.error(`[tv-proxy] mitmdump exited: code=${code} sig=${sig || ''}`);
  });

  return {
    addListener(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.push(fn);
      return () => {
        const index = listeners.indexOf(fn);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    stop() {
      log('[stop] sending SIGTERM');
      try { proc.kill('SIGTERM'); } catch {}
    }
  };
}

module.exports = { start };
