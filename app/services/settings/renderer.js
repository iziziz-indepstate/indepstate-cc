function createSettingsRenderer({
  ipcRenderer,
  settingsRuntime,
  loadConfig,
  path,
  baseDir,
  document,
  elements,
  toast,
  render
} = {}) {
  const {
    settingsBtn: $settingsBtn,
    settingsPanel: $settingsPanel,
    settingsSections: $settingsSections,
    settingsFields: $settingsFields,
    settingsClose: $settingsClose,
    settingsRestart: $settingsRestart
  } = elements || {};
  const settingsForms = new Map();
  const DESCRIPTOR_META_KEYS = new Set(['description', 'type', 'item', 'default', 'enum']);
function renderRestartStatus(status = []) {
  if (!$settingsRestart) return;
  const entries = Array.isArray(status) ? status : [];
  if (!entries.length) {
    $settingsRestart.style.display = 'none';
    $settingsRestart.textContent = '';
    $settingsBtn.classList.remove('settings-restart-required');
    $settingsBtn.title = 'Settings';
    return;
  }
  $settingsRestart.textContent = `Restart required: ${entries.map(entry => `${entry.section} (${(entry.paths || []).join(', ')})`).join('; ')}`;
  $settingsRestart.style.display = 'block';
  $settingsBtn.classList.add('settings-restart-required');
  $settingsBtn.title = $settingsRestart.textContent;
}

function loadSettingsSections() {
  settingsForms.clear();
  ipcRenderer.invoke('settings:restart-status').then(renderRestartStatus).catch(() => {});
  ipcRenderer.invoke('settings:list').then((sections = []) => {
    $settingsSections.innerHTML = '';
    let prevGroup;
    sections.forEach((s, idx) => {
      if (idx > 0 && (s.group !== prevGroup || idx === 3)) {
        const hr = document.createElement('hr');
        $settingsSections.appendChild(hr);
      }
      prevGroup = s.group;
      const div = document.createElement('div');
      div.textContent = s.name;
      div.dataset.section = s.key;
      div.addEventListener('click', () => showSection(s.key));
      $settingsSections.appendChild(div);
    });
    if (sections[0]) showSection(sections[0].key);
  }).catch(() => {
  });
}

function setNestedSettingValue(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const nextIsIndex = /^\d+$/.test(parts[i + 1]);
    if (nextIsIndex) {
      if (!Array.isArray(cur[part])) cur[part] = [];
    } else if (typeof cur[part] !== 'object' || cur[part] === null || Array.isArray(cur[part])) {
      cur[part] = {};
    }
    cur = cur[part];
  }
  const last = parts[parts.length - 1];
  if (/^\d+$/.test(last)) cur[Number(last)] = value;
  else cur[last] = value;
}

function getNestedSettingValue(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((value, part) => value == null ? undefined : value[part], obj);
}

function deleteNestedSettingValue(obj, path) {
  const parts = String(path || '').split('.').filter(Boolean);
  if (!parts.length) return;
  const parent = parts.slice(0, -1)
    .reduce((value, part) => value == null ? undefined : value[part], obj);
  if (parent && typeof parent === 'object') delete parent[parts.at(-1)];
}

function cloneSettingsValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function serializeStructuredSettingsForm(form, name) {
  const data = {};
  for (const input of form.querySelectorAll('input')) {
    const key = input.dataset.field;
    if (!key) continue;
    if (key.split('.').some(part => part.startsWith('__'))) continue;
    let value;
    if (input.dataset.arrayMarker === '1') value = [];
    else if (input.type === 'checkbox') value = input.checked;
    else if (input.type === 'number') value = input.value === '' ? null : Number(input.value);
    else value = input.value;
    setNestedSettingValue(data, key, value);
  }
  for (const group of form.querySelectorAll('.settings-dynamic-map[data-setting-path]')) {
    const values = {};
    const valueRole = group.dataset.valueRole || 'value';
    for (const row of group.querySelectorAll('.settings-dynamic-map-row')) {
      const symbol = row.querySelector('input[data-role="symbol"]')?.value.trim();
      const value = Number(row.querySelector(`input[data-role="${valueRole}"]`)?.value);
      if (symbol && Number.isFinite(value) && value > 0) values[symbol] = value;
    }
    setNestedSettingValue(data, group.dataset.settingPath, values);
  }
  return data;
}

function setRawSettingsError(form, message = '') {
  const error = form.querySelector('[data-role="raw-json-error"]');
  if (!error) return;
  error.textContent = message;
  error.style.display = message ? 'block' : 'none';
}

function parseRawSettingsForm(form) {
  const editor = form.querySelector('textarea[data-role="raw-json"]');
  if (!editor) return serializeStructuredSettingsForm(form, form.dataset.section);
  try {
    const config = JSON.parse(editor.value);
    if (form.dataset.rawEditorType === 'array' && !Array.isArray(config)) {
      throw new Error('Configuration must be a JSON array');
    }
    if (form.dataset.rawEditorType !== 'array' && (!config || typeof config !== 'object' || Array.isArray(config))) {
      throw new Error('Configuration must be a JSON object');
    }
    setRawSettingsError(form);
    return config;
  } catch (error) {
    setRawSettingsError(form, error?.message || String(error));
    throw error;
  }
}

function serializeSettingsForm(form, name) {
  if (form.dataset.editorMode !== 'json') return serializeStructuredSettingsForm(form, name);
  const rawConfig = parseRawSettingsForm(form);
  const rawPath = form.dataset.rawEditorPath || '';
  if (!rawPath) return rawConfig;
  const config = serializeStructuredSettingsForm(form, name);
  setNestedSettingValue(config, rawPath, rawConfig);
  return config;
}

function getSettingsInput(form, field) {
  return form.querySelector(`input[data-field="${field}"]`);
}

function setSettingsInputValue(form, field, value) {
  const input = getSettingsInput(form, field);
  if (!input) return;
  input.value = value == null ? '' : String(value);
  form.dataset.dirty = '1';
}

function formatWindowState(state) {
  const value = (key) => Number.isFinite(state?.[key]) ? String(Math.trunc(state[key])) : '-';
  return `width ${value('width')} / height ${value('height')} / x ${value('x')} / y ${value('y')}`;
}

function appendUiWindowStateTools(form, parent = form) {
  const group = document.createElement('div');
  group.className = 'settings-group settings-window-state';

  const title = document.createElement('div');
  title.className = 'settings-group-title';
  title.textContent = 'Current window';
  group.appendChild(title);

  const current = document.createElement('div');
  current.className = 'settings-window-state-current';
  current.textContent = 'width - / height - / x - / y -';
  group.appendChild(current);

  const actions = document.createElement('div');
  actions.className = 'settings-window-state-actions';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.textContent = 'Refresh';
  actions.appendChild(refreshBtn);

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.textContent = 'Use current window';
  actions.appendChild(applyBtn);

  group.appendChild(actions);
  parent.insertBefore(group, parent.firstChild);

  let lastState = null;
  const refresh = () => ipcRenderer.invoke('window:get-state')
    .then((state = {}) => {
      lastState = state;
      current.textContent = formatWindowState(state);
      return state;
    })
    .catch(() => null);

  refreshBtn.addEventListener('click', refresh);
  applyBtn.addEventListener('click', () => {
    const apply = (state) => {
      if (!state) return;
      for (const field of ['width', 'height', 'x', 'y']) {
        if (Number.isFinite(state[field])) setSettingsInputValue(form, field, Math.trunc(state[field]));
      }
    };
    if (lastState) {
      apply(lastState);
      return;
    }
    refresh().then(apply);
  });

  refresh();
}

function appendNumericSymbolMapTools(form, {
  path,
  title,
  values = {},
  valuePlaceholder,
  valueRole = 'value',
  rowClass = '',
  addLabel = 'Add symbol override',
  onChange
} = {}, parent = form) {
  const group = document.createElement('div');
  group.className = 'settings-group settings-dynamic-map';
  group.dataset.settingPath = path;
  group.dataset.valueRole = valueRole;

  const titleElement = document.createElement('div');
  titleElement.className = 'settings-group-title';
  titleElement.textContent = title;
  group.appendChild(titleElement);

  const rows = document.createElement('div');
  rows.className = 'settings-dynamic-map-rows';
  group.appendChild(rows);

  const markDirty = () => {
    form.dataset.dirty = '1';
    onChange?.();
  };
  const addRow = (symbol = '', numericValue = '') => {
    const row = document.createElement('div');
    row.className = `settings-dynamic-map-row ${rowClass}`.trim();
    row.style.display = 'grid';
    row.style.gridTemplateColumns = '1fr 110px auto';
    row.style.gap = '8px';
    row.style.alignItems = 'center';
    row.style.marginBottom = '8px';

    const symbolInput = document.createElement('input');
    symbolInput.type = 'text';
    symbolInput.placeholder = 'SYMBOL';
    symbolInput.value = symbol;
    symbolInput.dataset.role = 'symbol';
    symbolInput.addEventListener('input', markDirty);
    row.appendChild(symbolInput);

    const valueInput = document.createElement('input');
    valueInput.type = 'number';
    valueInput.step = 'any';
    valueInput.placeholder = valuePlaceholder;
    valueInput.value = numericValue == null ? '' : String(numericValue);
    valueInput.dataset.role = valueRole;
    valueInput.addEventListener('input', markDirty);
    row.appendChild(valueInput);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.className = 'settings-array-remove';
    remove.addEventListener('click', () => {
      row.remove();
      markDirty();
    });
    row.appendChild(remove);
    rows.appendChild(row);
  };

  Object.entries(values || {}).forEach(([symbol, value]) => addRow(symbol, value));

  const add = document.createElement('button');
  add.type = 'button';
  add.textContent = addLabel;
  add.className = 'settings-array-add';
  add.addEventListener('click', () => {
    addRow('', '');
    markDirty();
  });
  group.appendChild(add);
  parent.appendChild(group);
}

function numericSymbolMapSpecs(name, config = {}) {
  if (name === 'tick-sizes') {
    return [{
      path: 'bySymbol',
      title: 'Tick size overrides by symbol',
      values: config.bySymbol || {},
      valuePlaceholder: 'Tick size',
      valueRole: 'tickSize',
      rowClass: 'tick-size-symbol-row'
    }];
  }
  if (name === 'order-calculator') {
    return [{
      path: 'riskUsd.bySymbol',
      title: 'Default risk overrides by symbol',
      values: config.riskUsd?.bySymbol || {},
      valuePlaceholder: 'Risk $',
      valueRole: 'riskUsd',
      rowClass: 'risk-symbol-row'
    }];
  }
  return [];
}

function showSection(name) {
  [...$settingsSections.querySelectorAll('div[data-section]')].forEach(d => {
    d.classList.toggle('active', d.dataset.section === name);
  });
  const existing = settingsForms.get(name);
  if (existing) {
    $settingsFields.innerHTML = '';
    $settingsFields.appendChild(existing);
    return;
  }
  ipcRenderer.invoke('settings:get', name).then((res = {}) => {
    const cfg = res.config || res;
    const descriptorProperties = (res.descriptor && res.descriptor.properties) || {};
    const rawEditorDescriptor = descriptorProperties.rawEditor === true
      ? {}
      : (descriptorProperties.rawEditor && typeof descriptorProperties.rawEditor === 'object'
          ? descriptorProperties.rawEditor
          : null);
    const desc = cloneSettingsValue((res.descriptor && res.descriptor.options) || {});
    const dynamicMapPaths = numericSymbolMapSpecs(name, cfg).map(spec => spec.path);
    dynamicMapPaths.forEach(mapPath => deleteNestedSettingValue(desc, mapPath));
    const form = document.createElement('form');
    form.dataset.section = name;
    form.dataset.editorMode = 'form';
    const structuredEditor = document.createElement('div');
    structuredEditor.className = 'settings-structured-editor';
    form.appendChild(structuredEditor);
    let structuredEditorChanged = false;
    let structuredConfigValue = cfg;
    const markStructuredDirty = () => {
      structuredEditorChanged = true;
      form.dataset.dirty = '1';
    };
    const hasOwn = Object.prototype.hasOwnProperty;
    const getDefault = (d) => (d && hasOwn.call(d, 'default') ? d.default : undefined);
    const build = (parent, cfgObj, descObj, prefix = '') => {
      const hasItemDesc = !!(descObj && typeof descObj === 'object' && !Array.isArray(descObj) && descObj.item);
      if (Array.isArray(cfgObj) || Array.isArray(descObj) || hasItemDesc) {
        const arr = Array.isArray(cfgObj) ? cfgObj : [];
        const itemDesc = Array.isArray(descObj)
          ? descObj[0]
          : hasItemDesc
            ? descObj.item
            : (descObj && descObj.item) || {};
        const itemsWrap = document.createElement('div');
        const baseParts = prefix ? prefix.split('.') : [];
        const itemIsObjDesc = itemDesc && typeof itemDesc === 'object' && !itemDesc.type && Object.keys(itemDesc).length;
        if (prefix) {
          const marker = document.createElement('input');
          marker.type = 'hidden';
          marker.dataset.field = prefix;
          marker.dataset.arrayMarker = '1';
          marker.value = '';
          parent.appendChild(marker);
        }
        const renderItem = (val, idx) => {
          const d = itemDesc;
          const defaultVal = getDefault(d);
          const effectiveVal = val !== undefined ? val : defaultVal;
          const isObj = (effectiveVal && typeof effectiveVal === 'object' && !Array.isArray(effectiveVal)) || itemIsObjDesc;
          const path = prefix ? `${prefix}.${idx}` : String(idx);
          if (isObj) {
            const group = document.createElement('div');
            group.className = 'settings-group';
            const head = document.createElement('div');
            head.style.display = 'flex';
            head.style.alignItems = 'center';
            const title = document.createElement('div');
            title.className = 'settings-group-title';
            title.textContent = (d && d.description) || String(idx);
            head.appendChild(title);
            const rm = document.createElement('button');
            rm.type = 'button';
            rm.textContent = '×';
            rm.className = 'settings-array-remove';
            rm.addEventListener('click', () => {
              itemsWrap.removeChild(group);
              reindex();
              markStructuredDirty();
            });
            head.appendChild(rm);
            group.appendChild(head);
            const nested = effectiveVal && typeof effectiveVal === 'object' ? effectiveVal : {};
            build(group, nested, d || {}, path);
            itemsWrap.appendChild(group);
          } else {
            const label = document.createElement('label');
            const span = document.createElement('span');
            span.textContent = (d && d.description) || String(idx);
            label.appendChild(span);
            let input;
            const type = (d && d.type) || typeof effectiveVal;
            if (type === 'boolean') {
              input = document.createElement('input');
              input.type = 'checkbox';
              if (val !== undefined) input.checked = !!val;
              else if (defaultVal !== undefined) input.checked = !!defaultVal;
              else input.checked = false;
            } else if (type === 'number') {
              input = document.createElement('input');
              input.type = 'number';
              const initial = val !== undefined ? val : defaultVal;
              input.value = initial ?? '';
            } else {
              input = document.createElement('input');
              input.type = 'text';
              const initial = val !== undefined ? val : defaultVal;
              input.value = initial ?? '';
            }
            input.dataset.field = path;
            input.addEventListener('input', () => {
              markStructuredDirty();
            });
            input.addEventListener('change', () => {
              markStructuredDirty();
            });
            label.appendChild(input);
            const rm = document.createElement('button');
            rm.type = 'button';
            rm.textContent = '×';
            rm.className = 'settings-array-remove';
            rm.addEventListener('click', () => {
              itemsWrap.removeChild(label);
              reindex();
              markStructuredDirty();
            });
            label.appendChild(rm);
            itemsWrap.appendChild(label);
          }
        };
        const reindex = () => {
          Array.from(itemsWrap.children).forEach((child, i) => {
            for (const input of child.querySelectorAll('input')) {
              const parts = input.dataset.field.split('.');
              parts[baseParts.length] = String(i);
              input.dataset.field = parts.join('.');
            }
            const t = child.querySelector('.settings-group-title');
            if (t && !(itemDesc && itemDesc.description)) t.textContent = String(i);
          });
        };
        arr.forEach((val, idx) => renderItem(val, idx));
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.textContent = '+';
        addBtn.className = 'settings-array-add';
        addBtn.addEventListener('click', () => {
          let v;
          const defaultVal = getDefault(itemDesc);
          if (itemIsObjDesc) v = {};
          else if (defaultVal !== undefined) v = defaultVal;
          else if (itemDesc && itemDesc.type === 'number') v = 0;
          else if (itemDesc && itemDesc.type === 'boolean') v = false;
          else v = '';
          renderItem(v, itemsWrap.children.length);
          markStructuredDirty();
        });
        parent.appendChild(itemsWrap);
        parent.appendChild(addBtn);
        return;
      }
      const keys = new Set([
        ...Object.keys(cfgObj || {}),
        ...Object.keys(descObj || {})
      ]);
      for (const key of keys) {
        const hasValue = cfgObj && hasOwn.call(cfgObj, key);
        if (String(key).startsWith('__')) continue;
        if (!hasValue && DESCRIPTOR_META_KEYS.has(key)) continue;
        const val = hasValue ? cfgObj[key] : undefined;
        const d = descObj ? descObj[key] : undefined;
        const defaultVal = getDefault(d);
        const effectiveVal = hasValue ? val : defaultVal;
        const isObj = (effectiveVal && typeof effectiveVal === 'object' && !Array.isArray(effectiveVal)) ||
          (d && typeof d === 'object' && !d.type);
        if (isObj) {
          const group = document.createElement('div');
          group.className = 'settings-group';
          const title = document.createElement('div');
          title.className = 'settings-group-title';
          title.textContent = (d && d.description) || key;
          group.appendChild(title);
          const nested = effectiveVal && typeof effectiveVal === 'object' ? effectiveVal : {};
          build(group, nested, d || {}, prefix ? `${prefix}.${key}` : key);
          parent.appendChild(group);
        } else {
          const label = document.createElement('label');
          const span = document.createElement('span');
          span.textContent = (d && d.description) || key;
          label.appendChild(span);
          let input;
          const type = (d && d.type) || typeof effectiveVal;
          if (type === 'boolean') {
            input = document.createElement('input');
            input.type = 'checkbox';
            if (hasValue) input.checked = !!val;
            else if (defaultVal !== undefined) input.checked = !!defaultVal;
            else input.checked = false;
          } else if (type === 'number') {
            input = document.createElement('input');
            input.type = 'number';
            const initial = hasValue ? val : defaultVal;
            input.value = initial ?? '';
          } else {
            input = document.createElement('input');
            input.type = 'text';
            const initial = hasValue ? val : defaultVal;
            input.value = initial ?? '';
          }
          const path = prefix ? `${prefix}.${key}` : key;
          input.dataset.field = path;
          input.addEventListener('input', () => {
            markStructuredDirty();
          });
          input.addEventListener('change', () => {
            markStructuredDirty();
          });
          label.appendChild(input);
          parent.appendChild(label);
        }
      }
    };
    const renderStructuredEditor = (config) => {
      structuredEditor.innerHTML = '';
      const structuredConfig = cloneSettingsValue(config) || {};
      const dynamicMapSpecs = numericSymbolMapSpecs(name, config);
      dynamicMapSpecs.forEach(spec => deleteNestedSettingValue(structuredConfig, spec.path));
      build(structuredEditor, structuredConfig, desc);
      if (name === 'ui') appendUiWindowStateTools(form, structuredEditor);
      dynamicMapSpecs.forEach(spec => {
        appendNumericSymbolMapTools(form, { ...spec, onChange: markStructuredDirty }, structuredEditor);
      });
      structuredConfigValue = config;
      structuredEditorChanged = false;
    };
    renderStructuredEditor(cfg);

    if (rawEditorDescriptor) {
      const rawEditorPath = String(rawEditorDescriptor.path || '');
      const initialRawValue = getNestedSettingValue(cfg, rawEditorPath);
      const rawEditorType = rawEditorDescriptor.type || (Array.isArray(initialRawValue) ? 'array' : 'object');
      form.dataset.rawEditorPath = rawEditorPath;
      form.dataset.rawEditorType = rawEditorType;
      const controls = document.createElement('div');
      controls.className = 'settings-editor-controls';
      const formButton = document.createElement('button');
      formButton.type = 'button';
      formButton.textContent = 'Form';
      formButton.dataset.editorMode = 'form';
      formButton.className = 'active';
      const jsonButton = document.createElement('button');
      jsonButton.type = 'button';
      jsonButton.textContent = rawEditorDescriptor.label || (rawEditorPath ? `${rawEditorPath} JSON` : 'JSON');
      jsonButton.dataset.editorMode = 'json';
      controls.append(formButton, jsonButton);
      form.insertBefore(controls, structuredEditor);

      const rawEditor = document.createElement('div');
      rawEditor.className = 'settings-raw-editor';
      rawEditor.hidden = true;
      const textarea = document.createElement('textarea');
      textarea.dataset.role = 'raw-json';
      textarea.spellcheck = false;
      textarea.setAttribute('aria-label', `${descriptorProperties.name || name} JSON configuration`);
      const error = document.createElement('div');
      error.className = 'settings-raw-error';
      error.dataset.role = 'raw-json-error';
      error.style.display = 'none';
      rawEditor.append(textarea, error);

      if (rawEditorDescriptor.snippets === true && rawEditorType === 'array') {
        const snippetToggle = document.createElement('button');
        snippetToggle.type = 'button';
        snippetToggle.className = 'settings-snippet-toggle';
        snippetToggle.textContent = rawEditorDescriptor.snippetLabel || 'Add JSON snippet';
        const snippetPanel = document.createElement('div');
        snippetPanel.className = 'settings-snippet-panel';
        snippetPanel.hidden = true;
        const snippetEditor = document.createElement('textarea');
        snippetEditor.dataset.role = 'raw-json-snippet';
        snippetEditor.spellcheck = false;
        snippetEditor.placeholder = '{ "event": "event-name", "action": "commandLine:command" }';
        const snippetError = document.createElement('div');
        snippetError.className = 'settings-raw-error';
        snippetError.dataset.role = 'raw-json-snippet-error';
        snippetError.style.display = 'none';
        const snippetActions = document.createElement('div');
        snippetActions.className = 'settings-snippet-actions';
        const appendSnippet = document.createElement('button');
        appendSnippet.type = 'button';
        appendSnippet.textContent = 'Append';
        const cancelSnippet = document.createElement('button');
        cancelSnippet.type = 'button';
        cancelSnippet.textContent = 'Cancel';
        snippetActions.append(appendSnippet, cancelSnippet);
        snippetPanel.append(snippetEditor, snippetError, snippetActions);
        rawEditor.append(snippetToggle, snippetPanel);

        const setSnippetError = (message = '') => {
          snippetError.textContent = message;
          snippetError.style.display = message ? 'block' : 'none';
        };
        snippetToggle.addEventListener('click', () => {
          snippetPanel.hidden = false;
          snippetEditor.focus();
        });
        cancelSnippet.addEventListener('click', () => {
          snippetPanel.hidden = true;
          snippetEditor.value = '';
          setSnippetError();
        });
        appendSnippet.addEventListener('click', () => {
          try {
            const current = parseRawSettingsForm(form);
            const parsed = JSON.parse(snippetEditor.value);
            const additions = Array.isArray(parsed) ? parsed : [parsed];
            if (!additions.length || additions.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
              throw new Error('Snippet must be an action object or an array of action objects');
            }
            textarea.value = JSON.stringify([...current, ...additions], null, 2);
            form.dataset.dirty = '1';
            setRawSettingsError(form);
            setSnippetError();
            snippetEditor.value = '';
            snippetPanel.hidden = true;
            textarea.focus();
          } catch (snippetFailure) {
            setSnippetError(snippetFailure?.message || String(snippetFailure));
            snippetEditor.focus();
          }
        });
      }
      form.appendChild(rawEditor);

      const activateMode = (mode) => {
        if (mode === form.dataset.editorMode) return true;
        if (mode === 'json') {
          const config = structuredEditorChanged
            ? serializeStructuredSettingsForm(form, name)
            : structuredConfigValue;
          const rawValue = getNestedSettingValue(config, rawEditorPath);
          textarea.value = JSON.stringify(
            rawValue === undefined ? (rawEditorType === 'array' ? [] : {}) : rawValue,
            null,
            2
          );
        } else {
          let rawValue;
          try {
            rawValue = parseRawSettingsForm(form);
          } catch {
            textarea.focus();
            return false;
          }
          let rawConfig = cloneSettingsValue(structuredEditorChanged
            ? serializeStructuredSettingsForm(form, name)
            : structuredConfigValue);
          if (rawEditorPath) {
            if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) rawConfig = {};
            setNestedSettingValue(rawConfig, rawEditorPath, rawValue);
          }
          else rawConfig = rawValue;
          renderStructuredEditor(rawConfig);
        }
        form.dataset.editorMode = mode;
        structuredEditor.hidden = mode !== 'form';
        rawEditor.hidden = mode !== 'json';
        formButton.classList.toggle('active', mode === 'form');
        jsonButton.classList.toggle('active', mode === 'json');
        if (mode === 'json') textarea.focus();
        return true;
      };

      formButton.addEventListener('click', () => activateMode('form'));
      jsonButton.addEventListener('click', () => activateMode('json'));
      textarea.addEventListener('input', () => {
        form.dataset.dirty = '1';
        try { parseRawSettingsForm(form); } catch {}
      });
    }
    settingsForms.set(name, form);
    $settingsFields.innerHTML = '';
    $settingsFields.appendChild(form);
  }).catch(() => {
  });
}

$settingsBtn.addEventListener('click', () => {
  $settingsPanel.style.display = 'flex';
  loadSettingsSections();
});
let settingsSaveInProgress = false;
async function saveAndCloseSettingsPanel() {
  if (settingsSaveInProgress) return;
  settingsSaveInProgress = true;
  const results = [];
  try {
    const pendingSaves = [];
    for (const [name, form] of settingsForms.entries()) {
      if (form.dataset.dirty) {
        try {
          pendingSaves.push([name, serializeSettingsForm(form, name)]);
        } catch (error) {
          showSection(name);
          form.querySelector('textarea[data-role="raw-json"]')?.focus();
          toast(`Invalid JSON in ${name}: ${error?.message || error}`);
          return;
        }
      }
    }
    for (const [name, data] of pendingSaves) {
      results.push(await ipcRenderer.invoke('settings:set', name, data));
    }
    const failures = results.flatMap(result => result?.errors || []);
    const restart = await ipcRenderer.invoke('settings:restart-status').catch(() => []);
    renderRestartStatus(restart);
    if (failures.length) toast(`Settings saved; apply failed: ${failures.join('; ')}`);
    else if (Array.isArray(restart) && restart.length) toast('Settings saved; restart required for some changes');
    else if (results.length) toast('Settings saved and applied');
    $settingsPanel.style.display = 'none';
    settingsForms.clear();
  } catch (error) {
    toast(`Settings save failed: ${error?.message || error}`);
  } finally {
    settingsSaveInProgress = false;
  }
}

$settingsClose.addEventListener('click', saveAndCloseSettingsPanel);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($settingsPanel.style.display !== 'flex') return;
  e.preventDefault();
  saveAndCloseSettingsPanel();
});

  function mount() {
    ipcRenderer.on('settings:changed', async (_event, result) => {
      if (!result?.saved) return;
      const local = await settingsRuntime.applyConfig(result.section, result.config, result.appliedPaths || [], { source: 'settings-ui-renderer' });
      const failedPaths = new Set(local.restartRequiredPaths || []);
      settingsRuntime.commitAppliedConfig(
        result.section,
        result.config,
        (result.appliedPaths || []).filter(pathName => !failedPaths.has(pathName))
      );
      if (local.errors.length) {
        await ipcRenderer.invoke('settings:renderer-failed', result.section, result.appliedPaths || [], local.errors.join('; ')).catch(() => {});
      }
      ipcRenderer.invoke('settings:restart-status').then(renderRestartStatus).catch(() => {});
    });
    ipcRenderer.invoke('settings:restart-status').then(renderRestartStatus).catch(() => {});
  }

  return {
    settingsForms,
    renderRestartStatus,
    loadSettingsSections,
    serializeSettingsForm,
    showSection,
    saveAndCloseSettingsPanel,
    mount
  };
}

module.exports = {
  createSettingsRenderer
};