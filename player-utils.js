// URL, format, header, protection, and shareable link utilities.
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

export function sanitizeProtectionConfig(config) {
  if (!config || typeof config !== 'object') return null;
  const rawUrl = config.licenseUrl || config[atob('d2lkZXZpbmVMaWNlbnNlVXJs')];
  const licenseUrl = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!licenseUrl) return null;
  try {
    const parsed = new URL(licenseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  } catch {
    return null;
  }
  const headers = sanitizeHeaders(config.headers);
  const robustness = typeof config.robustness === 'string' && config.robustness.trim()
    ? config.robustness.trim()
    : undefined;
  return {
    licenseUrl,
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

function bytesToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function tryUnwrapBase64(val) {
  if (typeof val !== 'string' || val.length < 32 || val.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(val)) return null;
  try {
    const bin = atob(val);
    if (btoa(bin) !== val) return null;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function packHeaderMap(headers, blobs) {
  const clean = sanitizeHeaders(headers);
  if (!clean) return undefined;
  const packed = {};
  for (const [k, v] of Object.entries(clean)) {
    const rawBytes = tryUnwrapBase64(v);
    if (rawBytes) {
      packed[k] = blobs.length;
      blobs.push(rawBytes);
    } else {
      packed[k] = v;
    }
  }
  return packed;
}

function unpackHeaderMap(packed, blobs) {
  if (!packed || typeof packed !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(packed)) {
    if (typeof v === 'number' && blobs[v]) {
      let bin = '';
      const bytes = blobs[v];
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      out[k] = btoa(bin);
    } else if (typeof v === 'string') {
      out[k] = v;
    }
  }
  return sanitizeHeaders(out);
}

export function encodeCompactPacket(source) {
  const blobs = [];
  let autoDetected = null;
  try { autoDetected = detectFormat(source.url, 'auto'); } catch { /* ignore */ }
  const cleanProt = sanitizeProtectionConfig(source.protection);

  const meta = {
    u: source.url,
    ...(source.type && source.type !== autoDetected ? { t: source.type } : {}),
    ...(source.live && ['flv', 'mp4'].includes(source.type) ? { v: 1 } : {}),
  };

  const packedHeaders = packHeaderMap(source.headers, blobs);
  if (packedHeaders) meta.h = packedHeaders;

  if (cleanProt) {
    meta.l = cleanProt.licenseUrl;
    if (cleanProt.robustness) meta.r = cleanProt.robustness;
    const packedProtHeaders = packHeaderMap(cleanProt.headers, blobs);
    if (packedProtHeaders) meta.d = packedProtHeaders;
  }

  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  let totalLen = 1 + 2 + metaBytes.length;
  for (const b of blobs) totalLen += 2 + b.length;

  const packet = new Uint8Array(totalLen);
  let offset = 0;
  packet[offset++] = 0; // version 0: synchronous binary-unwrapped packet
  packet[offset++] = (metaBytes.length >> 8) & 0xff;
  packet[offset++] = metaBytes.length & 0xff;
  packet.set(metaBytes, offset);
  offset += metaBytes.length;

  for (const b of blobs) {
    packet[offset++] = (b.length >> 8) & 0xff;
    packet[offset++] = b.length & 0xff;
    packet.set(b, offset);
    offset += b.length;
  }

  return bytesToBase64Url(packet);
}

export function decodeCompactPacket(encoded) {
  if (!encoded || typeof encoded !== 'string') return null;
  try {
    const packet = base64UrlToBytes(encoded.trim());
    if (packet.length < 4 || packet[0] !== 0) return null;
    let offset = 1;
    const metaLen = (packet[offset] << 8) | packet[offset + 1];
    offset += 2;
    if (offset + metaLen > packet.length) return null;
    const metaJson = new TextDecoder().decode(packet.subarray(offset, offset + metaLen));
    offset += metaLen;
    const meta = JSON.parse(metaJson);

    const blobs = [];
    while (offset + 2 <= packet.length) {
      const bLen = (packet[offset] << 8) | packet[offset + 1];
      offset += 2;
      if (offset + bLen > packet.length) break;
      blobs.push(packet.subarray(offset, offset + bLen));
      offset += bLen;
    }

    const url = typeof meta.u === 'string' ? meta.u : '';
    const type = SUPPORTED_FORMATS.includes(meta.t) ? meta.t : 'auto';
    const headers = unpackHeaderMap(meta.h, blobs);
    const protection = meta.l
      ? sanitizeProtectionConfig({
          licenseUrl: meta.l,
          robustness: meta.r || undefined,
          headers: unpackHeaderMap(meta.d, blobs),
        })
      : null;

    return {
      url,
      type,
      live: meta.v === 1 ? true : isKnownLiveFLV(url, type),
      headers,
      protection,
    };
  } catch {
    return null;
  }
}

export function readSource(search, hash = '') {
  const params = new URLSearchParams(search);
  const hashClean = String(hash || '').replace(/^#/, '');
  const hashParams = new URLSearchParams(hashClean.includes('=') ? hashClean : '');

  const compactToken = params.get('z') || hashParams.get('z') || '';
  if (compactToken) {
    const decoded = decodeCompactPacket(compactToken);
    if (decoded?.url) {
      return { ...decoded, aliasSlug: '' };
    }
  }

  const rawAlias = params.get('s') || params.get('id') || hashParams.get('s') || (!hashClean.includes('=') && hashClean ? hashClean : '');
  const aliasSlug = /^[0-9A-Za-z_-]{1,48}$/.test(rawAlias) ? rawAlias : '';

  const url = params.get('url') || '';
  const type = SUPPORTED_FORMATS.includes(params.get('type')) ? params.get('type') : 'auto';
  const rawHeaders = params.get('headers') || params.get('h');
  const headers = rawHeaders ? sanitizeHeaders(decodeShareData(rawHeaders)) : null;

  let protection = null;
  const rawProt = params.get('protection') || params.get(atob('ZHJt'));
  if (rawProt) {
    protection = sanitizeProtectionConfig(decodeShareData(rawProt));
  } else if (params.get('license')) {
    const rawProtHeaders = params.get('protectionHeaders') || params.get(atob('ZHJtSGVhZGVycw=='));
    protection = sanitizeProtectionConfig({
      licenseUrl: params.get('license'),
      headers: rawProtHeaders ? decodeShareData(rawProtHeaders) : null,
      robustness: params.get('robustness') || undefined,
    });
  }

  return {
    url,
    type,
    live: params.has('live') ? params.get('live') === '1' : isKnownLiveFLV(url, type),
    headers,
    protection,
    aliasSlug,
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

  const cleanProt = sanitizeProtectionConfig(source.protection);
  if (cleanProt) {
    link.searchParams.set('license', cleanProt.licenseUrl);
    if (cleanProt.robustness) link.searchParams.set('robustness', cleanProt.robustness);
    if (cleanProt.headers) link.searchParams.set('protectionHeaders', encodeShareData(cleanProt.headers));
  }

  return link.href;
}

export function createCompactPlayerLink(page, source) {
  const link = new URL(page);
  link.search = '';
  link.hash = '';
  link.searchParams.set('z', encodeCompactPacket(source));
  return link.href;
}

export function createAliasPlayerLink(page, slug) {
  const link = new URL(page);
  link.search = '';
  link.hash = '';
  link.searchParams.set('s', slug);
  return link.href;
}

const LOCAL_ALIASES_KEY = 'dashplay.local_aliases.v1';
const GH_SYNC_KEY = 'dashplay.gh_sync.v1';
let repoStreamsCache = null;

export function detectGithubRepoFromLocation(loc = window.location) {
  try {
    const host = String(loc.hostname || '').toLowerCase();
    if (host.endsWith('.github.io')) {
      const owner = host.slice(0, -'.github.io'.length);
      const segs = String(loc.pathname || '').split('/').filter(Boolean);
      const repo = segs[0] && !segs[0].endsWith('.html') ? segs[0] : `${owner}.github.io`;
      return `${owner}/${repo}`;
    }
  } catch { /* ignore */ }
  return 'curiousmidnight/DashPlay';
}

export function loadGithubSyncConfig() {
  const defaultRepo = detectGithubRepoFromLocation();
  try {
    const raw = JSON.parse(localStorage.getItem(GH_SYNC_KEY) || '{}') || {};
    return {
      repo: typeof raw.repo === 'string' && raw.repo.trim() ? raw.repo.trim() : defaultRepo,
      branch: typeof raw.branch === 'string' && raw.branch.trim() ? raw.branch.trim() : 'main',
      token: typeof raw.token === 'string' ? raw.token.trim() : '',
      autoSync: raw.autoSync !== false,
    };
  } catch {
    return { repo: defaultRepo, branch: 'main', token: '', autoSync: true };
  }
}

export function saveGithubSyncConfig(config) {
  const current = loadGithubSyncConfig();
  const next = {
    repo: String(config.repo ?? current.repo).trim() || detectGithubRepoFromLocation(),
    branch: String(config.branch ?? current.branch).trim() || 'main',
    token: String(config.token ?? current.token).trim(),
    autoSync: Boolean(config.autoSync ?? current.autoSync),
  };
  try {
    localStorage.setItem(GH_SYNC_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
  return next;
}

export function clearGithubSyncConfig() {
  try { localStorage.removeItem(GH_SYNC_KEY); } catch { /* ignore */ }
}

function decodeBase64Utf8(b64) {
  const binary = atob(String(b64 || '').replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function unpackStreamEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.z === 'string' && entry.z) {
    const decoded = decodeCompactPacket(entry.z);
    if (decoded?.url) return decoded;
  }
  if (!entry.url) return null;
  return {
    url: entry.url,
    type: SUPPORTED_FORMATS.includes(entry.type) ? entry.type : 'auto',
    live: Boolean(entry.live) || isKnownLiveFLV(entry.url, entry.type),
    headers: sanitizeHeaders(entry.headers),
    protection: sanitizeProtectionConfig(entry.protection || entry[atob('ZHJt')]),
  };
}

export async function fetchGithubApiStreams(repo = '', branch = '', token = '') {
  const cfg = loadGithubSyncConfig();
  const targetRepo = repo || cfg.repo;
  const targetBranch = branch || cfg.branch;
  const authToken = token || cfg.token;
  if (!targetRepo || !targetRepo.includes('/')) return { streams: {}, sha: '' };

  const headers = { Accept: 'application/vnd.github+json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const apiUrl = `https://api.github.com/repos/${targetRepo}/contents/streams.json${targetBranch ? `?ref=${encodeURIComponent(targetBranch)}` : ''}`;
  const res = await fetch(apiUrl, { headers, cache: 'no-store' });
  if (res.status === 404) return { streams: {}, sha: '' };
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const errJson = await res.json();
      if (errJson?.message) detail = errJson.message;
    } catch { /* ignore */ }
    throw new Error(`GitHub API error (${detail})`);
  }
  const data = await res.json();
  const content = data?.content ? decodeBase64Utf8(data.content) : '{}';
  const parsed = JSON.parse(content);
  const streams = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  repoStreamsCache = { ...(repoStreamsCache || {}), ...streams };
  return { streams, sha: data?.sha || '' };
}

export async function pushStreamToGithubRepo(slug, source) {
  const cfg = loadGithubSyncConfig();
  if (!cfg.token) {
    throw new Error('Add a GitHub Personal Access Token first to auto-update streams.json.');
  }
  const cleanSlug = String(slug || '').trim().replace(/[^0-9A-Za-z_-]/g, '') || generateDefaultSlug(source);
  const { streams: existing, sha } = await fetchGithubApiStreams(cfg.repo, cfg.branch, cfg.token);

  const entry = {
    title: sourceLabel(source.url),
    z: encodeCompactPacket(source),
  };

  if (existing[cleanSlug] && sourcesMatch(existing[cleanSlug], source)) {
    repoStreamsCache = existing;
    return { slug: cleanSlug, alreadySaved: true, streams: existing };
  }

  const nextStreams = { ...existing, [cleanSlug]: entry };
  const jsonText = `${JSON.stringify(nextStreams, null, 2)}\n`;
  const apiUrl = `https://api.github.com/repos/${cfg.repo}/contents/streams.json`;

  const putRes = await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: `Save stream preset "${cleanSlug}" via DashPlay`,
      content: encodeBase64Utf8(jsonText),
      ...(cfg.branch ? { branch: cfg.branch } : {}),
      ...(sha ? { sha } : {}),
    }),
  });

  if (!putRes.ok) {
    let detail = `HTTP ${putRes.status}`;
    try {
      const errJson = await putRes.json();
      if (errJson?.message) detail = errJson.message;
    } catch { /* ignore */ }
    throw new Error(`Could not save to streams.json (${detail})`);
  }

  repoStreamsCache = nextStreams;
  saveLocalAlias(cleanSlug, source);
  return { slug: cleanSlug, alreadySaved: false, streams: nextStreams };
}

export async function loadRepoStreams({ forceRefresh = false } = {}) {
  if (repoStreamsCache && !forceRefresh) return repoStreamsCache;
  try {
    const res = await fetch(new URL('streams.json', document.baseURI).href, { cache: 'no-cache' });
    if (res.ok) {
      const data = await res.json();
      repoStreamsCache = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
      return repoStreamsCache;
    }
  } catch { /* ignore */ }
  repoStreamsCache = repoStreamsCache || {};
  return repoStreamsCache;
}

export function loadLocalAliases() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_ALIASES_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

export function saveLocalAlias(slug, source) {
  const cleanSlug = String(slug || '').trim().replace(/[^0-9A-Za-z_-]/g, '');
  if (!cleanSlug || !source?.url) return '';
  const aliases = loadLocalAliases();
  aliases[cleanSlug] = {
    title: sourceLabel(source.url),
    z: encodeCompactPacket(source),
  };
  try {
    localStorage.setItem(LOCAL_ALIASES_KEY, JSON.stringify(aliases));
  } catch { /* ignore quota */ }
  return cleanSlug;
}

function shortHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).slice(0, 5);
}

function generateDefaultSlug(source) {
  try {
    const hostParts = new URL(source.url).hostname.split('.').filter((p) => !['www', 'com', 'net', 'org', 'jp', 'ne', 'co', 'live', 'cdn', 'cdn0'].includes(p));
    const prefix = (hostParts[0] || 'stream').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 10) || 'stream';
    const sig = `${source.url}|${JSON.stringify(source.headers || {})}|${JSON.stringify(source.protection || {})}`;
    return `${prefix}-${shortHash(sig)}`;
  } catch {
    return `stream-${shortHash(source.url || '')}`;
  }
}

function sourcesMatch(rawA, rawB) {
  const a = unpackStreamEntry(rawA);
  const b = unpackStreamEntry(rawB);
  if (!a || !b || a.url !== b.url) return false;
  const ah = JSON.stringify(sanitizeHeaders(a.headers) || null);
  const bh = JSON.stringify(sanitizeHeaders(b.headers) || null);
  const ap = JSON.stringify(sanitizeProtectionConfig(a.protection) || null);
  const bp = JSON.stringify(sanitizeProtectionConfig(b.protection) || null);
  return ah === bh && ap === bp;
}

export function findOrRegisterLocalAlias(source, repoStreams = {}) {
  if (!source?.url) return { slug: '', inRepo: false };
  for (const [slug, entry] of Object.entries(repoStreams || {})) {
    if (sourcesMatch(source, entry)) {
      saveLocalAlias(slug, source);
      return { slug, inRepo: true };
    }
  }
  const local = loadLocalAliases();
  for (const [slug, entry] of Object.entries(local)) {
    if (sourcesMatch(source, entry)) {
      return { slug, inRepo: Boolean(repoStreams?.[slug]) };
    }
  }
  const slug = generateDefaultSlug(source);
  saveLocalAlias(slug, source);
  return { slug, inRepo: Boolean(repoStreams?.[slug]) };
}

export async function resolveAliasSlug(slug) {
  const repo = await loadRepoStreams();
  const local = loadLocalAliases();
  let unpacked = unpackStreamEntry(repo[slug]) || unpackStreamEntry(local[slug]);
  let inRepo = Boolean(repo[slug]);

  if (!unpacked?.url) {
    try {
      const { streams: liveRepoStreams } = await fetchGithubApiStreams();
      const liveUnpacked = unpackStreamEntry(liveRepoStreams?.[slug]);
      if (liveUnpacked?.url) {
        unpacked = liveUnpacked;
        inRepo = true;
      }
    } catch { /* fallback if offline or rate-limited */ }
  }

  if (!unpacked || !unpacked.url) return null;
  return {
    ...unpacked,
    inRepo,
  };
}

export function buildStreamsJsonString(slug, source, repoStreams = {}) {
  const merged = { ...(repoStreams || {}) };
  const cleanSlug = String(slug || '').trim().replace(/[^0-9A-Za-z_-]/g, '') || generateDefaultSlug(source);
  merged[cleanSlug] = {
    title: sourceLabel(source.url),
    z: encodeCompactPacket(source),
  };
  return JSON.stringify(merged, null, 2);
}

export function sourceLabel(url) {
  const parsed = new URL(url);
  let name = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
  try { name = decodeURIComponent(name); } catch { /* Keep malformed percent sequences as text. */ }
  // Signed URLs can have very long path tokens; show a useful host instead.
  return name.length > 90 ? parsed.hostname : name;
}
