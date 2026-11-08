import {
  FORMAT_LABELS,
  normalizeSource,
  detectFormat,
  isKnownLiveFLV,
  normalizeHost,
  formatHeaderLines,
  sanitizeHeaders,
  sanitizeProtectionConfig,
  readSource,
  parseShareableInput,
  createPlayerLink,
  createCompactPlayerLink,
  createAliasPlayerLink,
  loadRepoStreams,
  saveLocalAlias,
  findOrRegisterLocalAlias,
  resolveAliasSlug,
  loadGithubSyncConfig,
  saveGithubSyncConfig,
  clearGithubSyncConfig,
  pushStreamToGithubRepo,
  sourceLabel,
} from './player-utils.js?v=4';
import { qualityChoices, screenshotFilename, initFrameCapture, captureFrame } from './player-tools.js?v=4';
import { initPlayerControls } from './player-controls.js?v=4';
import { LiveMP4Player } from './live-mp4.js?v=4';
import {
  loadSiteHeaders,
  upsertSiteHeaders,
  removeSiteHeaders,
  getHeadersForHost,
  getEffectiveHeaders,
  getStoredProtectionConfig,
  listSavedProtectionConfigs,
  persistProtectionConfig,
  removeStoredProtectionConfig,
  getProtectionErrorText,
  isLikelyProtectionError,
  createHeaderRow,
  populateHeaderRows,
  readHeaderRows,
} from './player-config.js?v=4';

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
let includeProtectionInShare = true;
let customSessionProtection = null;
let customSessionHeaders = null;
let protectionPrompting = false;

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

function resolveStreamProtection(url, overrideProtection = null) {
  return sanitizeProtectionConfig(overrideProtection) || sanitizeProtectionConfig(customSessionProtection) || getStoredProtectionConfig(url);
}

function updateConfigPills() {
  const url = currentTargetUrl();
  const isExample = !url || url === exampleURL;
  const activeHeaders = !isExample ? resolveStreamHeaders(url, customSessionHeaders) : null;
  const headerCount = activeHeaders ? Object.keys(activeHeaders).length : 0;

  $('open-site-headers').dataset.active = String(headerCount > 0);
  $('headers-count-badge').hidden = headerCount === 0;
  $('headers-count-badge').textContent = String(headerCount);

  const activeProtection = !isExample ? resolveStreamProtection(url) : null;
  const hasProtection = Boolean(activeProtection?.licenseUrl);
  $('open-protection-config').dataset.active = String(hasProtection);
  $('protection-active-badge').hidden = !hasProtection;
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

  const protectionList = $('saved-protection-list');
  const savedProtection = listSavedProtectionConfigs();
  if (!savedProtection.length && !customSessionProtection?.licenseUrl) {
    const empty = document.createElement('p');
    empty.className = 'saved-rule-empty';
    empty.textContent = 'No DASH Protection configurations saved yet. Click "+ Configure Protection" when playing encrypted .mpd streams.';
    protectionList.replaceChildren(empty);
  } else {
    const items = [...savedProtection];
    if (customSessionProtection?.licenseUrl) {
      const host = currentTargetHost() || 'Current stream';
      if (!items.some((entry) => entry.host === host)) {
        items.unshift({ host, config: customSessionProtection, sessionOnly: true });
      }
    }
    protectionList.replaceChildren(...items.map(({ host, config, sessionOnly }) => {
      const item = document.createElement('div');
      item.className = 'saved-rule-item';

      const info = document.createElement('div');
      info.className = 'saved-rule-info';
      const hostEl = document.createElement('div');
      hostEl.className = 'saved-rule-host';
      hostEl.textContent = host;

      const pill = document.createElement('span');
      pill.className = 'saved-rule-pill';
      pill.textContent = config.robustness || 'Protection';
      hostEl.appendChild(pill);

      const detail = document.createElement('pre');
      detail.className = 'saved-rule-detail';
      const hdrCount = config.headers ? Object.keys(config.headers).length : 0;
      detail.textContent = `License: ${config.licenseUrl}${hdrCount ? `\nHeaders: ${ Object.keys(config.headers).join(', ') }` : ''}`;
      info.append(hostEl, detail);

      const actions = document.createElement('div');
      actions.className = 'saved-rule-actions';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'rule-btn';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => openProtectionModal({ prefill: config, host }));

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'rule-btn rule-btn--danger';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => {
        if (!sessionOnly) removeStoredProtectionConfig(host);
        customSessionProtection = null;
        if (source) {
          source.protection = includeProtectionInShare ? resolveStreamProtection(source.url) : null;
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

function fail(title, message, { showProtectionAction = false } = {}) {
  if (failed) return;
  failed = true;
  dispose();
  $('video-message-title').textContent = title;
  $('video-message-text').textContent = message;
  $('error-protection-button').hidden = !showProtectionAction && source?.type !== 'dash';
  $('video-message').hidden = false;
  status('Unable to play this source', 'error');
  singleQuality('Unavailable', 'Load a playable video to see its quality.');
  refreshScreenshot();
}

let shareLinkMode = 'compact';
let shareLinkModeManual = false;
let currentAliasSlug = '';
let currentAliasInRepo = false;
let repoStreamsMap = {};

function buildShareSource() {
  if (!source) return null;
  return {
    ...source,
    headers: includeHeadersInShare ? resolveStreamHeaders(source.url, customSessionHeaders) : null,
    protection: includeProtectionInShare ? resolveStreamProtection(source.url) : null,
  };
}

function getBestSelfContainedMode(shareable) {
  if (!shareable) return 'compact';
  const compactLink = createCompactPlayerLink(location.href, shareable);
  const fullLink = createPlayerLink(location.href, shareable);
  return compactLink.length <= fullLink.length ? 'compact' : 'full';
}

function getDisplayedShareUrl(shareable) {
  if (!shareable) return '';
  if (shareLinkMode === 'full') return createPlayerLink(location.href, shareable);
  if (shareLinkMode === 'compact') return createCompactPlayerLink(location.href, shareable);
  if (currentAliasSlug && (currentAliasInRepo || shareLinkModeManual)) {
    return createAliasPlayerLink(location.href, currentAliasSlug);
  }
  return getBestSelfContainedMode(shareable) === 'full'
    ? createPlayerLink(location.href, shareable)
    : createCompactPlayerLink(location.href, shareable);
}

function syncShareModeButtons() {
  document.querySelectorAll('[data-share-mode]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.shareMode === shareLinkMode));
  });
  $('share-alias-row').hidden = shareLinkMode !== 'alias';
}

function updateAliasStatusUI(customMsg = '') {
  $('alias-slug-input').value = currentAliasSlug;
  const statusEl = $('alias-repo-status');
  if (customMsg) {
    statusEl.dataset.inRepo = String(currentAliasInRepo);
    statusEl.textContent = customMsg;
    return;
  }
  const ghCfg = loadGithubSyncConfig();
  if (currentAliasInRepo) {
    statusEl.dataset.inRepo = 'true';
    statusEl.textContent = '✓ In GitHub streams.json — this short ?s= link works for all friends!';
  } else if (ghCfg.token) {
    statusEl.dataset.inRepo = 'false';
    statusEl.textContent = 'Click "Save to GitHub" to commit this ?s= link to streams.json';
  } else {
    statusEl.dataset.inRepo = 'false';
    statusEl.textContent = 'Click "Auto-Sync Settings" to auto-save to GitHub streams.json, or use Compact (?z=…)';
  }
}

async function pushCurrentStreamToGithub({ isAuto = false } = {}) {
  const shareable = buildShareSource();
  if (!shareable || shareable.url === exampleURL) return false;
  const slug = $('alias-slug-input').value.trim().replace(/[^0-9A-Za-z_-]/g, '') || currentAliasSlug;
  const btn = $('push-github-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  updateAliasStatusUI('Saving to GitHub streams.json…');
  try {
    const res = await pushStreamToGithubRepo(slug, shareable);
    currentAliasSlug = res.slug;
    currentAliasInRepo = true;
    repoStreamsMap = res.streams;
    if (!shareLinkModeManual) shareLinkMode = 'alias';
    syncShareModeButtons();
    updateAliasStatusUI();
    const latest = buildShareSource();
    if (latest) {
      $('share-url').value = getDisplayedShareUrl(latest);
      try {
        history.replaceState(null, '', createAliasPlayerLink(location.href, currentAliasSlug));
      } catch { /* ignore */ }
    }
    btn.textContent = 'Saved!';
    setTimeout(() => { btn.textContent = 'Save to GitHub'; btn.disabled = false; }, 2000);
    return true;
  } catch (error) {
    btn.textContent = 'Save to GitHub';
    btn.disabled = false;
    updateAliasStatusUI(isAuto ? `Auto-sync skipped: ${error.message}` : `GitHub error: ${error.message}`);
    return false;
  }
}

async function syncLocalAliasForCurrentSource({ replaceAddress = true, preferredSlug = '' } = {}) {
  const shareable = buildShareSource();
  if (!shareable || shareable.url === exampleURL) return;
  repoStreamsMap = await loadRepoStreams();
  if (preferredSlug) {
    const clean = saveLocalAlias(preferredSlug, shareable);
    if (clean) {
      currentAliasSlug = clean;
      currentAliasInRepo = Boolean(repoStreamsMap?.[clean]);
    }
  } else {
    const found = findOrRegisterLocalAlias(shareable, repoStreamsMap);
    currentAliasSlug = found.slug;
    currentAliasInRepo = found.inRepo;
  }
  const ghCfg = loadGithubSyncConfig();
  if (!shareLinkModeManual) {
    shareLinkMode = currentAliasInRepo ? 'alias' : getBestSelfContainedMode(shareable);
  }
  syncShareModeButtons();
  updateAliasStatusUI();
  const latest = buildShareSource();
  if (latest) {
    $('share-url').value = getDisplayedShareUrl(latest);
    if (replaceAddress) {
      try {
        const addrUrl = currentAliasInRepo && currentAliasSlug
          ? createAliasPlayerLink(location.href, currentAliasSlug)
          : getDisplayedShareUrl(latest);
        history.replaceState(null, '', addrUrl);
      } catch { /* ignore */ }
    }
  }
  if (!currentAliasInRepo && ghCfg.token && ghCfg.autoSync) {
    await pushCurrentStreamToGithub({ isAuto: true });
  }
}

function updateAddress() {
  const shareable = buildShareSource();
  if (!shareable || shareable.url === exampleURL) return;
  syncLocalAliasForCurrentSource({ replaceAddress: true });
}

function refreshSharePanel() {
  const shareable = buildShareSource();
  if (!shareable) return;
  syncShareModeButtons();
  if (shareable.url !== exampleURL && !currentAliasSlug) {
    const found = findOrRegisterLocalAlias(shareable, repoStreamsMap);
    currentAliasSlug = found.slug;
    currentAliasInRepo = found.inRepo;
  }
  updateAliasStatusUI();
  $('share-url').value = getDisplayedShareUrl(shareable);

  const tags = [];
  tags.push({ label: 'Format', value: FORMAT_LABELS[shareable.type] || shareable.type.toUpperCase() });
  if (shareable.live) tags.push({ label: 'Mode', value: 'Live' });
  const hdrCount = shareable.headers ? Object.keys(shareable.headers).length : 0;
  if (hdrCount > 0) {
    tags.push({ label: 'Per-site headers', value: `${hdrCount} included` });
  }
  if (shareable.protection?.licenseUrl) {
    tags.push({
      label: 'DASH Protection',
      value: shareable.protection.robustness ? `License + ${shareable.protection.robustness}` : 'License URL included',
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
  if (source.type === 'dash' && resolveStreamProtection(source.url)?.licenseUrl) parts.push('PROTECTED');
  if (resolveStreamHeaders(source.url, customSessionHeaders)) parts.push('HEADERS');
  $('format-badge').textContent = parts.join(' · ');
}

function loadSource(raw, selected, live, { updateURL = true, example = false, inlineHeaders = null, inlineProtection = null, preferredAlias = '' } = {}) {
  $('form-error').hidden = true;
  $('video-url').removeAttribute('aria-invalid');

  if (!example) {
    const embeddedShare = parseShareableInput(raw, document.baseURI);
    if (embeddedShare) {
      if (!embeddedShare.url && embeddedShare.aliasSlug) {
        status('Loading local stream preset…', 'loading');
        $('source-name').textContent = `Preset (${embeddedShare.aliasSlug})`;
        resolveAliasSlug(embeddedShare.aliasSlug).then((resolved) => {
          if (!resolved?.url) {
            fail(
              `Preset "${embeddedShare.aliasSlug}" not found`,
              `Could not find "${embeddedShare.aliasSlug}" in your browser storage or streams.json. Use the Compact (?z=…) or Standard (?url=…) link instead.`,
            );
            return;
          }
          loadSource(resolved.url, resolved.type || 'auto', Boolean(resolved.live), {
            updateURL,
            inlineHeaders: resolved.headers,
            inlineProtection: resolved.protection,
            preferredAlias: embeddedShare.aliasSlug,
          });
        });
        return;
      }
      if (embeddedShare.url) {
        raw = embeddedShare.url;
        if (embeddedShare.type && embeddedShare.type !== 'auto') selected = embeddedShare.type;
        if (embeddedShare.live) live = true;
        if (embeddedShare.headers && !inlineHeaders) inlineHeaders = embeddedShare.headers;
        if (embeddedShare.protection && !inlineProtection) inlineProtection = embeddedShare.protection;
      }
    }
  }

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
  if (inlineProtection) {
    customSessionProtection = sanitizeProtectionConfig(inlineProtection);
    if (customSessionProtection) {
      persistProtectionConfig(url, customSessionProtection, true);
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
  const effectiveProtection = !isExample ? resolveStreamProtection(url) : null;

  source = {
    url,
    type,
    live: ['flv', 'mp4'].includes(type) && live,
    headers: effectiveHeaders,
    protection: effectiveProtection,
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
  shareLinkModeManual = false;
  currentAliasSlug = preferredAlias || '';
  refreshSharePanel();
  $('video-message').hidden = true;
  video.removeAttribute('poster');
  status('Loading video…', 'loading');
  if (!isExample) {
    syncLocalAliasForCurrentSource({ replaceAddress: true, preferredSlug: preferredAlias });
  } else if (updateURL) {
    updateAddress();
  }
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
      startDashPlayback(url, current, effectiveHeaders, effectiveProtection);
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

async function startDashPlayback(url, current, effectiveHeaders, effectiveProtection) {
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
      const protCfg = resolveStreamProtection(url) || effectiveProtection;
      const merged = { ...(siteHdrs || {}), ...(protCfg?.headers || {}) };
      if (Object.keys(merged).length) {
        request.headers = Object.assign(request.headers || {}, merged);
      }
      return Promise.resolve();
    });

    if (effectiveProtection?.licenseUrl) {
      const protData = { serverURL: effectiveProtection.licenseUrl, priority: 1 };
      if (effectiveProtection.headers && Object.keys(effectiveProtection.headers).length) {
        protData.httpRequestHeaders = effectiveProtection.headers;
      }
      if (effectiveProtection.robustness) {
        protData.videoRobustness = effectiveProtection.robustness;
        protData.audioRobustness = effectiveProtection.robustness;
      }
      const keySys = atob('Y29tLndpZGV2aW5lLmFscGhh');
      player.setProtectionData({ [keySys]: protData });
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

    const handleProtectionOrDashError = (event, forceProtection = false) => {
      if (current !== generation) return;
      if (forceProtection || isLikelyProtectionError(event)) {
        const protText = getProtectionErrorText(event).slice(0, 400);
        fail(
          'Encrypted DASH stream requires Protection',
          'Enter a license URL, optional request headers, and robustness level to play this encrypted .mpd stream.',
          { showProtectionAction: true },
        );
        if (!protectionPrompting) {
          openProtectionModal({
            detectedError: protText || 'Protection key system / license required for this DASH stream.',
          });
        }
        return;
      }
      const errObj = event?.error || event;
      const statusCode = errObj?.data?.response?.status ?? errObj?.data?.request?.status;
      if (errObj?.code === 27 || errObj?.code === 25 || statusCode) {
        networkFailure('DASH manifest or segment', statusCode);
      } else if (errObj?.message) {
        fail('DASH playback error', errObj.message, { showProtectionAction: true });
      }
    };

    player.on('public_keyError', (ev) => handleProtectionOrDashError(ev, true));
    player.on(events.ERROR || 'error', (ev) => handleProtectionOrDashError(ev, false));

    player.initialize(video, url, false);
  } catch (error) {
    if (current === generation && !failed) {
      fail('DASH playback is unavailable', error.message, { showProtectionAction: true });
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

// --- Modal: DASH Protection ------------------------------------------------

function openProtectionModal({ detectedError = '', prefill = null, host = '' } = {}) {
  protectionPrompting = true;
  const targetUrl = currentTargetUrl();
  const initial = prefill || (targetUrl ? resolveStreamProtection(targetUrl) : null) || getStoredProtectionConfig(host || targetUrl, { fallbackToLast: true });

  const banner = $('protection-detected-message');
  if (detectedError) {
    banner.textContent = `Detected encrypted DASH stream:\n${detectedError}`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
    banner.textContent = '';
  }

  $('protection-license-url').value = initial?.licenseUrl || '';
  $('protection-robustness').value = initial?.robustness || '';
  populateHeaderRows($('protection-header-rows'), initial?.headers, ['', '']);
  $('protection-include-share').checked = includeProtectionInShare;
  $('protection-error').hidden = true;
  $('protection-modal').hidden = false;
  setTimeout(() => $('protection-license-url').focus(), 0);
}

function closeProtectionModal() {
  $('protection-modal').hidden = true;
  protectionPrompting = false;
}

$('open-protection-config').addEventListener('click', () => openProtectionModal());
$('card-open-protection').addEventListener('click', () => openProtectionModal());
$('error-protection-button').addEventListener('click', () => openProtectionModal());
$('protection-close-x').addEventListener('click', closeProtectionModal);
$('protection-cancel').addEventListener('click', closeProtectionModal);
$('protection-modal').addEventListener('click', (event) => {
  if (event.target === $('protection-modal')) closeProtectionModal();
});

$('protection-add-header').addEventListener('click', () => {
  const row = createHeaderRow();
  $('protection-header-rows').appendChild(row);
  row.querySelector('[data-header-key]')?.focus();
});

document.querySelectorAll('[data-protection-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const presetName = btn.dataset.protectionPreset;
    const container = $('protection-header-rows');
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

$('protection-header-rows').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-header-remove]');
  if (!btn) return;
  const container = $('protection-header-rows');
  const row = btn.closest('.header-row');
  if (container.children.length <= 1) {
    row.querySelectorAll('input').forEach((input) => { input.value = ''; });
  } else {
    row.remove();
  }
});

$('protection-clear').addEventListener('click', () => {
  const host = currentTargetHost();
  if (host) removeStoredProtectionConfig(host);
  customSessionProtection = null;
  closeProtectionModal();
  renderSavedRulesLists();
  updateConfigPills();
  if (source && source.url !== exampleURL) {
    loadSource(source.url, source.type, source.live);
  }
});

$('protection-apply').addEventListener('click', () => {
  $('protection-error').hidden = true;
  const licenseUrl = $('protection-license-url').value.trim();
  if (!licenseUrl) {
    $('protection-error').textContent = 'Enter a Protection license URL (HTTP or HTTPS).';
    $('protection-error').hidden = false;
    $('protection-license-url').focus();
    return;
  }
  try {
    const parsed = new URL(licenseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid protocol');
  } catch {
    $('protection-error').textContent = 'Enter a valid HTTP or HTTPS Protection license URL.';
    $('protection-error').hidden = false;
    $('protection-license-url').focus();
    return;
  }

  const { headers, errors } = readHeaderRows($('protection-header-rows'));
  if (errors.length) {
    $('protection-error').textContent = errors[0];
    $('protection-error').hidden = false;
    return;
  }

  const robustness = $('protection-robustness').value.trim() || undefined;
  const remember = $('protection-remember').checked;
  includeProtectionInShare = $('protection-include-share').checked;

  const config = sanitizeProtectionConfig({
    licenseUrl,
    headers,
    robustness,
  });

  customSessionProtection = config;
  const targetUrl = currentTargetUrl();
  if (targetUrl && targetUrl !== exampleURL) {
    persistProtectionConfig(targetUrl, config, remember);
  }

  closeProtectionModal();
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
  customSessionProtection = null;
  $('source-type').value = 'auto';
  $('live-stream').checked = false;
  $('live-stream').disabled = false;
  loadSource(exampleURL, 'flv', false, { example: true });
});

document.querySelectorAll('[data-share-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    shareLinkModeManual = true;
    shareLinkMode = btn.dataset.shareMode || 'alias';
    refreshSharePanel();
  });
});

function applyCustomAliasSlug() {
  const slug = $('alias-slug-input').value.trim().replace(/[^0-9A-Za-z_-]/g, '');
  if (!slug) return;
  syncLocalAliasForCurrentSource({ replaceAddress: true, preferredSlug: slug });
}

$('save-alias-slug').addEventListener('click', applyCustomAliasSlug);
$('alias-slug-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    applyCustomAliasSlug();
  }
});

$('push-github-btn').addEventListener('click', () => {
  const cfg = loadGithubSyncConfig();
  if (!cfg.token) {
    openGhSyncModal();
    return;
  }
  pushCurrentStreamToGithub({ isAuto: false });
});

function openGhSyncModal() {
  const cfg = loadGithubSyncConfig();
  $('gh-repo-input').value = cfg.repo;
  $('gh-branch-input').value = cfg.branch;
  $('gh-token-input').value = cfg.token;
  $('gh-auto-sync-checkbox').checked = cfg.autoSync;
  $('gh-sync-error').hidden = true;
  $('gh-sync-modal').hidden = false;
  setTimeout(() => $('gh-token-input').focus(), 0);
}

function closeGhSyncModal() {
  $('gh-sync-modal').hidden = true;
}

$('open-gh-sync').addEventListener('click', openGhSyncModal);
$('gh-sync-close-x').addEventListener('click', closeGhSyncModal);
$('gh-sync-cancel').addEventListener('click', closeGhSyncModal);
$('gh-sync-modal').addEventListener('click', (event) => {
  if (event.target === $('gh-sync-modal')) closeGhSyncModal();
});

$('gh-sync-clear').addEventListener('click', () => {
  clearGithubSyncConfig();
  closeGhSyncModal();
  updateAliasStatusUI('GitHub token removed from browser.');
});

$('gh-sync-save').addEventListener('click', async () => {
  $('gh-sync-error').hidden = true;
  const repo = $('gh-repo-input').value.trim();
  const branch = $('gh-branch-input').value.trim() || 'main';
  const token = $('gh-token-input').value.trim();
  const autoSync = $('gh-auto-sync-checkbox').checked;

  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    $('gh-sync-error').textContent = 'Enter a valid GitHub repository in owner/repo format (for example: curiousmidnight/DashPlay).';
    $('gh-sync-error').hidden = false;
    $('gh-repo-input').focus();
    return;
  }
  if (!token) {
    $('gh-sync-error').textContent = 'Paste a GitHub Personal Access Token with Contents (Read and write) permission.';
    $('gh-sync-error').hidden = false;
    $('gh-token-input').focus();
    return;
  }

  saveGithubSyncConfig({ repo, branch, token, autoSync });
  closeGhSyncModal();
  await pushCurrentStreamToGithub({ isAuto: false });
});

async function copyShareableLink() {
  const shareable = buildShareSource();
  if (!shareable) return;
  refreshSharePanel();
  $('share-fallback').hidden = false;

  const link = getDisplayedShareUrl(shareable);
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

  const ghCfg = loadGithubSyncConfig();
  if (shareLinkMode === 'alias' && !currentAliasInRepo && ghCfg.token) {
    const ok = await pushCurrentStreamToGithub({ isAuto: true });
    if (ok) {
      const updated = getDisplayedShareUrl(buildShareSource());
      $('share-url').value = updated;
      try { await navigator.clipboard.writeText(updated); } catch { /* ignore */ }
    }
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
    if (!$('protection-modal').hidden) closeProtectionModal();
    if (!$('gh-sync-modal').hidden) closeGhSyncModal();
  }
});

async function restoreLocation() {
  let initial = readSource(location.search, location.hash);
  renderSavedRulesLists();

  let matchedSlug = '';
  if (!initial.url && initial.aliasSlug) {
    matchedSlug = initial.aliasSlug;
    status('Loading local stream preset…', 'loading');
    $('source-name').textContent = `Preset (${matchedSlug})`;
    const resolved = await resolveAliasSlug(matchedSlug);
    if (!resolved?.url) {
      fail(
        `Preset "${matchedSlug}" not found`,
        `Could not find "${matchedSlug}" in your browser storage or streams.json. Ask your friend for the Compact (?z=…) link or add "${matchedSlug}" to streams.json.`,
      );
      return;
    }
    initial = { ...resolved, aliasSlug: matchedSlug };
  }

  $('video-url').value = initial.url;
  $('source-type').value = initial.type;
  $('live-stream').checked = initial.live;
  $('live-stream').disabled = !['flv', 'mp4', 'auto'].includes(initial.type);

  if (initial.url) {
    loadSource(initial.url, initial.type, initial.live, {
      updateURL: false,
      inlineHeaders: initial.headers,
      inlineProtection: initial.protection,
      preferredAlias: matchedSlug,
    });
  } else {
    loadSource(exampleURL, 'flv', false, { updateURL: false, example: true });
  }
}

window.addEventListener('popstate', restoreLocation);
restoreLocation();
