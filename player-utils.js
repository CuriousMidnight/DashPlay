// URL, format, header, DRM, and shareable link utilities.
export const SUPPORTED_FORMATS = ['flv', 'hls', 'dash', 'mp4', 'mkv'];

export const FORMAT_LABELS = {
  flv: 'FLV',
  hls: 'HLS',
  dash: 'DASH',
  mp4: 'MP4',
  mkv: 'MKV',
};

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function normalizeSource(raw, base) {
  if (!raw || !raw.trim()) throw new Error('Paste a video or playlist URL first.');
  let url;
  try { url = new URL(raw.trim(), base); }
  catch { throw new Error('Enter a valid HTTP or HTTPS video URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS video URL.');
  if (url.username || url.password) throw new Error('Use a URL without embedded login credentials.');
  if (new URL(base).protocol === 'https:' && url.protocol === 'http:') {
    throw new Error('This page uses HTTPS. Use an HTTPS video URL to avoid blocked mixed content.');
  }
  return url.href;
}

export function detectFormat(url, selected = 'auto') {
  const parsed = new URL(url);
  const pathname = parsed.pathname.toLowerCase();
  // Shared links may carry the previous source's type. Recognizable extensions
  // win; the selected format is a hint for endpoints without an extension.
  if (pathname.endsWith('.flv')) return 'flv';
  if (pathname.endsWith('.m3u8')) return 'hls';
  if (pathname.endsWith('.mpd')) return 'dash';
  if (pathname.endsWith('.mp4') || pathname.endsWith('.m4v') || pathname.endsWith('.mov')) return 'mp4';
  if (pathname.endsWith('.mkv') || pathname.endsWith('.webm')) return 'mkv';
  if (SUPPORTED_FORMATS.includes(selected)) return selected;
  const full = `${pathname}${parsed.search.toLowerCase()}`;
  if (/(?:^|[/.?&=])[^/?&=]*\.m3u8(?:$|[/?&#])/i.test(full)) return 'hls';
  if (/(?:^|[/.?&=])[^/?&=]*\.mpd(?:$|[/?&#])/i.test(full)) return 'dash';
  if (/(?:^|[/.?&=])[^/?&=]*\.flv(?:$|[/?&#])/i.test(full)) return 'flv';
  if (/(?:^|[/.?&=])[^/?&=]*\.mp4(?:$|[/?&#])/i.test(full)) return 'mp4';
  if (/(?:^|[/.?&=])[^/?&=]*\.mkv(?:$|[/?&#])/i.test(full)) return 'mkv';
  throw new Error('Could not detect the format. Choose HLS / M3U8, DASH / MPD, FLV, MP4, or MKV in the Format menu.');
}

export function isKnownLiveFLV(raw, selected = 'auto') {
  try {
    const url = new URL(raw);
    // This endpoint serves continuous FLV streams. Match the actual host and
    // path, never a hostname embedded in a query or another site's suffix.
    return ['http:', 'https:'].includes(url.protocol) &&
      url.hostname === 'plwb.live.weibo.com' && url.pathname.startsWith('/alicdn/') &&
      detectFormat(url.href, selected) === 'flv';
  } catch { return false; }
}

export function normalizeHost(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    const host = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`).hostname;
    return HOSTNAME.test(host) ? host : null;
  } catch {
    return null;
  }
}

export function hostMatchesRule(requestHost, ruleHost) {
  if (!requestHost || !ruleHost) return false;
  const req = requestHost.toLowerCase();
  const rule = ruleHost.toLowerCase();
  return req === rule || req.endsWith(`.${rule}`);
}

export const isValidHeaderName = (name) => typeof name === 'string' && HEADER_NAME.test(name);
export const isValidHeaderValue = (value) => typeof value === 'string' && !/[\r\n\0]/.test(value);

export function validateHeaders(headers) {
  const errors = [];
  if (!headers || typeof headers !== 'object') return errors;
  for (const [name, value] of Object.entries(headers)) {
    if (!isValidHeaderName(name)) errors.push(`Invalid header name: ${name || '(empty)'}`);
    if (!isValidHeaderValue(String(value ?? ''))) errors.push(`Invalid value for ${name}`);
  }
  return errors;
}

export function sanitizeHeaders(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const clean = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).trim();
    const val = typeof v === 'string' ? v.trim() : String(v ?? '').trim();
    if (key && isValidHeaderName(key) && isValidHeaderValue(val)) {
      clean[key] = val;
    }
  }
  return Object.keys(clean).length ? clean : null;
}

export function parseHeaderLines(text) {
  const headers = {};
  const errors = [];
  String(text || '').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    const colon = line.indexOf(':');
    if (colon <= 0) {
      errors.push(`Line ${i + 1}: expected "Name: value"`);
      return;
    }
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  });
  return { headers, errors: [...errors, ...validateHeaders(headers)] };
}

export const formatHeaderLines = (headers) =>
  Object.entries(headers || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

export function sanitizeDrmConfig(config) {
  if (!config || typeof config !== 'object') return null;
  const widevineLicenseUrl = typeof config.widevineLicenseUrl === 'string' ? config.widevineLicenseUrl.trim() : '';
  if (!widevineLicenseUrl) return null;
  try {
    const parsed = new URL(widevineLicenseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  } catch {
    return null;
  }
  const headers = sanitizeHeaders(config.headers);
  const robustness = typeof config.robustness === 'string' && config.robustness.trim()
    ? config.robustness.trim()
    : undefined;
  return {
    widevineLicenseUrl,
    headers,
    ...(robustness ? { robustness } : {}),
  };
}

export function encodeShareData(value) {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeShareData(encoded) {
  if (!encoded || typeof encoded !== 'string') return null;
  const trimmed = encoded.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch { return null; }
  }
  try {
    const base64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    const { headers, errors } = parseHeaderLines(trimmed);
    if (!errors.length && Object.keys(headers).length) return headers;
    return null;
  }
}

export function readSource(search) {
  const params = new URLSearchParams(search);
  const shortKey = params.get('k') || params.get('v') || '';
  const shortProvider = params.get('v') ? 'vgd' : 'isgd';
  const url = params.get('url') || '';
  const type = SUPPORTED_FORMATS.includes(params.get('type')) ? params.get('type') : 'auto';
  const rawHeaders = params.get('headers') || params.get('h');
  const headers = rawHeaders ? sanitizeHeaders(decodeShareData(rawHeaders)) : null;

  let drm = null;
  const rawDrm = params.get('drm');
  if (rawDrm) {
    drm = sanitizeDrmConfig(decodeShareData(rawDrm));
  } else if (params.get('license')) {
    const rawDrmHeaders = params.get('drmHeaders');
    drm = sanitizeDrmConfig({
      widevineLicenseUrl: params.get('license'),
      headers: rawDrmHeaders ? decodeShareData(rawDrmHeaders) : null,
      robustness: params.get('robustness') || undefined,
    });
  }

  return {
    url,
    type,
    live: params.has('live') ? params.get('live') === '1' : isKnownLiveFLV(url, type),
    headers,
    drm,
    shortKey: /^[0-9A-Za-z_-]{3,32}$/.test(shortKey) ? shortKey : '',
    shortProvider,
  };
}

export function createPlayerLink(page, source) {
  const link = new URL(page);
  link.search = '';
  link.hash = '';
  link.searchParams.set('url', source.url);

  let autoDetected = null;
  try { autoDetected = detectFormat(source.url, 'auto'); } catch { /* requires explicit type */ }
  if (source.type && source.type !== autoDetected) {
    link.searchParams.set('type', source.type);
  }

  if (source.live && ['flv', 'mp4'].includes(source.type)) link.searchParams.set('live', '1');
  else if (isKnownLiveFLV(source.url, source.type)) link.searchParams.set('live', '0');

  const cleanHeaders = sanitizeHeaders(source.headers);
  if (cleanHeaders) {
    link.searchParams.set('headers', encodeShareData(cleanHeaders));
  }

  const cleanDrm = sanitizeDrmConfig(source.drm);
  if (cleanDrm) {
    link.searchParams.set('license', cleanDrm.widevineLicenseUrl);
    if (cleanDrm.robustness) link.searchParams.set('robustness', cleanDrm.robustness);
    if (cleanDrm.headers) link.searchParams.set('drmHeaders', encodeShareData(cleanDrm.headers));
  }

  return link.href;
}

const SHORT_CACHE_KEY = 'urlplay.shortlinks.v1';

function loadShortCache() {
  try {
    return JSON.parse(localStorage.getItem(SHORT_CACHE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function saveShortCache(cache) {
  try {
    const entries = Object.entries(cache).slice(-60);
    localStorage.setItem(SHORT_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* ignore storage quota errors */ }
}

export function buildShortPlayerLink(page, code, provider = 'isgd') {
  const link = new URL(page);
  link.search = '';
  link.hash = '';
  link.searchParams.set(provider === 'vgd' ? 'v' : 'k', code);
  return link.href;
}

export async function shortenShareLink(page, source) {
  const fullUrl = createPlayerLink(page, source);
  const cache = loadShortCache();
  if (cache[fullUrl]?.code) {
    const { code, provider, directShortUrl } = cache[fullUrl];
    return {
      code,
      provider,
      directShortUrl,
      playerShortUrl: buildShortPlayerLink(page, code, provider),
      fullUrl,
    };
  }

  const endpoints = [
    { provider: 'isgd', api: 'https://is.gd/create.php' },
    { provider: 'vgd', api: 'https://v.gd/create.php' },
  ];

  for (const { provider, api } of endpoints) {
    try {
      const body = new URLSearchParams({ format: 'json', url: fullUrl });
      const res = await fetch(api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body.toString(),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.shorturl) {
        const parsed = new URL(data.shorturl);
        const code = parsed.pathname.replace(/^\/+|\/+$/g, '');
        if (code) {
          cache[fullUrl] = { code, provider, directShortUrl: data.shorturl };
          cache[`code:${provider}:${code}`] = fullUrl;
          saveShortCache(cache);
          return {
            code,
            provider,
            directShortUrl: data.shorturl,
            playerShortUrl: buildShortPlayerLink(page, code, provider),
            fullUrl,
          };
        }
      }
    } catch { /* try next endpoint */ }
  }

  return {
    code: '',
    provider: '',
    directShortUrl: '',
    playerShortUrl: fullUrl,
    fullUrl,
  };
}

export async function resolveShortKey(code, provider = 'isgd') {
  const cache = loadShortCache();
  const cacheKey = `code:${provider}:${code}`;
  if (typeof cache[cacheKey] === 'string' && cache[cacheKey]) {
    return cache[cacheKey];
  }

  const host = provider === 'vgd' ? 'https://v.gd' : 'https://is.gd';
  const reqUrl = `${host}/forward.php?format=json&shorturl=${encodeURIComponent(code)}`;
  const res = await fetch(reqUrl);
  if (!res.ok) throw new Error(`Short link lookup failed (HTTP ${res.status}).`);
  const data = await res.json();
  if (!data?.url) {
    throw new Error(data?.errormessage || 'This short link was not found or has expired.');
  }
  const unescaped = String(data.url)
    .replaceAll('&amp;', '&')
    .replaceAll('&#038;', '&')
    .replaceAll('&quot;', '"');
  cache[cacheKey] = unescaped;
  saveShortCache(cache);
  return unescaped;
}

export function sourceLabel(url) {
  const parsed = new URL(url);
  let name = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
  try { name = decodeURIComponent(name); } catch { /* Keep malformed percent sequences as text. */ }
  // Signed URLs can have very long path tokens; show a useful host instead.
  return name.length > 90 ? parsed.hostname : name;
}
