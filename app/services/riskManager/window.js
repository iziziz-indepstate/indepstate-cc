const { ipcRenderer } = require('electron');

const $config = document.getElementById('config');
const $positions = document.getElementById('positions');
const $logs = document.getElementById('logs');
const $status = document.getElementById('status');
const $error = document.getElementById('error');

let state = { config: {}, positions: [], logs: [] };

function fmtMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '-';
}

function fmtTime(value) {
  const n = Number(value);
  return Number.isFinite(n) ? new Date(n).toLocaleTimeString() : '-';
}

function cls(status) {
  if (status === 'ok') return 'ok';
  if (status === 'breached' || status === 'close-failed' || status === 'error') return 'bad';
  if (status === 'warning') return 'warn';
  return 'muted';
}

function render(next) {
  state = next || state;
  $status.textContent = `${state.positions.length} positions, ${state.logs.length} log rows`;
  $config.value = JSON.stringify(state.config || {}, null, 2);
  $positions.innerHTML = '';
  for (const pos of state.positions || []) {
    const snap = pos.snapshot || {};
    const warnings = (snap.warnings || []).join('; ');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${pos.provider}<br><span class="muted">${pos.ticket}</span></td>
      <td>${pos.symbol || '-'} <span class="pill">${pos.side || '-'}</span><br><span class="muted">qty ${snap.qty ?? '-'}</span></td>
      <td>Stop ${fmtMoney(snap.stopRiskUsd)} / ${fmtMoney(pos.limits?.maxStopRiskUsd)}<br>Loss ${fmtMoney(snap.openLossUsd)} / ${fmtMoney(pos.limits?.maxOpenLossUsd)}</td>
      <td><span class="${cls(pos.riskStatus)}">${pos.riskStatus || 'pending'}</span><br><span class="muted">${warnings || pos.closeReason || ''}</span></td>
      <td><button class="danger" data-key="${pos.key}">Close</button></td>
    `;
    $positions.appendChild(tr);
  }
  $logs.innerHTML = '';
  for (const log of state.logs || []) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtTime(log.ts)}</td>
      <td>${log.provider || '-'}</td>
      <td>${log.symbol || '-'}<br><span class="muted">${log.ticket || ''}</span></td>
      <td>${log.reason || log.check || log.type || '-'}</td>
      <td>${log.result?.status || ''} ${log.result?.reason || ''}</td>
    `;
    $logs.appendChild(tr);
  }
}

async function refresh() {
  $error.textContent = '';
  render(await ipcRenderer.invoke('risk-manager:list'));
}

document.getElementById('refresh').addEventListener('click', async () => {
  $error.textContent = '';
  render(await ipcRenderer.invoke('risk-manager:refresh'));
});

document.getElementById('save').addEventListener('click', async () => {
  try {
    const config = JSON.parse($config.value);
    const result = await ipcRenderer.invoke('risk-manager:save', config);
    if (result?.errors?.length) $error.textContent = result.errors.join('; ');
    render(await ipcRenderer.invoke('risk-manager:list'));
  } catch (err) {
    $error.textContent = err?.message || String(err);
  }
});

$positions.addEventListener('click', async event => {
  const key = event.target?.dataset?.key;
  if (!key) return;
  $error.textContent = '';
  await ipcRenderer.invoke('risk-manager:close-position', { key, reason: 'manual risk-manager close' });
  render(await ipcRenderer.invoke('risk-manager:list'));
});

ipcRenderer.on('risk-manager:state', (_event, data) => render(data));
refresh();
