import {
  FORMAT_LABELS,
  normalizeSource,
  detectFormat,
  isKnownLiveFLV,
  normalizeHost,
  formatHeaderLines,
  sanitizeHeaders,
  sanitizeDrmConfig,
  readSource,
  createPlayerLink,
  shortenShareLink,
  resolveShortKey,
  sourceLabel,
} from './player-utils.js';
import { qualityChoices, screenshotFilename, initFrameCapture, captureFrame } from './player-tools.js';
import { initPlayerControls } from './player-controls.js';
import { LiveMP4Player } from './live-mp4.js';
import {
  loadSiteHeaders,
  upsertSiteHeaders,
  removeSiteHeaders,
  getHeadersForHost,
  getEffectiveHeaders,
  getStoredDrmConfig,
  listSavedDrmConfigs,
  persistDrmConfig,
  removeStoredDrmConfig,
  getDrmErrorText,
  isLikelyDrmError,
  createHeaderRow,
  populateHeaderRows,
  readHeaderRows,
} from './player-config.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const controls = initPlayerControls($('player'), video);
initFrameCapture(video);
const exampleURL = new URL('assets/example.flv', document.baseURI).href;

let engine = null;
let hlsEngine = null;
let dashEngine = null;
let dashModulePromise = null;
let mpegtsPromise = null;
let hlsPromise = null;
let dashManualLevel = -1;
let source = null;
let generation = 0;
let readinessTimer;
let copyTimer;
let failed = false;
let capturePending = false;
let captureBlocked = false;
let qualityMode = 'loading';
let liveOptionURL = null;
let liveOptionAuto = false;
let includeHeadersInShare = true;
let includeDrmInShare = true;
let customSessionDrm = null;
let customSessionHeaders = null;
let drmPrompting = false;

function loadScriptSequential(urls, globalKey) {
  if (window[globalKey]) return Promise.resolve(window[globalKey]);
  return new Promise((resolve, reject) => {
    let idx = 0;
    const tryNext = () => {
      if (window[globalKey]) {
        resolve(window[globalKey]);
        return;
      }
      if (idx >= urls.length) {
        reject(new Error(`Could not load ${globalKey} library.`));
        return;
      }
      const script = document.createElement('script');
      script.src = urls[idx++];
      script.async = true;
      script.onload = () => {
        if (window[globalKey]) resolve(window[globalKey]);
        else tryNext();
      };
      script.onerror = tryNext;
      document.head.appendChild(script);
    };
    tryNext();
  });
}

function ensureMpegts() {
  if (window.mpegts) return Promise.resolve(window.mpegts);
  if (!mpegtsPromise) {
    mpegtsPromise = loadScriptSequential([
      'https://cdn.jsdelivr.net/npm/mpegts.js@1.8.0/dist/mpegts.js',
      './vendor/mpegts-1.8.0.js',
    ], 'mpegts').catch((err) => {
      mpegtsPromise = null;
      throw err;
    });
  }
  return mpegtsPromise;
}

function ensureHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsPromise) {
    hlsPromise = loadScriptSequential([
      'https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.min.js',
      './vendor/hls-1.6.13.min.js',
    ], 'Hls').catch((err) => {
      hlsPromise = null;
      throw err;
    });
  }
  return hlsPromise;
}

async function getDashModule() {
  if (!dashModulePromise) {
    dashModulePromise = import('./vendor/dashjs-5.1.1.js')
      .catch(() => import('https://cdn.jsdelivr.net/npm/dashjs@5.1.1/+esm'))
      .then((mod) => mod.default || mod)
      .catch((err) => {
        dashModulePromise = null;
        throw err;
      });
  }
  return dashModulePromise;
}

function currentTargetUrl() {
  const inputVal = $('video-url').value.trim();
  if (inputVal) {
    try { return new URL(inputVal, document.baseURI).href; } catch { /* ignore */ }
  }
  return source?.url || '';
}

function currentTargetHost() {
  const url = currentTargetUrl();
  if (!url || url === exampleURL) return '';
  try { return normalizeHost(new URL(url).hostname) || ''; } catch { return ''; }
}

function resolveStreamHeaders(url, overrideHeaders = null) {
  const cleanOverride = sanitizeHeaders(overrideHeaders);
  const hostHeaders = getEffectiveHeaders(url, url, cleanOverride);
  return hostHeaders;
}

function resolveStreamDrm(url, overrideDrm = null) {
  return sanitizeDrmConfig(overrideDrm) || sanitizeDrmConfig(customSessionDrm) || getStoredDrmConfig(url);
}

function updateConfigPills() {
  const url = currentTargetUrl();
  const isExample = !url || url === exampleURL;
  const activeHeaders = !isExample ? resolveStreamHeaders(url, customSessionHeaders) : null;
  const headerCount = activeHeaders ? Object.keys(activeHeaders).length : 0;

  $('open-site-headers').dataset.active = String(headerCount > 0);
  $('headers-count-badge').hidden = headerCount === 0;
  $('headers-count-badge').textContent = String(headerCount);

  const activeDrm = !isExample ? resolveStreamDrm(url) : null;
  const hasDrm = Boolean(activeDrm?.widevineLicenseUrl);
  $('open-drm-config').dataset.active = String(hasDrm);
  $('drm-active-badge').hidden = !hasDrm;
}

function renderSavedRulesLists() {
  const rules = loadSiteHeaders();
  const headersList = $('saved-site-headers-list');
  if (!rules.length) {
    const empty = document.createElement('p');
    empty.className = 'saved-rule-empty';
    empty.textContent = 'No per-site headers saved yet. Click "+ Configure headers" to add headers for a stream host.';
    headersList.replaceChildren(empty);
  } else {
    headersList.replaceChildren(...rules.map((rule) => {
      const item = document.createElement('div');
      item.className = 'saved-rule-item';

      const info = document.createElement('div');
      info.className = 'saved-rule-info';
      const hostEl = document.createElement('div');
      hostEl.className = 'saved-rule-host';
      hostEl.textContent = rule.host;

      const countPill = document.createElement('span');
      countPill.className = 'saved-rule-pill';
      const count = Object.keys(rule.headers).length;
      countPill.textContent = `${count} header${count === 1 ? '' : 's'}`;
      hostEl.appendChild(countPill);

      const detail = document.createElement('pre');
      detail.className = 'saved-rule-detail';
      detail.textContent = formatHeaderLines(rule.headers);
      info.append(hostEl, detail);

      const actions = document.createElement('div');
      actions.className = 'saved-rule-actions';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'rule-btn';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => openSiteHeadersModal(rule.host));

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'rule-btn rule-btn--danger';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => {
        removeSiteHeaders(rule.host);
        if (source && normalizeHost(new URL(source.url).hostname) === rule.host) {
          customSessionHeaders = null;
          source.headers = includeHeadersInShare ? resolveStreamHeaders(source.url) : null;
          updateAddress();
          refreshSharePanel();
        }
        renderSavedRulesLists();
        updateConfigPills();
      });

      actions.append(editBtn, removeBtn);
      item.append(info, actions);
      return item;
    }));
  }

  const drmList = $('saved-drm-list');
  const savedDrm = listSavedDrmConfigs();
  if (!savedDrm.length && !customSessionDrm?.widevineLicenseUrl) {
    const empty = document.createElement('p');
    empty.className = 'saved-rule-empty';
    empty.textContent = 'No Widevine DRM configurations saved yet. Click "+ Configure Widevine" when playing encrypted .mpd streams.';
    drmList.replaceChildren(empty);
  } else {
    const items = [...savedDrm];
    if (customSessionDrm?.widevineLicenseUrl) {
      const host = currentTargetHost() || 'Current stream';
      if (!items.some((entry) => entry.host === host)) {
        items.unshift({ host, config: customSessionDrm, sessionOnly: true });
      }
    }
    drmList.replaceChildren(...items.map(({ host, config, sessionOnly }) => {
      const item = document.createElement('div');
      item.className = 'saved-rule-item';

      const info = document.createElement('div');
      info.className = 'saved-rule-info';
      const hostEl = document.createElement('div');
      hostEl.className = 'saved-rule-host';
      hostEl.textContent = host;

      const pill = document.createElement('span');
      pill.className = 'saved-rule-pill';
      pill.textContent = config.robustness || 'Widevine';
      hostEl.appendChild(pill);

      const detail = document.createElement('pre');
      detail.className = 'saved-rule-detail';
      const hdrCount = config.headers ? Object.keys(config.headers).length : 0;
      detail.textContent = `License: ${config.widevineLicenseUrl}${hdrCount ? `\nHeaders: ${ Object.keys(config.headers).join(', ') }` : ''}`;
      info.append(hostEl, detail);

      const actions = document.createElement('div');
      actions.className = 'saved-rule-actions';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'rule-btn';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => openDrmModal({ prefill: config, host }));

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'rule-btn rule-btn--danger';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => {
        if (!sessionOnly) removeStoredDrmConfig(host);
        customSessionDrm = null;
        if (source) {
          source.drm = includeDrmInShare ? resolveStreamDrm(source.url) : null;
          updateAddress();
          refreshSharePanel();
        }
        renderSavedRulesLists();
        updateConfigPills();
      });

      actions.append(editBtn, removeBtn);
      item.append(info, actions);
      return item;
    }));
  }
}

function singleQuality(label, hint) {
  $('quality-select').replaceChildren(new Option(label, '-1'));
  $('quality-select').disabled = true;
  $('quality-hint').textContent = hint;
  $('quality-select').parentElement.title = hint;
}

function resetVideoTools() {
  hlsEngine = null;
  dashEngine = null;
  dashManualLevel = -1;
  qualityMode = 'loading';
  capturePending = false;
  captureBlocked = false;
  singleQuality('Loading…', 'Available qualities appear after loading.');
  $('screenshot-button').disabled = true;
  $('screenshot-label').textContent = 'Save screenshot';
  $('screenshot-feedback').hidden = true;
}

function refreshQuality() {
  if (failed || !source) return;
  if (qualityMode === 'native') {
    singleQuality('Auto (browser)', 'Your browser manages quality for this stream.');
  } else if (qualityMode === 'flv' || qualityMode === 'mp4' || qualityMode === 'mkv') {
    singleQuality(video.videoHeight ? `Original · ${video.videoHeight}p` : 'Original', 'This source provides one quality.');
  } else if (qualityMode === 'hls' && hlsEngine?.levels?.length) {
    const choices = qualityChoices(hlsEngine.levels, video.videoHeight);
    if (choices.length === 1) {
      singleQuality(choices[0].label, 'This playlist provides one quality. Use a master playlist for more choices.');
    } else {
      const selected = hlsEngine.manualLevel;
      $('quality-select').replaceChildren(new Option('Auto', '-1'), ...choices.map(({ label, index }) => new Option(label, String(index))));
      $('quality-select').value = String(selected);
      $('quality-select').disabled = false;
      const active = choices.find(({ index }) => index === hlsEngine.currentLevel);
      $('quality-hint').textContent = selected === -1
        ? `Auto adjusts to your connection${active ? ` · ${active.label}` : ''}.`
        : `Selected ${choices.find(({ index }) => index === selected)?.label || 'quality'}.`;
      $('quality-select').parentElement.title = $('quality-hint').textContent;
    }
  } else if (qualityMode === 'dash' && dashEngine) {
    let reps = [];
    try { reps = dashEngine.getRepresentationsByType?.('video') || []; } catch { reps = []; }
    if (!reps.length) {
      singleQuality(video.videoHeight ? `Auto · ${video.videoHeight}p` : 'Auto (DASH)', 'Adaptive bitrate managed by DASH.');
      return;
    }
    const choices = qualityChoices(reps, video.videoHeight);
    if (choices.length === 1) {
      singleQuality(choices[0].label, 'This DASH manifest provides one video representation.');
    } else {
      $('quality-select').replaceChildren(new Option('Auto', '-1'), ...choices.map(({ label, index }) => new Option(label, String(index))));
      $('quality-select').value = String(dashManualLevel);
      $('quality-select').disabled = false;
      let currentRep = null;
      try { currentRep = dashEngine.getCurrentRepresentationForType?.('video'); } catch { /* ignore */ }
      const active = currentRep ? choices.find((c) => c.id === currentRep.id || c.index === currentRep.index) : null;
      $('quality-hint').textContent = dashManualLevel === -1
        ? `Auto adjusts to your connection${active ? ` · ${active.label}` : ''}.`
        : `Selected ${choices.find(({ index }) => index === dashManualLevel)?.label || 'quality'}.`;
      $('quality-select').parentElement.title = $('quality-hint').textContent;
    }
  }
}

function refreshScreenshot() {
  $('screenshot-button').disabled = !source || failed || capturePending || captureBlocked || video.readyState < 2 || !video.videoWidth || !video.videoHeight || video.seeking;
}

function status(text, state = 'ready') {
  $('player-status').textContent = text;
  $('status-dot').dataset.state = state;
}

function dispose() {
  clearTimeout(readinessTimer);
  controls.setSource();
  const previous = engine;
  engine = null;
  hlsEngine = null;
  dashEngine = null;
  if (previous) {
    if (typeof previous.destroy === 'function') previous.destroy();
    else if (typeof previous.reset === 'function') previous.reset();
  }
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function fail(title, message, { showDrmAction = false } = {}) {
  if (failed) return;
  failed = true;
  dispose();
  $('video-message-title').textContent = title;
  $('video-message-text').textContent = message;
  $('error-drm-button').hidden = !showDrmAction && source?.type !== 'dash';
  $('video-message').hidden = false;
  status('Unable to play this source', 'error');
  singleQuality('Unavailable', 'Load a playable video to see its quality.');
  refreshScreenshot();
}

let shareLinkMode = 'playerShort';
let currentShortInfo = null;
let shortenSeq = 0;

function buildShareSource() {
  if (!source) return null;
  return {
    ...source,
    headers: includeHeadersInShare ? resolveStreamHeaders(source.url, customSessionHeaders) : null,
    drm: includeDrmInShare ? resolveStreamDrm(source.url) : null,
  };
}

function getDisplayedShareUrl(fullUrl) {
  if (shareLinkMode === 'full') return fullUrl;
  if (currentShortInfo && currentShortInfo.fullUrl === fullUrl) {
    if (shareLinkMode === 'directShort' && currentShortInfo.directShortUrl) {
      return currentShortInfo.directShortUrl;
    }
    if (currentShortInfo.playerShortUrl) {
      return currentShortInfo.playerShortUrl;
    }
  }
  return fullUrl;
}

function syncShareModeButtons() {
  document.querySelectorAll('[data-share-mode]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.shareMode === shareLinkMode));
  });
}

async function ensureShortenedForCurrentSource({ replaceAddress = true } = {}) {
  const shareable = buildShareSource();
  if (!shareable || shareable.url === exampleURL) return null;
  const fullUrl = createPlayerLink(location.href, shareable);
  if (currentShortInfo && currentShortInfo.fullUrl === fullUrl && currentShortInfo.code) {
    if (replaceAddress) {
      try { history.replaceState(null, '', currentShortInfo.playerShortUrl); } catch { /* ignore */ }
    }
    return currentShortInfo;
  }
  const seq = ++shortenSeq;
  const info = await shortenShareLink(location.href, shareable);
  if (seq !== shortenSeq) return info;
  currentShortInfo = info;
  if (info.code && replaceAddress) {
    try { history.replaceState(null, '', info.playerShortUrl); } catch { /* ignore */ }
  }
  const latestShareable = buildShareSource();
  if (latestShareable) {
    const latestFull = createPlayerLink(location.href, latestShareable);
    $('share-url').value = getDisplayedShareUrl(latestFull);
  }
  return info;
}

function updateAddress() {
  const shareable = buildShareSource();
  if (!shareable || shareable.url === exampleURL) return;
  const href = createPlayerLink(location.href, shareable);
  try { history.replaceState(null, '', getDisplayedShareUrl(href)); } catch { /* Player also works in restricted embeds. */ }
  ensureShortenedForCurrentSource({ replaceAddress: true });
}

function refreshSharePanel() {
  const shareable = buildShareSource();
  if (!shareable) return;
  const fullUrl = createPlayerLink(location.href, shareable);
  syncShareModeButtons();
  $('share-url').value = getDisplayedShareUrl(fullUrl);
  if (shareable.url !== exampleURL) {
    ensureShortenedForCurrentSource({ replaceAddress: true });
  }

  const tags = [];
  tags.push({ label: 'Format', value: FORMAT_LABELS[shareable.type] || shareable.type.toUpperCase() });
  if (shareable.live) tags.push({ label: 'Mode', value: 'Live' });
  const hdrCount = shareable.headers ? Object.keys(shareable.headers).length : 0;
  if (hdrCount > 0) {
    tags.push({ label: 'Per-site headers', value: `${hdrCount} included` });
  }
  if (shareable.drm?.widevineLicenseUrl) {
    tags.push({
      label: 'Widevine DRM',
      value: shareable.drm.robustness ? `License + ${shareable.drm.robustness}` : 'License URL included',
    });
  }

  $('share-meta').replaceChildren(...tags.map(({ label, value }) => {
    const span = document.createElement('span');
    span.className = 'share-tag';
    const strong = document.createElement('strong');
    strong.textContent = `${label}: `;
    span.append(strong, document.createTextNode(value));
    return span;
  }));
}

function updateFormatBadge() {
  if (!source) return;
  const base = FORMAT_LABELS[source.type] || source.type.toUpperCase();
  const parts = [base];
  if (source.live) parts.push('LIVE');
  if (source.type === 'dash' && resolveStreamDrm(source.url)?.widevineLicenseUrl) parts.push('DRM');
  if (resolveStreamHeaders(source.url, customSessionHeaders)) parts.push('HEADERS');
  $('format-badge').textContent = parts.join(' · ');
}

function loadSource(raw, selected, live, { updateURL = true, example = false, inlineHeaders = null, inlineDrm = null } = {}) {
  $('form-error').hidden = true;
  $('video-url').removeAttribute('aria-invalid');
  let url, type;
  try {
    url = normalizeSource(raw, document.baseURI);
    type = detectFormat(url, selected);
  } catch (error) {
    $('form-error').textContent = error.message;
    $('form-error').hidden = false;
    $('video-url').setAttribute('aria-invalid', 'true');
    $('video-url').focus();
    return;
  }

  if (inlineHeaders) {
    customSessionHeaders = sanitizeHeaders(inlineHeaders);
    const host = normalizeHost(new URL(url).hostname);
    if (host && customSessionHeaders) {
      try { upsertSiteHeaders(host, customSessionHeaders, true); } catch { /* ignore */ }
    }
  }
  if (inlineDrm) {
    customSessionDrm = sanitizeDrmConfig(inlineDrm);
    if (customSessionDrm) {
      persistDrmConfig(url, customSessionDrm, true);
    }
  }

  generation++;
  const current = generation;
  source = null;
  dispose();
  resetVideoTools();
  failed = false;

  const isExample = example || url === exampleURL;
  const effectiveHeaders = !isExample ? resolveStreamHeaders(url, customSessionHeaders) : null;
  const effectiveDrm = !isExample ? resolveStreamDrm(url) : null;

  source = {
    url,
    type,
    live: ['flv', 'mp4'].includes(type) && live,
    headers: effectiveHeaders,
    drm: effectiveDrm,
  };
  liveOptionURL = url;
  liveOptionAuto = source.live && isKnownLiveFLV(url, type);
  controls.setSource({
    live: source.live,
    bufferedOnly: source.live,
    getLivePosition: () => {
      if (hlsEngine) return hlsEngine.liveSyncPosition;
      if (dashEngine?.isDynamic?.()) {
        try { return dashEngine.getDvrWindow?.()?.end; } catch { return undefined; }
      }
      return undefined;
    },
    restartLive: ['flv', 'hls', 'dash'].includes(type) ? () => {
      if (current !== generation || failed) return;
      if (type === 'dash' && dashEngine?.isDynamic?.()) {
        try {
          dashEngine.seekToOriginalLive?.();
          video.play().catch(() => {});
          return;
        } catch { /* fallback to reload */ }
      }
      loadSource(url, type, live);
      video.play().catch(() => {});
    } : null,
  });

  if (!isExample) $('video-url').value = url;
  $('source-type').value = selected === 'auto' ? 'auto' : type;
  $('live-stream').disabled = !['flv', 'mp4'].includes(type);
  $('live-stream').checked = source.live;
  $('source-name').textContent = isExample ? 'Example video' : sourceLabel(url);
  $('source-name').title = new URL(url).hostname;
  updateFormatBadge();
  updateConfigPills();
  renderSavedRulesLists();

  $('copy-link').disabled = false;
  clearTimeout(copyTimer);
  $('copy-label').textContent = 'Copy shareable link';
  refreshSharePanel();
  $('video-message').hidden = true;
  video.removeAttribute('poster');
  status('Loading video…', 'loading');
  if (updateURL) updateAddress();
  readinessTimer = setTimeout(() => {
    if (current === generation && video.readyState < 1) {
      if (isExample) {
        enterReadyIdleState();
        return;
      }
      fail(
        'The source is taking too long',
        'Check that the URL is still available and the video host allows CORS. If the stream returns 403 Forbidden, configure Per-site headers.',
      );
    }
  }, 30000);

  try {
    if (type === 'flv') {
      qualityMode = 'flv';
      refreshQuality();
      startFlvPlayback(url, current, effectiveHeaders, isExample);
    } else if (type === 'mp4' || type === 'mkv') {
      qualityMode = type;
      refreshQuality();
      if (type === 'mp4' && source.live) {
        engine = new LiveMP4Player(video, url, (error) => {
          if (current !== generation || failed) return;
          if (error.network) networkFailure('live MP4 stream', error.status);
          else fail('Live MP4 playback is unavailable', error.message);
        }, effectiveHeaders || {});
        engine.load();
      } else {
        // Attempt anonymous CORS first so frame screenshots work; fallback without
        // crossOrigin if the server plays media directly without CORS headers.
        video.dataset.corsFallbackTried = 'false';
        video.crossOrigin = 'anonymous';
        video.src = url;
        video.load();
      }
    } else if (type === 'dash') {
      qualityMode = 'dash';
      refreshQuality();
      startDashPlayback(url, current, effectiveHeaders, effectiveDrm);
    } else {
      startHlsPlayback(url, current);
    }
  } catch (error) {
    fail('Playback is unavailable', error.message);
  }
}

function enterReadyIdleState() {
  dispose();
  source = null;
  failed = false;
  $('video-message').hidden = true;
  $('source-name').textContent = 'Ready · Paste a stream URL above';
  $('format-badge').textContent = 'HLS · DASH · FLV · MP4 · MKV';
  status('Ready · Paste a .m3u8, .mpd, .flv, .mp4, or .mkv URL above to start', 'ready');
  singleQuality('Unavailable', 'Load a video stream to see available qualities.');
  refreshScreenshot();
}

async function startFlvPlayback(url, current, effectiveHeaders, isExample) {
  try {
    const mpegts = await ensureMpegts();
    if (current !== generation || failed) return;
    if (!mpegts?.isSupported?.()) {
      throw new Error('FLV playback needs Media Source Extensions. Try a recent Chrome, Edge, Firefox, or Safari browser.');
    }
    mpegts.LoggingControl.enableAll = false;
    const flvPlayer = mpegts.createPlayer({ type: 'flv', url, isLive: source.live, cors: true }, {
      enableWorker: true,
      enableStashBuffer: !source.live,
      autoCleanupSourceBuffer: true,
      ...(effectiveHeaders ? { headers: effectiveHeaders } : {}),
      ...(source.live ? {
        autoCleanupMinBackwardDuration: 240,
        autoCleanupMaxBackwardDuration: 360,
      } : {}),
    });
    engine = flvPlayer;
    flvPlayer.on(mpegts.Events.ERROR, (kind, _detail, info) => {
      if (current !== generation) return;
      if (isExample) {
        enterReadyIdleState();
        return;
      }
      if (kind === mpegts.ErrorTypes.NETWORK_ERROR) networkFailure('FLV stream', info?.code);
      else fail('This video could not be decoded', 'The FLV file may be invalid or its codec may not be supported by this browser. Try an H.264 video with AAC audio.');
    });
    flvPlayer.attachMediaElement(video);
    flvPlayer.load();
  } catch (error) {
    if (current === generation && !failed) {
      if (isExample) enterReadyIdleState();
      else fail('FLV playback is unavailable', error.message);
    }
  }
}

async function startHlsPlayback(url, current) {
  try {
    const Hls = await ensureHls().catch(() => null);
    if (current !== generation || failed) return;
    if (Hls && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        xhrSetup(xhr, reqUrl) {
          const hdrs = getEffectiveHeaders(reqUrl, url, customSessionHeaders);
          if (!hdrs) return;
          if (!xhr.readyState) xhr.open('GET', reqUrl, true);
          for (const [k, v] of Object.entries(hdrs)) {
            try { xhr.setRequestHeader(k, v); } catch { /* Skip browser-restricted header names */ }
          }
        },
      });
      engine = hls;
      hlsEngine = hls;
      qualityMode = 'hls';
      hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
        if (current === generation && !failed) controls.setLive(data.details.live);
      });
      for (const event of [Hls.Events.MANIFEST_PARSED, Hls.Events.LEVELS_UPDATED, Hls.Events.LEVEL_SWITCHED]) {
        hls.on(event, () => { if (current === generation && !failed) refreshQuality(); });
      }
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (current !== generation || !data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          const resource = data.details?.startsWith('manifest') ? 'playlist'
            : data.details?.startsWith('level') ? 'variant playlist'
            : data.details?.startsWith('key') ? 'encryption key' : 'video segment';
          networkFailure(resource, data.response?.code);
        } else {
          fail('This stream could not be decoded', 'The playlist or a video segment is invalid, or its codec is not supported by this browser.');
        }
      });
      hls.attachMedia(video);
      hls.loadSource(url);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      qualityMode = 'native';
      refreshQuality();
      video.crossOrigin = 'anonymous';
      video.src = url;
      video.load();
    } else {
      if (!Hls) throw new Error('The HLS library could not load. Check your internet connection or that the vendor files were deployed.');
      throw new Error('HLS playback is not supported in this browser. Try a recent Chrome, Edge, Firefox, or Safari browser.');
    }
  } catch (error) {
    if (current === generation && !failed) {
      fail('HLS playback is unavailable', error.message);
    }
  }
}

async function startDashPlayback(url, current, effectiveHeaders, effectiveDrm) {
  try {
    const dashjs = await getDashModule();
    if (current !== generation || failed) return;
    if (!dashjs?.MediaPlayer) throw new Error('The DASH library could not initialize.');

    const player = dashjs.MediaPlayer().create();
    engine = player;
    dashEngine = player;

    player.updateSettings({
      debug: { logLevel: dashjs.Debug?.LOG_LEVEL_NONE ?? 0 },
      streaming: {
        abr: { autoSwitchBitrate: { video: true } },
      },
    });

    player.addRequestInterceptor((request) => {
      const hdrs = getEffectiveHeaders(request.url, url, customSessionHeaders || effectiveHeaders);
      if (hdrs && Object.keys(hdrs).length) {
        request.headers = Object.assign(request.headers || {}, hdrs);
      }
      return Promise.resolve(request);
    });

    player.registerLicenseRequestFilter((request) => {
      const siteHdrs = getEffectiveHeaders(request.url, url, customSessionHeaders || effectiveHeaders);
      const drmCfg = resolveStreamDrm(url) || effectiveDrm;
      const merged = { ...(siteHdrs || {}), ...(drmCfg?.headers || {}) };
      if (Object.keys(merged).length) {
        request.headers = Object.assign(request.headers || {}, merged);
      }
      return Promise.resolve();
    });

    if (effectiveDrm?.widevineLicenseUrl) {
      const widevine = { serverURL: effectiveDrm.widevineLicenseUrl, priority: 1 };
      if (effectiveDrm.headers && Object.keys(effectiveDrm.headers).length) {
        widevine.httpRequestHeaders = effectiveDrm.headers;
      }
      if (effectiveDrm.robustness) {
        widevine.videoRobustness = effectiveDrm.robustness;
        widevine.audioRobustness = effectiveDrm.robustness;
      }
      player.setProtectionData({ 'com.widevine.alpha': widevine });
    }

    const events = dashjs.MediaPlayer.events || {};
    const onStreamUpdated = () => {
      if (current !== generation || failed) return;
      try { controls.setLive(Boolean(player.isDynamic?.())); } catch { /* ignore */ }
      refreshQuality();
    };
    for (const ev of [events.STREAM_INITIALIZED, events.QUALITY_CHANGE_RENDERED, events.REPRESENTATION_SWITCH, 'streamInitialized', 'qualityChangeRendered']) {
      if (ev) player.on(ev, onStreamUpdated);
    }

    const handleDrmOrDashError = (event, forceDrm = false) => {
      if (current !== generation) return;
      if (forceDrm || isLikelyDrmError(event)) {
        const drmText = getDrmErrorText(event).slice(0, 400);
        fail(
          'Encrypted DASH stream requires Widevine DRM',
          'Enter a Widevine license URL, optional request headers, and robustness level to play this encrypted .mpd stream.',
          { showDrmAction: true },
        );
        if (!drmPrompting) {
          openDrmModal({
            detectedError: drmText || 'Widevine key system / license required for this DASH stream.',
          });
        }
        return;
      }
      const errObj = event?.error || event;
      const statusCode = errObj?.data?.response?.status ?? errObj?.data?.request?.status;
      if (errObj?.code === 27 || errObj?.code === 25 || statusCode) {
        networkFailure('DASH manifest or segment', statusCode);
      } else if (errObj?.message) {
        fail('DASH playback error', errObj.message, { showDrmAction: true });
      }
    };

    player.on('public_keyError', (ev) => handleDrmOrDashError(ev, true));
    player.on(events.ERROR || 'error', (ev) => handleDrmOrDashError(ev, false));

    player.initialize(video, url, false);
  } catch (error) {
    if (current === generation && !failed) {
      fail('DASH playback is unavailable', error.message, { showDrmAction: true });
    }
  }
}

function networkFailure(resource = 'video', code) {
  const httpStatus = Number(code);
  let message = `Could not load the ${resource}. `;
  if (httpStatus === 401 || httpStatus === 403) {
    message += `The video host denied access (HTTP ${httpStatus}). Click "Per-site headers" below to save request headers (such as Referer, Origin, or Authorization) for this stream host, or get a fresh playback URL.`;
  } else if (httpStatus === 404 || httpStatus === 410) {
    message += `The host could not find it (HTTP ${httpStatus}). Check the URL or try a fresh live playlist.`;
  } else {
    if (httpStatus >= 400 && httpStatus <= 599) message += `The host returned HTTP ${httpStatus}. `;
    message += 'If this stream returns 403 Forbidden without site headers, click "Per-site headers" to configure request headers for its host. Also check CORS permissions for playlists, segments, and keys.';
  }
  fail('We couldn’t load this link', message);
}

// --- Modal: Per-site Headers -----------------------------------------------

function openSiteHeadersModal(preferredHost = '') {
  const host = normalizeHost(preferredHost) || currentTargetHost();
  $('sh-host-input').value = host;
  const existing = host ? getHeadersForHost(host) : customSessionHeaders;
  populateHeaderRows($('sh-header-rows'), existing, ['Referer', '']);
  $('sh-include-share').checked = includeHeadersInShare;
  $('sh-error').hidden = true;
  $('site-headers-modal').hidden = false;
  setTimeout(() => {
    if (!host) $('sh-host-input').focus();
    else $('sh-header-rows').querySelector('[data-header-value]')?.focus();
  }, 0);
}

function closeSiteHeadersModal() {
  $('site-headers-modal').hidden = true;
}

$('open-site-headers').addEventListener('click', () => openSiteHeadersModal());
$('card-open-headers').addEventListener('click', () => openSiteHeadersModal());
$('error-headers-button').addEventListener('click', () => openSiteHeadersModal());
$('sh-close-x').addEventListener('click', closeSiteHeadersModal);
$('sh-cancel').addEventListener('click', closeSiteHeadersModal);
$('site-headers-modal').addEventListener('click', (event) => {
  if (event.target === $('site-headers-modal')) closeSiteHeadersModal();
});

$('sh-add-header').addEventListener('click', () => {
  const row = createHeaderRow();
  $('sh-header-rows').appendChild(row);
  row.querySelector('[data-header-key]')?.focus();
});

document.querySelectorAll('[data-sh-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const presetName = btn.dataset.shPreset;
    const container = $('sh-header-rows');
    const existingRow = Array.from(container.querySelectorAll('.header-row')).find(
      (r) => r.querySelector('[data-header-key]')?.value.trim().toLowerCase() === presetName.toLowerCase(),
    );
    if (existingRow) {
      existingRow.querySelector('[data-header-value]')?.focus();
      return;
    }
    const emptyRow = Array.from(container.querySelectorAll('.header-row')).find(
      (r) => !r.querySelector('[data-header-key]')?.value.trim() && !r.querySelector('[data-header-value]')?.value.trim(),
    );
    if (emptyRow) {
      emptyRow.querySelector('[data-header-key]').value = presetName;
      emptyRow.querySelector('[data-header-value]')?.focus();
    } else {
      const row = createHeaderRow(presetName, '');
      container.appendChild(row);
      row.querySelector('[data-header-value]')?.focus();
    }
  });
});

$('sh-header-rows').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-header-remove]');
  if (!btn) return;
  const container = $('sh-header-rows');
  const row = btn.closest('.header-row');
  if (container.children.length <= 1) {
    row.querySelectorAll('input').forEach((input) => { input.value = ''; });
  } else {
    row.remove();
  }
});

$('sh-clear').addEventListener('click', () => {
  const host = normalizeHost($('sh-host-input').value) || currentTargetHost();
  if (host) removeSiteHeaders(host);
  customSessionHeaders = null;
  closeSiteHeadersModal();
  renderSavedRulesLists();
  updateConfigPills();
  if (source && source.url !== exampleURL) {
    loadSource(source.url, source.type, source.live);
  }
});

$('sh-save').addEventListener('click', () => {
  $('sh-error').hidden = true;
  const hostInput = $('sh-host-input').value.trim();
  const host = normalizeHost(hostInput) || currentTargetHost();
  if (!host) {
    $('sh-error').textContent = 'Enter a valid stream host (for example: cdn.example.com).';
    $('sh-error').hidden = false;
    $('sh-host-input').focus();
    return;
  }

  const { headers, errors } = readHeaderRows($('sh-header-rows'));
  if (errors.length) {
    $('sh-error').textContent = errors[0];
    $('sh-error').hidden = false;
    return;
  }

  includeHeadersInShare = $('sh-include-share').checked;
  try {
    if (headers && Object.keys(headers).length) {
      upsertSiteHeaders(host, headers, false);
      if (host === currentTargetHost()) customSessionHeaders = headers;
    } else {
      removeSiteHeaders(host);
      if (host === currentTargetHost()) customSessionHeaders = null;
    }
  } catch (error) {
    $('sh-error').textContent = error.message;
    $('sh-error').hidden = false;
    return;
  }

  closeSiteHeadersModal();
  renderSavedRulesLists();
  updateConfigPills();

  const rawUrl = $('video-url').value.trim();
  if (rawUrl && rawUrl !== exampleURL) {
    loadSource(rawUrl, $('source-type').value, $('live-stream').checked);
  } else if (source) {
    updateFormatBadge();
    updateAddress();
    refreshSharePanel();
  }
});

// --- Modal: DASH DRM (Widevine) --------------------------------------------

function openDrmModal({ detectedError = '', prefill = null, host = '' } = {}) {
  drmPrompting = true;
  const targetUrl = currentTargetUrl();
  const initial = prefill || (targetUrl ? resolveStreamDrm(targetUrl) : null) || getStoredDrmConfig(host || targetUrl, { fallbackToLast: true });

  const banner = $('drm-detected-message');
  if (detectedError) {
    banner.textContent = `Detected encrypted DASH stream:\n${detectedError}`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
    banner.textContent = '';
  }

  $('drm-license-url').value = initial?.widevineLicenseUrl || '';
  $('drm-robustness').value = initial?.robustness || '';
  populateHeaderRows($('drm-header-rows'), initial?.headers, ['', '']);
  $('drm-include-share').checked = includeDrmInShare;
  $('drm-error').hidden = true;
  $('drm-modal').hidden = false;
  setTimeout(() => $('drm-license-url').focus(), 0);
}

function closeDrmModal() {
  $('drm-modal').hidden = true;
  drmPrompting = false;
}

$('open-drm-config').addEventListener('click', () => openDrmModal());
$('card-open-drm').addEventListener('click', () => openDrmModal());
$('error-drm-button').addEventListener('click', () => openDrmModal());
$('drm-close-x').addEventListener('click', closeDrmModal);
$('drm-cancel').addEventListener('click', closeDrmModal);
$('drm-modal').addEventListener('click', (event) => {
  if (event.target === $('drm-modal')) closeDrmModal();
});

$('drm-add-header').addEventListener('click', () => {
  const row = createHeaderRow();
  $('drm-header-rows').appendChild(row);
  row.querySelector('[data-header-key]')?.focus();
});

document.querySelectorAll('[data-drm-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const presetName = btn.dataset.drmPreset;
    const container = $('drm-header-rows');
    const emptyRow = Array.from(container.querySelectorAll('.header-row')).find(
      (r) => !r.querySelector('[data-header-key]')?.value.trim() && !r.querySelector('[data-header-value]')?.value.trim(),
    );
    if (emptyRow) {
      emptyRow.querySelector('[data-header-key]').value = presetName;
      emptyRow.querySelector('[data-header-value]')?.focus();
    } else {
      const row = createHeaderRow(presetName, '');
      container.appendChild(row);
      row.querySelector('[data-header-value]')?.focus();
    }
  });
});

$('drm-header-rows').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-header-remove]');
  if (!btn) return;
  const container = $('drm-header-rows');
  const row = btn.closest('.header-row');
  if (container.children.length <= 1) {
    row.querySelectorAll('input').forEach((input) => { input.value = ''; });
  } else {
    row.remove();
  }
});

$('drm-clear').addEventListener('click', () => {
  const host = currentTargetHost();
  if (host) removeStoredDrmConfig(host);
  customSessionDrm = null;
  closeDrmModal();
  renderSavedRulesLists();
  updateConfigPills();
  if (source && source.url !== exampleURL) {
    loadSource(source.url, source.type, source.live);
  }
});

$('drm-apply').addEventListener('click', () => {
  $('drm-error').hidden = true;
  const licenseUrl = $('drm-license-url').value.trim();
  if (!licenseUrl) {
    $('drm-error').textContent = 'Enter a Widevine license URL (HTTP or HTTPS).';
    $('drm-error').hidden = false;
    $('drm-license-url').focus();
    return;
  }
  try {
    const parsed = new URL(licenseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid protocol');
  } catch {
    $('drm-error').textContent = 'Enter a valid HTTP or HTTPS Widevine license URL.';
    $('drm-error').hidden = false;
    $('drm-license-url').focus();
    return;
  }

  const { headers, errors } = readHeaderRows($('drm-header-rows'));
  if (errors.length) {
    $('drm-error').textContent = errors[0];
    $('drm-error').hidden = false;
    return;
  }

  const robustness = $('drm-robustness').value.trim() || undefined;
  const remember = $('drm-remember').checked;
  includeDrmInShare = $('drm-include-share').checked;

  const config = sanitizeDrmConfig({
    widevineLicenseUrl: licenseUrl,
    headers,
    robustness,
  });

  customSessionDrm = config;
  const targetUrl = currentTargetUrl();
  if (targetUrl && targetUrl !== exampleURL) {
    persistDrmConfig(targetUrl, config, remember);
  }

  closeDrmModal();
  renderSavedRulesLists();
  updateConfigPills();

  const rawUrl = $('video-url').value.trim();
  if (rawUrl && rawUrl !== exampleURL) {
    const chosenType = $('source-type').value === 'auto' ? 'auto' : 'dash';
    loadSource(rawUrl, chosenType, $('live-stream').checked);
  } else if (source) {
    updateFormatBadge();
    updateAddress();
    refreshSharePanel();
  }
});

// --- Video Element Events --------------------------------------------------

video.addEventListener('loadedmetadata', () => {
  if (!source || failed) return;
  clearTimeout(readinessTimer);
  if (video.paused) status('Ready to play · Press play to start');
  refreshQuality();
  if (qualityMode === 'native') controls.setLive(video.duration === Infinity);
});
video.addEventListener('durationchange', () => {
  if (qualityMode === 'native' && source && !failed) controls.setLive(video.duration === Infinity);
});
video.addEventListener('canplay', () => {
  if (!source || failed) return;
  clearTimeout(readinessTimer);
  status(video.paused ? 'Ready to play · Press play to start' : 'Playing');
  refreshScreenshot();
});
for (const event of ['loadeddata', 'seeked', 'resize', 'playing']) {
  video.addEventListener(event, () => { refreshQuality(); refreshScreenshot(); });
}
for (const event of ['seeking', 'emptied']) {
  video.addEventListener(event, refreshScreenshot);
}
video.addEventListener('playing', () => { if (!failed) status('Playing'); });
video.addEventListener('pause', () => { if (source && !failed && video.readyState >= 2) status(video.ended ? 'Playback finished' : 'Paused · Press play to resume'); });
video.addEventListener('waiting', () => { if (source && !failed) status('Buffering…', 'loading'); });
video.addEventListener('ended', () => { if (!failed) status('Playback finished · Press play to replay'); });
video.addEventListener('error', () => {
  if (!source || failed || !video.error) return;
  // If direct MP4 or MKV failed under anonymous CORS before metadata loaded,
  // retry once without crossOrigin so non-CORS file servers can still play.
  if ((source.type === 'mp4' || source.type === 'mkv') && !source.live && video.readyState < 1 && video.dataset.corsFallbackTried === 'false') {
    video.dataset.corsFallbackTried = 'true';
    video.removeAttribute('crossorigin');
    video.src = source.url;
    video.load();
    return;
  }
  if (video.error.code === MediaError.MEDIA_ERR_NETWORK) networkFailure( FORMAT_LABELS[source.type] || 'video' );
  else fail('This source could not be played', 'Check that this is a direct .m3u8, .mpd, .flv, .mp4, or .mkv URL and that its video/audio codecs are supported by your browser.');
});

// --- Form & Toolbar Actions ------------------------------------------------

$('source-form').addEventListener('submit', (event) => {
  event.preventDefault();
  loadSource($('video-url').value, $('source-type').value, $('live-stream').checked);
});

$('quality-select').addEventListener('change', () => {
  if (failed) return;
  const level = Number($('quality-select').value);
  if (qualityMode === 'hls' && hlsEngine) {
    if (!Number.isInteger(level) || level < -1 || level >= hlsEngine.levels.length) return;
    hlsEngine.currentLevel = level;
    refreshQuality();
  } else if (qualityMode === 'dash' && dashEngine) {
    dashManualLevel = level;
    try {
      if (level === -1) {
        dashEngine.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: true } } } });
      } else {
        dashEngine.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false } } } });
        dashEngine.setRepresentationForTypeByIndex('video', level, true);
      }
    } catch { /* ignore */ }
    refreshQuality();
  }
});

$('screenshot-button').addEventListener('click', async () => {
  if ($('screenshot-button').disabled || !source) return;
  const current = generation;
  const filename = screenshotFilename(source.url, video.currentTime);
  capturePending = true;
  $('screenshot-label').textContent = 'Saving…';
  $('screenshot-feedback').hidden = true;
  refreshScreenshot();
  try {
    const blob = await captureFrame(video);
    if (current !== generation || failed) return;
    const objectURL = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectURL;
    link.download = filename;
    document.body.append(link);
    try { link.click(); }
    finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectURL), 60000);
    }
    $('screenshot-feedback').textContent = `Screenshot ready · ${filename}`;
    $('screenshot-feedback').dataset.state = 'success';
    $('screenshot-feedback').hidden = false;
  } catch (error) {
    if (current !== generation || failed) return;
    if (error.name === 'SecurityError') {
      captureBlocked = true;
      $('screenshot-feedback').textContent = 'This video host does not allow screenshots from this page. Its media responses must permit cross-origin access (CORS).';
    } else {
      $('screenshot-feedback').textContent = error.message || 'Could not save the screenshot. Please try again.';
    }
    $('screenshot-feedback').dataset.state = 'error';
    $('screenshot-feedback').hidden = false;
  } finally {
    if (current === generation) {
      capturePending = false;
      $('screenshot-label').textContent = 'Save screenshot';
      refreshScreenshot();
      controls.reveal();
    }
  }
});

function refreshLiveOption() {
  let type = $('source-type').value;
  let url;
  try {
    url = new URL($('video-url').value, document.baseURI).href;
    type = detectFormat(url, type);
  } catch { /* Unknown URLs retain the selected format until they are loaded. */ }
  if (url !== liveOptionURL) {
    const detected = isKnownLiveFLV(url, type);
    if (detected || liveOptionAuto) $('live-stream').checked = detected;
    liveOptionAuto = detected;
    liveOptionURL = url;
  }
  $('live-stream').disabled = !['flv', 'mp4', 'auto'].includes(type);
  updateConfigPills();
}

$('source-type').addEventListener('change', refreshLiveOption);
$('video-url').addEventListener('input', refreshLiveOption);
$('live-stream').addEventListener('change', () => { liveOptionAuto = false; });
$('retry-button').addEventListener('click', () => {
  if (source) loadSource(source.url, source.type, source.live);
});
$('example-button').addEventListener('click', () => {
  customSessionHeaders = null;
  customSessionDrm = null;
  $('source-type').value = 'auto';
  $('live-stream').checked = false;
  $('live-stream').disabled = false;
  loadSource(exampleURL, 'flv', false, { example: true });
});

document.querySelectorAll('[data-share-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    shareLinkMode = btn.dataset.shareMode || 'playerShort';
    refreshSharePanel();
  });
});

async function copyShareableLink() {
  const shareable = buildShareSource();
  if (!shareable) return;
  const fullUrl = createPlayerLink(location.href, shareable);
  refreshSharePanel();
  $('share-fallback').hidden = false;

  if (shareLinkMode !== 'full' && shareable.url !== exampleURL) {
    $('copy-label').textContent = 'Shortening…';
    await ensureShortenedForCurrentSource({ replaceAddress: true });
  }
  const link = getDisplayedShareUrl(fullUrl);
  $('share-url').value = link;

  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(link);
    $('copy-label').textContent = 'Link copied!';
    $('copy-share-again').textContent = 'Copied!';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      $('copy-label').textContent = 'Copy shareable link';
      $('copy-share-again').textContent = 'Copy';
    }, 2500);
  } catch {
    $('copy-label').textContent = 'Copy shareable link';
    $('share-url').focus();
    $('share-url').select();
  }
}

$('copy-link').addEventListener('click', copyShareableLink);
$('copy-share-again').addEventListener('click', copyShareableLink);
$('close-share').addEventListener('click', () => {
  $('share-fallback').hidden = true;
  $('copy-link').focus();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!$('site-headers-modal').hidden) closeSiteHeadersModal();
    if (!$('drm-modal').hidden) closeDrmModal();
  }
});

async function restoreLocation() {
  let initial = readSource(location.search);
  renderSavedRulesLists();

  if (!initial.url && initial.shortKey) {
    const shortKey = initial.shortKey;
    const shortProvider = initial.shortProvider;
    status('Resolving short link…', 'loading');
    $('source-name').textContent = `Short link (${shortKey})`;
    try {
      const resolvedHref = await resolveShortKey(shortKey, shortProvider);
      const parsed = new URL(resolvedHref, location.href);
      initial = readSource(parsed.search);
      const canonicalFull = createPlayerLink(location.href, {
        url: initial.url,
        type: detectFormat(initial.url, initial.type),
        live: initial.live,
        headers: initial.headers,
        drm: initial.drm,
      });
      currentShortInfo = {
        code: shortKey,
        provider: shortProvider,
        directShortUrl: `${shortProvider === 'vgd' ? 'https://v.gd' : 'https://is.gd'}/${shortKey}`,
        playerShortUrl: location.href,
        fullUrl: canonicalFull,
      };
    } catch (error) {
      fail('Short link could not be resolved', error.message);
      return;
    }
  }

  $('video-url').value = initial.url;
  $('source-type').value = initial.type;
  $('live-stream').checked = initial.live;
  $('live-stream').disabled = !['flv', 'mp4', 'auto'].includes(initial.type);

  if (initial.url) {
    loadSource(initial.url, initial.type, initial.live, {
      updateURL: false,
      inlineHeaders: initial.headers,
      inlineDrm: initial.drm,
    });
  } else {
    loadSource(exampleURL, 'flv', false, { updateURL: false, example: true });
  }
}

window.addEventListener('popstate', restoreLocation);
restoreLocation();
