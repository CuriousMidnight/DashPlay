import {
  normalizeHost,
  hostMatchesRule,
  isValidHeaderName,
  isValidHeaderValue,
  validateHeaders,
  sanitizeHeaders,
  sanitizeProtectionConfig,
} from './player-utils.js';

export const SITE_HEADERS_KEY = 'siteHeaders';
export const MAX_SITE_HEADER_RULES = 200;
export const PROTECTION_PREFS_KEY = 'protectionPopupPrefsV1';

const PROTECTION_KEYWORDS = [
  atob('ZHJt'),
  'encrypted',
  'key_system',
  'key system',
  'keysystem',
  'license',
  'mediakeys',
  'media key',
  atob('d2lkZXZpbmU='),
  'playready',
  'protection',
];

/** dash.js 5 protection error codes (MEDIA_KEYERR_*, KEY_SYSTEM_*, licenser, etc.). */
const DASH_PROTECTION_ERROR_CODES = new Set([
  24, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 111, 112, 113, 114,
]);

// --- Per-site Request Headers ----------------------------------------------

function sanitizeRule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const host = typeof raw.host === 'string' ? normalizeHost(raw.host) : null;
  if (!host || !raw.headers || typeof raw.headers !== 'object') return null;
  const headers = Object.fromEntries(
    Object.entries(raw.headers).filter(
      ([k, v]) => typeof v === 'string' && isValidHeaderName(k) && isValidHeaderValue(v),
    ),
  );
  if (!Object.keys(headers).length) return null;
  return {
    host,
    headers,
    auto: raw.auto === true,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  };
}

export function loadSiteHeaders() {
  try {
    const raw = JSON.parse(localStorage.getItem(SITE_HEADERS_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.map(sanitizeRule).filter(Boolean);
  } catch {
    return [];
  }
}

function writeSiteHeaders(rules) {
  const sorted = [...rules].sort(
    (a, b) => Number(a.auto) - Number(b.auto) || b.updatedAt - a.updatedAt,
  );
  try {
    localStorage.setItem(SITE_HEADERS_KEY, JSON.stringify(sorted.slice(0, MAX_SITE_HEADER_RULES)));
  } catch {
    // Ignore storage quota errors in restricted environments.
  }
}

export function upsertSiteHeaders(hostInput, headers, auto = false) {
  const host = normalizeHost(hostInput);
  if (!host) throw new Error(`Invalid host: ${hostInput || '(empty)'}`);
  const errors = validateHeaders(headers);
  if (errors.length) throw new Error(errors.join(', '));

  const rules = loadSiteHeaders();
  const existing = rules.find((r) => r.host === host);
  if (auto && existing && !existing.auto) return false;

  const others = rules.filter((r) => r.host !== host);
  const clean = sanitizeHeaders(headers);
  if (clean && Object.keys(clean).length) {
    others.push({ host, headers: clean, auto, updatedAt: Date.now() });
  }
  writeSiteHeaders(others);
  return true;
}

export function removeSiteHeaders(hostInput) {
  const host = normalizeHost(hostInput);
  if (!host) return;
  writeSiteHeaders(loadSiteHeaders().filter((r) => r.host !== host));
}

export function getHeadersForHost(hostInput) {
  const host = normalizeHost(hostInput);
  if (!host) return null;
  const rules = loadSiteHeaders();
  // Apply broader rules first and let more specific host rules win.
  const matching = rules
    .filter((r) => hostMatchesRule(host, r.host))
    .sort((a, b) => a.host.length - b.host.length);
  if (!matching.length) return null;
  const merged = {};
  for (const rule of matching) {
    Object.assign(merged, rule.headers);
  }
  return Object.keys(merged).length ? merged : null;
}

export function getEffectiveHeaders(requestUrl, sourceUrl, inlineHeaders = null) {
  let reqHost = null;
  let srcHost = null;
  try { srcHost = new URL(sourceUrl).hostname.toLowerCase(); } catch { /* ignore */ }
  try { reqHost = new URL(requestUrl, sourceUrl).hostname.toLowerCase(); } catch { reqHost = srcHost; }

  const byHost = reqHost ? getHeadersForHost(reqHost) : null;
  const bySource = !byHost && srcHost ? getHeadersForHost(srcHost) : null;
  const cleanInline = sanitizeHeaders(inlineHeaders);

  const merged = {
    ...(bySource || {}),
    ...(byHost || {}),
    ...(cleanInline || {}),
  };
  return Object.keys(merged).length ? merged : null;
}

// --- Stream Protection -----------------------------------------------------

export function loadProtectionPrefs() {
  try {
    const raw = localStorage.getItem(PROTECTION_PREFS_KEY);
    if (!raw) return { lastConfig: null, hostConfigs: {} };
    const parsed = JSON.parse(raw);
    const hostConfigs = {};
    if (parsed?.hostConfigs && typeof parsed.hostConfigs === 'object') {
      for (const [host, cfg] of Object.entries(parsed.hostConfigs)) {
        const cleanHost = normalizeHost(host);
        const cleanCfg = sanitizeProtectionConfig(cfg);
        if (cleanHost && cleanCfg) hostConfigs[cleanHost] = cleanCfg;
      }
    }
    return {
      lastConfig: sanitizeProtectionConfig(parsed?.lastConfig),
      hostConfigs,
    };
  } catch {
    return { lastConfig: null, hostConfigs: {} };
  }
}

export function getStoredProtectionConfig(sourceUrl, { fallbackToLast = false } = {}) {
  const prefs = loadProtectionPrefs();
  let host = null;
  try { host = normalizeHost(new URL(sourceUrl).hostname); } catch { host = normalizeHost(sourceUrl); }
  if (host) {
    if (prefs.hostConfigs[host]) return prefs.hostConfigs[host];
    // Also check parent domain match
    for (const [savedHost, cfg] of Object.entries(prefs.hostConfigs)) {
      if (hostMatchesRule(host, savedHost)) return cfg;
    }
  }
  return fallbackToLast ? prefs.lastConfig : null;
}

export function listSavedProtectionConfigs() {
  const { hostConfigs } = loadProtectionPrefs();
  return Object.entries(hostConfigs).map(([host, config]) => ({ host, config }));
}

export function persistProtectionConfig(sourceUrl, config, rememberForHost = true) {
  const normalized = sanitizeProtectionConfig(config);
  if (!normalized) return;
  const prefs = loadProtectionPrefs();
  prefs.lastConfig = normalized;
  let host = null;
  try { host = normalizeHost(new URL(sourceUrl).hostname); } catch { host = normalizeHost(sourceUrl); }
  if (rememberForHost && host) {
    prefs.hostConfigs[host] = normalized;
  }
  try {
    localStorage.setItem(PROTECTION_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage errors
  }
}

export function removeStoredProtectionConfig(hostInput) {
  const host = normalizeHost(hostInput);
  if (!host) return;
  const prefs = loadProtectionPrefs();
  delete prefs.hostConfigs[host];
  try {
    localStorage.setItem(PROTECTION_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage errors
  }
}

export function getProtectionErrorText(errorEvent) {
  return [
    errorEvent?.error,
    errorEvent?.event,
    errorEvent,
    errorEvent?.error?.message,
    errorEvent?.error?.data?.message,
    errorEvent?.event?.message,
    errorEvent?.message,
    errorEvent?.reason,
  ]
    .filter(Boolean)
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      try {
        return JSON.stringify(entry);
      } catch {
        return String(entry);
      }
    })
    .join(' ')
    .toLowerCase();
}

export function isLikelyProtectionError(errorEvent) {
  const code = errorEvent?.error?.code ?? errorEvent?.code;
  if (typeof code === 'number' && DASH_PROTECTION_ERROR_CODES.has(code)) return true;
  const text = getProtectionErrorText(errorEvent);
  return Boolean(text) && PROTECTION_KEYWORDS.some((keyword) => text.includes(keyword));
}

// --- Dynamic Header Row UI Helpers -----------------------------------------

export function createHeaderRow(key = '', value = '') {
  const row = document.createElement('div');
  row.className = 'header-row';

  const keyInput = document.createElement('input');
  keyInput.type = 'text';
  keyInput.placeholder = 'Header name (e.g. Referer, Authorization)';
  keyInput.value = key;
  keyInput.spellcheck = false;
  keyInput.autocomplete = 'off';
  keyInput.dataset.headerKey = '';
  keyInput.setAttribute('aria-label', 'Header name');

  const valueInput = document.createElement('input');
  valueInput.type = 'text';
  valueInput.placeholder = 'Header value (e.g. https://site.example/)';
  valueInput.value = value;
  valueInput.spellcheck = false;
  valueInput.autocomplete = 'off';
  valueInput.dataset.headerValue = '';
  valueInput.setAttribute('aria-label', 'Header value');

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'row-remove-button';
  removeButton.textContent = 'Remove';
  removeButton.dataset.headerRemove = '';

  row.append(keyInput, valueInput, removeButton);
  return row;
}

export function populateHeaderRows(container, headers, defaultEmptyPair = ['', '']) {
  const entries = headers && typeof headers === 'object' ? Object.entries(headers) : [];
  const pairs = entries.length ? entries : (defaultEmptyPair ? [defaultEmptyPair] : []);
  container.replaceChildren(...pairs.map(([k, v]) => createHeaderRow(k, String(v ?? ''))));
}

export function readHeaderRows(container) {
  const headers = {};
  const errors = [];
  container.querySelectorAll('.header-row').forEach((row, index) => {
    const key = row.querySelector('[data-header-key]')?.value.trim() || '';
    const value = row.querySelector('[data-header-value]')?.value.trim() || '';
    if (!key && !value) return;
    if (!key) {
      errors.push(`Row ${index + 1}: enter a header name for "${value}".`);
      return;
    }
    if (!isValidHeaderName(key)) {
      errors.push(`Row ${index + 1}: invalid header name "${key}".`);
      return;
    }
    if (!isValidHeaderValue(value)) {
      errors.push(`Row ${index + 1}: invalid value for "${key}".`);
      return;
    }
    headers[key] = value;
  });
  return {
    headers: Object.keys(headers).length ? headers : null,
    errors,
  };
}
