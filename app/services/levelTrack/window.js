const { ipcRenderer } = require('electron');

let current = { config: { refreshMs: 1000, timeoutMs: 5000, groups: [] }, states: [] };
let dirty = false;

function qs(id) {
  return document.getElementById(id);
}

function toast(message) {
  const el = qs('toast');
  el.textContent = message;
  el.style.display = 'block';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.style.display = 'none'; }, 3000);
}

function fmt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

function stateFor(key) {
  return (current.states || []).find(state => state.key === key) || {};
}

function markDirty() {
  dirty = true;
}

function isEditingGroupField() {
  const active = document.activeElement;
  return !!active && active.matches?.('tr[data-key] input[data-field]');
}

function readGroups() {
  return Array.from(document.querySelectorAll('tr[data-key]')).map(row => ({
    key: row.querySelector('[data-field="key"]').value.trim(),
    enabled: row.querySelector('[data-field="enabled"]').checked,
    ticker: row.querySelector('[data-field="ticker"]').value.trim(),
    levels: Array.from(row.querySelectorAll('[data-field="level"]'))
      .map(input => Number(String(input.value).trim().replace(',', '.')))
      .filter(value => Number.isFinite(value) && value > 0),
    maxOffset: Number(row.querySelector('[data-field="maxOffset"]').value)
  })).filter(group => group.key && group.ticker);
}

function createLevelInput(value = '') {
  const wrap = document.createElement('span');
  wrap.className = 'level-item';
  const input = document.createElement('input');
  input.dataset.field = 'level';
  input.type = 'number';
  input.step = 'any';
  input.value = fmt(value);
  input.addEventListener('input', markDirty);
  input.addEventListener('change', markDirty);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'level-remove';
  remove.textContent = 'x';
  remove.addEventListener('click', () => {
    wrap.remove();
    markDirty();
  });
  wrap.appendChild(input);
  wrap.appendChild(remove);
  return wrap;
}

function renderLevels(container, levels = []) {
  container.innerHTML = '';
  for (const level of levels) container.appendChild(createLevelInput(level));
  if (!levels.length) container.appendChild(createLevelInput(''));
  const add = document.createElement('button');
  add.type = 'button';
  add.textContent = '+ Level';
  add.addEventListener('click', () => {
    container.insertBefore(createLevelInput(''), add);
    markDirty();
  });
  container.appendChild(add);
}

function render(data = current) {
  current = data;
  const tbody = qs('groups');
  tbody.innerHTML = '';
  const groups = current.config?.groups || [];
  qs('empty').style.display = groups.length ? 'none' : 'block';
  for (const group of groups) {
    const state = stateFor(group.key);
    const tr = document.createElement('tr');
    tr.dataset.key = group.key;
    const status = state.status || 'idle';
    tr.innerHTML = `
      <td><input data-field="enabled" type="checkbox" ${group.enabled !== false ? 'checked' : ''}></td>
      <td><input data-field="key" class="key" value="${escapeHtml(group.key || '')}"></td>
      <td><input data-field="ticker" value="${escapeHtml(group.ticker || '')}"></td>
      <td><div class="levels" data-field="levels"></div></td>
      <td><input data-field="maxOffset" type="number" step="any" value="${fmt(group.maxOffset)}"></td>
      <td class="number" data-cell="price">${fmt(state.price)}</td>
      <td class="number" data-cell="activeLevel">${fmt(state.activeLevel)}</td>
      <td data-cell="status"><span class="status ${status}"><span class="dot"></span>${escapeHtml(state.reason || status)}</span></td>
      <td><button class="danger" data-action="remove">Remove</button></td>
    `;
    renderLevels(tr.querySelector('[data-field="levels"]'), group.levels || []);
    for (const input of tr.querySelectorAll('input')) {
      input.addEventListener('input', markDirty);
      input.addEventListener('change', markDirty);
    }
    tr.querySelector('[data-action="remove"]').addEventListener('click', () => {
      tr.remove();
      markDirty();
      qs('empty').style.display = document.querySelectorAll('tr[data-key]').length ? 'none' : 'block';
    });
    tbody.appendChild(tr);
  }
}

function renderStateOnly(data = current) {
  current = { ...current, states: data.states || [] };
  for (const row of document.querySelectorAll('tr[data-key]')) {
    const key = row.querySelector('[data-field="key"]')?.value.trim() || row.dataset.key;
    const state = stateFor(key);
    const status = state.status || 'idle';
    const priceCell = row.querySelector('[data-cell="price"]');
    const activeCell = row.querySelector('[data-cell="activeLevel"]');
    const statusCell = row.querySelector('[data-cell="status"]');
    if (priceCell) priceCell.textContent = fmt(state.price);
    if (activeCell) activeCell.textContent = fmt(state.activeLevel);
    if (statusCell) {
      statusCell.innerHTML = `<span class="status ${status}"><span class="dot"></span>${escapeHtml(state.reason || status)}</span>`;
    }
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function load() {
  try {
    render(await ipcRenderer.invoke('level-track:list'));
  } catch (err) {
    toast(err.message || String(err));
  }
}

async function save() {
  try {
    const config = {
      refreshMs: current.config?.refreshMs || 1000,
      timeoutMs: current.config?.timeoutMs || 5000,
      groups: readGroups()
    };
    const result = await ipcRenderer.invoke('level-track:save', config);
    if (result?.errors?.length) toast(result.errors.join('; '));
    else toast('Saved');
    dirty = false;
    render(await ipcRenderer.invoke('level-track:list'));
  } catch (err) {
    toast(err.message || String(err));
  }
}

async function refresh() {
  try {
    await save();
    await ipcRenderer.invoke('level-track:refresh');
  } catch (err) {
    toast(err.message || String(err));
  }
}

qs('add').addEventListener('click', () => {
  const idx = (current.config?.groups?.length || 0) + 1;
  const groups = readGroups();
  groups.push({ key: `group-${idx}`, enabled: true, ticker: '', levels: [], maxOffset: 0 });
  markDirty();
  render({ ...current, config: { ...(current.config || {}), groups } });
});
qs('save').addEventListener('click', save);
qs('refresh').addEventListener('click', refresh);

ipcRenderer.on('level-track:state', (_event, data) => {
  if (dirty || isEditingGroupField()) renderStateOnly(data);
  else render(data);
});
load();
