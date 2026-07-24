const fetch = require('node-fetch');

const SENSITIVE_KEY_RE = /(?:authorization|token|secret|password|credential|key)$/i;
const ENV_REF_RE = /\$\{?ENV:([A-Z0-9_]+)\}?/gi;
const PLACEHOLDER_RE = /\{([^{}\s]+)\}/g;
const PAYLOAD_MAPPING_RE = /^([A-Za-z_][A-Za-z0-9_]*):([A-Za-z_][A-Za-z0-9_.[\]]*)$/;

function parsePropsToken(token) {
  const raw = String(token || '');
  if (!raw.startsWith('props=')) return null;
  const body = raw.slice('props='.length);
  if (!body) return { ok: true, props: {} };
  const props = {};
  for (const pair of body.split(';').filter(Boolean)) {
    const sepIdx = pair.indexOf(':');
    if (sepIdx <= 0) return { ok: false, error: 'Usage: wh <target-or-group> [text...] [props=key:value;key2:value2]' };
    const key = pair.slice(0, sepIdx).trim();
    const value = pair.slice(sepIdx + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return { ok: false, error: 'Usage: wh <target-or-group> [text...] [props=key:value;key2:value2]' };
    }
    props[key] = value;
  }
  return { ok: true, props };
}

function parseWebhookCommandArgs(args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const [target, ...rest] = list;
  if (!target) return { ok: false, error: 'Usage: wh <target-or-group> [text...] [props=key:value;key2:value2]' };
  const textParts = [];
  const mappings = {};
  let props = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    const propsStartsHere = token.startsWith('props=');
    const parseToken = propsStartsHere ? rest.slice(i).join(' ') : token;
    const parsed = parsePropsToken(parseToken);
    if (parsed) {
      if (!parsed.ok) return parsed;
      props = { ...props, ...parsed.props };
      if (propsStartsHere) break;
    } else {
      const mapping = token.match(PAYLOAD_MAPPING_RE);
      if (mapping) {
        mappings[mapping[1]] = mapping[2];
      } else {
        textParts.push(token);
      }
    }
  }
  const payload = { ...props };
  const text = textParts.join(' ').trim();
  if (text) payload.text = text;
  const out = { ok: true, target, payload };
  if (Object.keys(mappings).length) out.mappings = mappings;
  return out;
}

function getProp(payload, key) {
  if (!payload || typeof payload !== 'object') return '';
  const value = getPathValue(payload, key);
  return value == null ? '' : value;
}

function parsePath(path) {
  const raw = String(path || '').trim();
  if (!raw) return [];
  const parts = [];
  raw.replace(/([^.[\]]+)|\[(\d+)\]/g, (_match, prop, index) => {
    parts.push(index != null ? Number(index) : prop);
    return '';
  });
  return parts;
}

function getPathValue(obj, path) {
  const parts = parsePath(path);
  if (!parts.length) return undefined;
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function applyPayloadMappings(payload, mappings, eventPayload) {
  const out = payload && typeof payload === 'object' ? { ...payload } : {};
  if (!mappings || typeof mappings !== 'object' || !eventPayload || typeof eventPayload !== 'object') return out;
  for (const [targetKey, sourcePath] of Object.entries(mappings)) {
    const value = getPathValue(eventPayload, sourcePath);
    if (value != null && value !== '') out[targetKey] = value;
  }
  return out;
}

function applyRenderedBodyMappings(body, payload, mappedKeys) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.isBuffer(body)) return body;
  if (!Array.isArray(mappedKeys) || !mappedKeys.length || !payload || typeof payload !== 'object') return body;
  const out = { ...body };
  for (const key of mappedKeys) {
    if (Object.prototype.hasOwnProperty.call(out, key) && payload[key] != null && payload[key] !== '') {
      out[key] = payload[key];
    }
  }
  return out;
}

function renderTemplate(value, payload) {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER_RE, (_match, key) => {
      const out = getProp(payload, key);
      if (out == null) return '';
      if (typeof out === 'object') return JSON.stringify(out);
      return String(out);
    });
  }
  if (Array.isArray(value)) return value.map(item => renderTemplate(item, payload));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = renderTemplate(value[key], payload);
    }
    return out;
  }
  return value;
}

function resolveEnvRefs(value) {
  const missing = [];
  function walk(v) {
    if (typeof v === 'string') {
      return v.replace(ENV_REF_RE, (_match, name) => {
        const envValue = process.env[name];
        if (envValue == null || envValue === '') {
          missing.push(name);
          return '';
        }
        return envValue;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const key of Object.keys(v)) out[key] = walk(v[key]);
      return out;
    }
    return v;
  }
  return { value: walk(value), missing: Array.from(new Set(missing)) };
}

function redact(value, keyHint = '') {
  if (SENSITIVE_KEY_RE.test(String(keyHint || ''))) return '[redacted]';
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = redact(value[key], key);
    return out;
  }
  return value;
}

function parseOkStatuses(okStatuses) {
  const raw = Array.isArray(okStatuses) && okStatuses.length ? okStatuses : ['200-299'];
  const ranges = [];
  for (const item of raw) {
    if (typeof item === 'number' && Number.isFinite(item)) {
      ranges.push([item, item]);
      continue;
    }
    const str = String(item || '').trim();
    if (!str) continue;
    const range = str.match(/^(\d{3})\s*-\s*(\d{3})$/);
    if (range) {
      ranges.push([Number(range[1]), Number(range[2])]);
      continue;
    }
    const code = Number(str);
    if (Number.isFinite(code)) ranges.push([code, code]);
  }
  return status => ranges.some(([from, to]) => status >= from && status <= to);
}

function normalizeTargets(config, name) {
  const targets = config?.targets && typeof config.targets === 'object' ? config.targets : {};
  const groups = config?.groups && typeof config.groups === 'object' ? config.groups : {};
  if (Array.isArray(groups[name])) return groups[name].map(String).filter(Boolean);
  if (targets[name]) return [name];
  return [];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function traceEnabled(config) {
  const trace = config?.trace;
  if (trace == null) return true;
  if (typeof trace === 'boolean') return trace;
  return trace.enabled !== false;
}

class OutboundWebhooksService {
  constructor(config = {}, opts = {}) {
    this.config = config || {};
    this.fetch = opts.fetch || fetch;
    this.sleep = opts.sleep || sleep;
    this.now = opts.now || (() => new Date().toISOString());
    this.logger = opts.logger || console;
    this.dedupe = new Set();
  }

  trace(event, details = {}) {
    if (!traceEnabled(this.config)) return;
    const traceCfg = this.config.trace && typeof this.config.trace === 'object' ? this.config.trace : {};
    const out = { ...details };
    if (traceCfg.includePayload === false) delete out.payload;
    if (traceCfg.includeBody === false) delete out.body;
    this.logger?.info?.('[outbound-webhooks]', event, redact(out));
  }

  send(targetOrGroup, payload = {}, opts = {}) {
    if (this.config.enabled === false) {
      this.trace('send.skip.disabled-service', { target: targetOrGroup });
      return Promise.resolve({ ok: false, error: 'Outbound webhooks disabled' });
    }
    const name = String(targetOrGroup || '').trim();
    if (!name) {
      this.trace('send.error.missing-target', {});
      return Promise.resolve({ ok: false, error: 'Missing webhook target' });
    }
    const targetNames = normalizeTargets(this.config, name);
    if (!targetNames.length) {
      this.trace('send.error.unknown-target', { target: name });
      return Promise.resolve({ ok: false, error: `Unknown webhook target or group: ${name}` });
    }
    const outgoingPayload = payload && typeof payload === 'object' ? { ...payload } : {};
    const templatePayload = {
      ts: this.now(),
      ...(opts.templatePayload && typeof opts.templatePayload === 'object' ? opts.templatePayload : {}),
      ...outgoingPayload
    };
    this.trace('send.start', { target: name, targetNames, payload: outgoingPayload, templateKeys: Object.keys(templatePayload).sort() });
    return Promise.all(targetNames.map(targetName => this.sendTarget(targetName, outgoingPayload, { ...opts, templatePayload })))
      .then(results => {
        const res = {
          ok: results.every(item => item.ok || item.skipped),
          target: name,
          results
        };
        this.trace(res.ok ? 'send.done' : 'send.failed', res);
        return res;
      });
  }

  async sendTarget(targetName, payload, opts = {}) {
    const target = this.config.targets?.[targetName];
    if (!target || typeof target !== 'object') {
      this.trace('target.error.unknown', { target: targetName });
      return { ok: false, target: targetName, error: `Unknown webhook target: ${targetName}` };
    }
    if (target.enabled === false) {
      this.trace('target.skip.disabled', { target: targetName });
      return { ok: true, target: targetName, skipped: true, reason: 'disabled' };
    }
    if (!target.url) {
      this.trace('target.error.missing-url', { target: targetName });
      return { ok: false, target: targetName, error: `Webhook target ${targetName} missing url` };
    }

    const envResolved = resolveEnvRefs(target);
    if (envResolved.missing.length) {
      this.trace('target.error.missing-env', { target: targetName, missing: envResolved.missing });
      return {
        ok: false,
        target: targetName,
        error: `Webhook target ${targetName} missing environment: ${envResolved.missing.join(', ')}`
      };
    }

    const resolvedTarget = envResolved.value;
    const templatePayload = {
      ...(opts.templatePayload && typeof opts.templatePayload === 'object' ? opts.templatePayload : {}),
      ...(payload && typeof payload === 'object' ? payload : {})
    };
    const dedupeRendered = resolvedTarget.dedupeKey ? renderTemplate(resolvedTarget.dedupeKey, templatePayload) : '';
    const dedupeKey = dedupeRendered ? `${targetName}:${dedupeRendered}` : '';
    if (dedupeKey && this.dedupe.has(dedupeKey)) {
      this.trace('target.skip.duplicate', { target: targetName, dedupeKey });
      return { ok: true, target: targetName, skipped: true, duplicate: true };
    }

    const method = String(resolvedTarget.method || 'POST').toUpperCase();
    const headers = { ...(resolvedTarget.headers || {}) };
    const bodyTemplate = resolvedTarget.body == null ? payload : resolvedTarget.body;
    const renderedBody = applyRenderedBodyMappings(
      renderTemplate(bodyTemplate, templatePayload),
      payload,
      opts.mappedKeys
    );
    const isJsonBody = renderedBody && typeof renderedBody === 'object' && !Buffer.isBuffer(renderedBody);
    if (isJsonBody && !Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
    const body = isJsonBody ? JSON.stringify(renderedBody) : String(renderedBody ?? '');
    const okStatus = parseOkStatuses(resolvedTarget.okStatuses);
    const retry = resolvedTarget.retry && typeof resolvedTarget.retry === 'object' ? resolvedTarget.retry : {};
    const attempts = Math.max(1, Math.trunc(Number(retry.attempts || opts.attempts || 1)) || 1);
    const backoffMs = Array.isArray(retry.backoffMs) ? retry.backoffMs : [];
    const timeoutMs = Math.trunc(Number(resolvedTarget.timeoutMs || opts.timeoutMs || 0)) || 0;
    let lastError = null;
    this.trace('target.prepared', {
      target: targetName,
      method,
      url: resolvedTarget.url,
      headers,
      payload,
      templateKeys: Object.keys(templatePayload).sort(),
      body: renderedBody,
      dedupeKey: dedupeKey || undefined,
      attempts
    });

    if (resolvedTarget.dryRun === true) {
      this.trace('target.dry-run', {
        target: targetName,
        method,
        url: resolvedTarget.url,
        headers,
        payload,
        templateKeys: Object.keys(templatePayload).sort(),
        body: renderedBody,
        dedupeKey: dedupeKey || undefined
      });
      return { ok: true, target: targetName, skipped: true, dryRun: true };
    }

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        this.trace('target.attempt', { target: targetName, attempt, attempts, url: resolvedTarget.url });
        const response = await this.fetch(resolvedTarget.url, {
          method,
          headers,
          body,
          timeout: timeoutMs || undefined
        });
        const status = Number(response?.status || 0);
        if (okStatus(status)) {
          if (dedupeKey) this.dedupe.add(dedupeKey);
          this.trace('target.success', { target: targetName, status, attempt, attempts });
          return { ok: true, target: targetName, status, attempts: attempt };
        }
        const text = typeof response?.text === 'function' ? await response.text().catch(() => '') : '';
        lastError = new Error(`HTTP ${status}${text ? ` ${text}` : ''}`);
        this.trace('target.retryable-status', { target: targetName, status, attempt, attempts, response: text });
      } catch (err) {
        lastError = err;
        this.trace('target.retryable-error', { target: targetName, attempt, attempts, error: err?.message || String(err) });
      }
      if (attempt < attempts) {
        const delay = Number(backoffMs[attempt - 1] || 0);
        this.trace('target.retry-wait', { target: targetName, attempt, nextAttempt: attempt + 1, delayMs: delay });
        if (delay > 0) await this.sleep(delay);
      }
    }

    const error = lastError?.message || 'Webhook request failed';
    this.logger?.error?.('[outbound-webhooks] send failed', redact({
      target: targetName,
      url: resolvedTarget.url,
      headers,
      error
    }));
    this.trace('target.failed', { target: targetName, error, attempts });
    return { ok: false, target: targetName, error, attempts };
  }

  runAction(command, _entry, eventPayload) {
    this.trace('runner.command', { command, payload: eventPayload });
    const args = String(command || '').trim().split(/\s+/).filter(Boolean);
    const action = args.shift();
    if (String(action || '').toLowerCase() !== 'send') {
      return { ok: false, error: 'Usage: webhook:send <target-or-group> [text...] [props=key:value;key2:value2]' };
    }
    const parsed = parseWebhookCommandArgs(args);
    if (!parsed.ok) return parsed;
    const mappedPayload = applyPayloadMappings(parsed.payload, parsed.mappings, eventPayload);
    const mappedKeys = parsed.mappings ? Object.keys(parsed.mappings) : [];
    const templatePayload = {
      ...(eventPayload && typeof eventPayload === 'object' ? eventPayload : {}),
      ...mappedPayload
    };
    return this.send(parsed.target, mappedPayload, { templatePayload, mappedKeys });
  }
}

function createOutboundWebhooksService(config, opts) {
  return new OutboundWebhooksService(config, opts);
}

module.exports = {
  OutboundWebhooksService,
  createOutboundWebhooksService,
  parseWebhookCommandArgs,
  parsePropsToken,
  applyPayloadMappings,
  applyRenderedBodyMappings,
  renderTemplate,
  resolveEnvRefs,
  redact,
  parseOkStatuses,
  getPathValue
};
