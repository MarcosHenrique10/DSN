(() => {
  'use strict';

  const DEFAULT_BOOK_ID = '101-dalmatians';
  const DEFAULT_PAGE_W = 723;
  const DEFAULT_PAGE_H = 985;
  const PREFS_KEY = 'epub3_reader_layout_v2';

  const urlParams = new URLSearchParams(window.location.search);
  const BOOK_ID = urlParams.get('book') || DEFAULT_BOOK_ID;
  let BOOK_BASE = `books/${encodeURIComponent(BOOK_ID)}/`;
  const PAGE_STORAGE_KEY = `epub3_last_page_${BOOK_ID}`;

  async function resolveBookBase() {
    const isLocal = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
    if (isLocal) return;
    try {
      const res = await fetch('library.json');
      if (!res.ok) return;
      const list = await res.json();
      const entry = list.find((b) => b.id === BOOK_ID);
      if (entry?.remoteBase) {
        BOOK_BASE = entry.remoteBase.endsWith('/') ? entry.remoteBase : `${entry.remoteBase}/`;
      }
    } catch {
      // Keep default relative BOOK_BASE
    }
  }

  const dom = {
    stage: document.getElementById('stage'),
    spreadContainer: document.getElementById('spread-container'),
    btnPrev: document.getElementById('btn-prev'),
    btnNext: document.getElementById('btn-next'),
    audioControls: document.getElementById('audio-controls'),
    audioDivider: document.getElementById('audio-divider'),
    btnPlay: document.getElementById('btn-play'),
    iconPlay: document.getElementById('icon-play'),
    iconPause: document.getElementById('icon-pause'),
    audioTime: document.getElementById('audio-time'),
    pageSlider: document.getElementById('page-slider'),
    pageLabel: document.getElementById('page-label'),
    btnModeSingle: document.getElementById('btn-mode-single'),
    btnModeSpread: document.getElementById('btn-mode-spread'),
    btnCoverToggle: document.getElementById('btn-cover-toggle'),
    btnFullscreen: document.getElementById('btn-fullscreen'),
    iconFsEnter: document.getElementById('icon-fs-enter'),
    iconFsExit: document.getElementById('icon-fs-exit'),
    hud: document.getElementById('hud'),
    loadingOverlay: document.getElementById('loading-overlay'),
  };

  // Hidden <audio> fallback for books without per-page MP3 chunks
  const htmlAudio = document.createElement('audio');
  htmlAudio.preload = 'metadata';

  const state = {
    title: BOOK_ID,
    activeClass: 'media-overlay-active',
    bookHasAudio: false,
    useChunks: false,
    pages: [],
    spreads: [],
    spreadIndex: 0,
    mode: 'spread',
    separateCover: true,
    isPlaying: false,
    audioPageIndex: null,
    activeSlotMap: new Map(),
    lastHighlighted: null,
    lastTimeText: '',
    syncTimerId: null,
    hudTimer: null,
    hudHovered: false,
    prefetchedUrls: new Set(),
    playToken: 0,

    // Web Audio API engine (used when per-page MP3 chunks exist)
    audioCtx: null,
    activeSource: null,
    activeGain: null,
    startCtxTime: 0,
    startOffset: 0,
    pausedOffset: 0,
  };

  // --- Utilities ---

  function resolveZipPath(baseInnerPath, relative) {
    const cleanRel = relative.split('#')[0];
    const baseParts = baseInnerPath ? baseInnerPath.split('/') : [];
    if (baseParts.length) baseParts.pop();
    for (const part of cleanRel.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') baseParts.pop();
      else baseParts.push(part);
    }
    return baseParts.join('/');
  }

  function bookUrl(innerPath) {
    return BOOK_BASE + innerPath.split('/').map(encodeURIComponent).join('/');
  }

  function parseSmilClock(val) {
    if (!val) return 0;
    const s = val.trim();
    if (s.endsWith('ms')) return parseFloat(s.slice(0, -2)) / 1000;
    if (s.endsWith('s')) return parseFloat(s.slice(0, -1));
    if (s.endsWith('min')) return parseFloat(s.slice(0, -3)) * 60;
    if (s.endsWith('h')) return parseFloat(s.slice(0, -1)) * 3600;
    if (s.includes(':')) {
      const parts = s.split(':').map(Number);
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (parts.length === 2) return parts[0] * 60 + parts[1];
    }
    return parseFloat(s) || 0;
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function updateTimeDisplay(sec) {
    const txt = formatTime(sec);
    if (txt !== state.lastTimeText) {
      state.lastTimeText = txt;
      dom.audioTime.textContent = txt;
    }
  }

  async function fetchXml(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    const text = await res.text();
    return new DOMParser().parseFromString(text, 'application/xml');
  }

  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        mode: state.mode,
        separateCover: state.separateCover,
      }));
      const currentPage = state.spreads[state.spreadIndex]?.[0] ?? 0;
      localStorage.setItem(PAGE_STORAGE_KEY, String(currentPage));
    } catch {
      // Ignore storage errors
    }
  }

  function loadPrefs() {
    let mode = 'spread';
    let separateCover = true;
    let lastPage = 0;
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        mode = parsed.mode === 'single' ? 'single' : 'spread';
        separateCover = parsed.separateCover !== false;
      }
      const p = parseInt(localStorage.getItem(PAGE_STORAGE_KEY) || '0', 10);
      if (Number.isInteger(p) && p >= 0) lastPage = p;
    } catch {
      // Ignore
    }
    return { mode, separateCover, lastPage };
  }

  // --- Web Audio Engine (for per-page MP3 chunks) ---

  function getAudioContext() {
    if (!state.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      state.audioCtx = new AudioCtx({ latencyHint: 'playback' });
    }
    if (state.audioCtx.state === 'suspended') {
      state.audioCtx.resume().catch(() => {});
    }
    return state.audioCtx;
  }

  function getCurrentPlaybackTime() {
    if (state.useChunks) {
      if (!state.isPlaying || !state.audioCtx) return state.pausedOffset;
      return state.startOffset + Math.max(0, state.audioCtx.currentTime - state.startCtxTime);
    }
    return htmlAudio.currentTime || 0;
  }

  function stopActiveSource(fadeOutSec = 0.012) {
    const src = state.activeSource;
    const gain = state.activeGain;
    state.activeSource = null;
    state.activeGain = null;
    if (!src) return;

    src.onended = null;
    try {
      if (gain && state.audioCtx && fadeOutSec > 0) {
        const now = state.audioCtx.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + fadeOutSec);
        src.stop(now + fadeOutSec + 0.005);
      } else {
        src.stop();
      }
    } catch {
      // Already stopped
    }
  }

  async function ensurePageAudioBuffer(page) {
    if (!page || !page.chunkUrl) return null;
    if (page.audioBuffer) return page.audioBuffer;
    if (page.audioBufferPromise) return page.audioBufferPromise;

    page.audioBufferPromise = (async () => {
      try {
        const res = await fetch(page.chunkUrl);
        if (!res.ok) return null;
        const arrBuf = await res.arrayBuffer();
        const ctx = getAudioContext();
        const decoded = await ctx.decodeAudioData(arrBuf);
        page.audioBuffer = decoded;
        return decoded;
      } catch (err) {
        console.warn(`Audio decode failed for page ${page.index + 1}:`, err);
        page.audioBufferPromise = null;
        return null;
      }
    })();

    return page.audioBufferPromise;
  }

  // --- EPUB3 Static Loader ---

  async function loadChunkManifest() {
    try {
      const res = await fetch(`${BOOK_BASE}audio-pages/manifest.json`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function loadEpubManifest() {
    const [containerDoc, chunkManifest] = await Promise.all([
      fetchXml(bookUrl('META-INF/container.xml')),
      loadChunkManifest(),
    ]);

    state.useChunks = Boolean(chunkManifest && Object.keys(chunkManifest).length > 0);

    const rootfile = containerDoc.querySelector('rootfile');
    if (!rootfile) throw new Error('Invalid container.xml: missing rootfile');
    const opfInnerPath = rootfile.getAttribute('full-path');

    const opfDoc = await fetchXml(bookUrl(opfInnerPath));

    const titleEl = opfDoc.getElementsByTagName('dc:title')[0] || opfDoc.querySelector('title');
    if (titleEl?.textContent) {
      state.title = titleEl.textContent.trim();
      document.title = `${state.title} — EPUB3 Reader`;
    }

    const metas = opfDoc.querySelectorAll('metadata > meta');
    for (const meta of metas) {
      if (meta.getAttribute('property') === 'media:active-class' && meta.textContent.trim()) {
        state.activeClass = meta.textContent.trim();
      }
    }

    const manifest = new Map();
    for (const item of opfDoc.querySelectorAll('manifest > item')) {
      const mtype = item.getAttribute('media-type') || '';
      if (mtype.startsWith('audio/')) state.bookHasAudio = true;
      manifest.set(item.getAttribute('id'), {
        id: item.getAttribute('id'),
        href: item.getAttribute('href'),
        mediaType: mtype,
        mediaOverlay: item.getAttribute('media-overlay'),
      });
    }

    if (state.useChunks) state.bookHasAudio = true;

    if (!state.bookHasAudio) {
      dom.audioControls?.classList.add('hidden');
      dom.audioDivider?.classList.add('hidden');
    }

    const spineRefs = [...opfDoc.querySelectorAll('spine > itemref')];
    state.pages = spineRefs.map((ref, index) => {
      const idref = ref.getAttribute('idref');
      const item = manifest.get(idref);
      const smilItem = item.mediaOverlay ? manifest.get(item.mediaOverlay) : null;
      const xhtmlInner = resolveZipPath(opfInnerPath, item.href);
      const smilInner = smilItem ? resolveZipPath(opfInnerPath, smilItem.href) : null;
      const chunk = state.useChunks && smilItem ? chunkManifest[smilItem.href] : null;

      const imgNum = item.href.replace(/\.xhtml$/i, '');
      const imgItem = manifest.get(`img${imgNum}`);
      const imgInner = imgItem ? resolveZipPath(opfInnerPath, imgItem.href) : null;

      return {
        index,
        id: idref,
        href: item.href,
        fullUrl: bookUrl(xhtmlInner),
        imgUrl: imgInner ? bookUrl(imgInner) : null,
        smilInner,
        smilUrl: smilInner ? bookUrl(smilInner) : null,
        width: DEFAULT_PAGE_W,
        height: DEFAULT_PAGE_H,
        hasAudio: state.useChunks ? Boolean(chunk) : Boolean(smilInner && state.bookHasAudio),
        chunkUrl: chunk ? `${BOOK_BASE}${chunk.src}` : null,
        chunkOffset: chunk ? chunk.offsetSec : 0,
        audioSrcUrl: null,
        clipStart: 0,
        clipEnd: 0,
        audioBuffer: null,
        audioBufferPromise: null,
        pars: [],
        smilLoaded: !smilInner,
        smilPromise: null,
      };
    });
  }

  async function ensurePageSmil(pageIndex) {
    const page = state.pages[pageIndex];
    if (!page || page.smilLoaded) return;
    if (page.smilPromise) return page.smilPromise;

    page.smilPromise = (async () => {
      try {
        const smilDoc = await fetchXml(page.smilUrl);
        const pars = [...smilDoc.querySelectorAll('par')];
        const rawEntries = [];
        let audioInnerPath = null;

        for (const par of pars) {
          const textEl = par.querySelector('text');
          const audioEl = par.querySelector('audio');
          if (!textEl || !audioEl) continue;

          const textSrc = textEl.getAttribute('src') || '';
          const hashIdx = textSrc.indexOf('#');
          const textId = hashIdx >= 0 ? textSrc.slice(hashIdx + 1) : '';
          const beginSec = parseSmilClock(audioEl.getAttribute('clipBegin'));
          const endSec = parseSmilClock(audioEl.getAttribute('clipEnd'));
          const audioRel = audioEl.getAttribute('src') || '';
          if (!audioInnerPath && audioRel) {
            audioInnerPath = resolveZipPath(page.smilInner, audioRel);
          }
          rawEntries.push({ textId, beginSec, endSec });
        }

        if (!rawEntries.length) {
          page.hasAudio = false;
          page.smilLoaded = true;
          return;
        }

        const clipStart = rawEntries[0].beginSec;
        const clipEnd = rawEntries[rawEntries.length - 1].endSec;
        const clipDur = clipEnd - clipStart;

        if (clipDur <= 0.15) {
          page.hasAudio = false;
          page.smilLoaded = true;
          return;
        }

        page.clipStart = clipStart;
        page.clipEnd = clipEnd;
        if (audioInnerPath) {
          page.audioSrcUrl = bookUrl(audioInnerPath);
        }

        if (state.useChunks && page.chunkUrl) {
          page.pars = rawEntries.map((e) => ({
            pageIndex: page.index,
            textId: e.textId,
            beginSec: Math.max(0, e.beginSec - page.chunkOffset),
            endSec: Math.max(0, e.endSec - page.chunkOffset),
          }));
          page.hasAudio = true;
        } else if (!state.useChunks && page.audioSrcUrl) {
          page.pars = rawEntries.map((e) => ({
            pageIndex: page.index,
            textId: e.textId,
            beginSec: e.beginSec,
            endSec: e.endSec,
          }));
          page.hasAudio = true;
        } else {
          page.hasAudio = false;
        }

        page.smilLoaded = true;
      } catch (err) {
        console.warn(`SMIL load failed for page ${pageIndex + 1}:`, err);
        page.hasAudio = false;
        page.smilLoaded = true;
      }
    })();

    return page.smilPromise;
  }

  function prefetchUrl(url) {
    if (!url || state.prefetchedUrls.has(url)) return;
    state.prefetchedUrls.add(url);
    fetch(url, { priority: 'low' }).catch(() => {});
  }

  function prefetchAdjacentSpreads() {
    const targets = [state.spreadIndex + 1, state.spreadIndex - 1];
    const run = async () => {
      for (const sIdx of targets) {
        const pageIndices = state.spreads[sIdx];
        if (!pageIndices) continue;
        for (const pIdx of pageIndices) {
          const p = state.pages[pIdx];
          if (!p) continue;
          prefetchUrl(p.fullUrl);
          if (p.imgUrl) prefetchUrl(p.imgUrl);
          await ensurePageSmil(pIdx);
          if (state.useChunks && p.hasAudio && p.chunkUrl) {
            if (state.audioCtx) ensurePageAudioBuffer(p);
            else prefetchUrl(p.chunkUrl);
          }
        }
      }
    };
    if ('requestIdleCallback' in window) {
      requestIdleCallback(() => run(), { timeout: 1500 });
    } else {
      setTimeout(run, 300);
    }
  }

  // --- Spread & Layout Logic ---

  function computeSpreads() {
    const total = state.pages.length;
    const spreads = [];

    if (state.mode === 'single') {
      for (let i = 0; i < total; i++) spreads.push([i]);
    } else if (state.separateCover) {
      if (total > 0) spreads.push([0]);
      for (let i = 1; i < total; i += 2) {
        if (i + 1 < total) spreads.push([i, i + 1]);
        else spreads.push([i]);
      }
    } else {
      for (let i = 0; i < total; i += 2) {
        if (i + 1 < total) spreads.push([i, i + 1]);
        else spreads.push([i]);
      }
    }

    state.spreads = spreads;
  }

  function findSpreadForPage(pageIndex) {
    const idx = state.spreads.findIndex((sp) => sp.includes(pageIndex));
    return idx >= 0 ? idx : 0;
  }

  async function renderSpread(targetSpreadIndex, { syncAudio = false } = {}) {
    if (!state.spreads.length) return;
    const clamped = Math.max(0, Math.min(targetSpreadIndex, state.spreads.length - 1));
    state.spreadIndex = clamped;

    const pageIndices = state.spreads[clamped];
    dom.spreadContainer.innerHTML = '';
    state.activeSlotMap.clear();
    clearHighlight();

    const smilReady = Promise.all(pageIndices.map((idx) => ensurePageSmil(idx)));

    pageIndices.forEach((pageIdx, pos) => {
      const page = state.pages[pageIdx];

      const slot = document.createElement('div');
      slot.className = 'page-slot';
      if (pageIndices.length === 2) {
        slot.classList.add(pos === 0 ? 'spread-left' : 'spread-right');
      }

      const iframe = document.createElement('iframe');
      iframe.className = 'page-frame';
      iframe.src = page.fullUrl;
      iframe.width = page.width;
      iframe.height = page.height;
      iframe.setAttribute('scrolling', 'no');
      iframe.setAttribute('title', `Page ${pageIdx + 1}`);

      const slotEntry = { slotEl: slot, iframe, doc: null, page };
      state.activeSlotMap.set(pageIdx, slotEntry);

      iframe.addEventListener('load', () => {
        try {
          const doc = iframe.contentDocument;
          slotEntry.doc = doc;
          updatePageDimensionsFromDoc(page, doc);
          injectIframeStylesAndHandlers(page, doc);
          fitSpreadToStage();
          highlightCurrentWord();
        } catch {
          // Ignore cross-origin if any
        }
      });

      slot.appendChild(iframe);
      dom.spreadContainer.appendChild(slot);
    });

    fitSpreadToStage();
    updateHudState();
    savePrefs();
    prefetchAdjacentSpreads();

    if (syncAudio && state.isPlaying) {
      await smilReady;
      const firstAudioPage = pageIndices.find((idx) => state.pages[idx]?.hasAudio);
      if (firstAudioPage !== undefined) {
        playPageAudio(firstAudioPage, null, true);
      } else {
        pauseAudio();
      }
    }
  }

  function updatePageDimensionsFromDoc(page, doc) {
    const vp = doc.querySelector('meta[name="viewport"]');
    if (!vp) return;
    const content = vp.getAttribute('content') || '';
    const wMatch = content.match(/width\s*=\s*(\d+)/i);
    const hMatch = content.match(/height\s*=\s*(\d+)/i);
    if (wMatch && hMatch) {
      page.width = parseInt(wMatch[1], 10);
      page.height = parseInt(hMatch[1], 10);
    }
  }

  function injectIframeStylesAndHandlers(page, doc) {
    const style = doc.createElement('style');
    style.textContent = `
      html, body { margin: 0; padding: 0; overflow: hidden; }
      .text-frame { transform: translateZ(0); }
      [id^="w"] { cursor: pointer; }
    `;
    doc.head?.appendChild(style);

    doc.addEventListener('keydown', handleKeyDown);

    doc.addEventListener('click', async (ev) => {
      resetHudTimer();
      const target = ev.target?.closest?.('[id]');
      if (!target) return;
      await ensurePageSmil(page.index);
      const wordId = target.id;
      const entry = page.pars.find((t) => t.textId === wordId);
      if (entry) {
        playPageAudio(page.index, entry.beginSec, false);
      }
    });
  }

  function fitSpreadToStage() {
    const pageIndices = state.spreads[state.spreadIndex];
    if (!pageIndices || !pageIndices.length) return;

    const pad = document.fullscreenElement ? 8 : 24;
    const availW = Math.max(100, dom.stage.clientWidth - pad);
    const availH = Math.max(100, dom.stage.clientHeight - pad);

    let totalW = 0;
    let maxH = 0;
    for (const idx of pageIndices) {
      const p = state.pages[idx];
      totalW += p.width;
      if (p.height > maxH) maxH = p.height;
    }

    const scale = Math.min(availW / totalW, availH / maxH);

    for (const idx of pageIndices) {
      const entry = state.activeSlotMap.get(idx);
      if (!entry) continue;
      const { slotEl, iframe, page } = entry;
      const scaledW = Math.floor(page.width * scale);
      const scaledH = Math.floor(page.height * scale);

      slotEl.style.width = `${scaledW}px`;
      slotEl.style.height = `${scaledH}px`;

      iframe.style.width = `${page.width}px`;
      iframe.style.height = `${page.height}px`;
      iframe.style.transform = `scale(${scale})`;
    }
  }

  // --- Event-Driven Read-Along Sync ---

  function findActiveParForPage(page, timeSec) {
    const pars = page?.pars;
    if (!pars || !pars.length) return null;
    let lo = 0;
    let hi = pars.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const item = pars[mid];
      if (timeSec < item.beginSec) {
        hi = mid - 1;
      } else if (timeSec >= item.endSec) {
        lo = mid + 1;
      } else {
        return item;
      }
    }
    return null;
  }

  function clearHighlight() {
    if (!state.lastHighlighted) return;
    const { pageIndex, textId } = state.lastHighlighted;
    const slot = state.activeSlotMap.get(pageIndex);
    if (slot?.doc && textId) {
      slot.doc.getElementById(textId)?.classList.remove(state.activeClass);
    }
    state.lastHighlighted = null;
  }

  function highlightCurrentWord() {
    if (state.audioPageIndex === null) return null;
    const page = state.pages[state.audioPageIndex];
    if (!page || !page.smilLoaded) return null;

    const now = getCurrentPlaybackTime();

    // For single-file M4A playback, auto-advance page when crossing page.clipEnd
    if (!state.useChunks && state.isPlaying && page.clipEnd > 0 && now >= page.clipEnd) {
      advanceToNextAudioPage();
      return null;
    }

    const par = findActiveParForPage(page, now);
    if (!par) {
      clearHighlight();
      return null;
    }

    if (
      !state.lastHighlighted ||
      state.lastHighlighted.pageIndex !== par.pageIndex ||
      state.lastHighlighted.textId !== par.textId
    ) {
      clearHighlight();
      if (par.textId && par.textId !== 'empty') {
        const slot = state.activeSlotMap.get(par.pageIndex);
        const el = slot?.doc?.getElementById(par.textId);
        if (el) {
          el.classList.add(state.activeClass);
          state.lastHighlighted = { pageIndex: par.pageIndex, textId: par.textId };
        }
      }
    }

    return par;
  }

  function stopSyncTimer() {
    clearTimeout(state.syncTimerId);
    state.syncTimerId = null;
  }

  function scheduleNextWordSync() {
    stopSyncTimer();
    if (!state.isPlaying) return;

    const now = getCurrentPlaybackTime();
    const par = highlightCurrentWord();
    updateTimeDisplay(now);

    let delayMs = 150;
    if (par) {
      const remainingMs = (par.endSec - now) * 1000;
      delayMs = Math.max(30, Math.min(remainingMs + 8, 500));
    }

    state.syncTimerId = setTimeout(scheduleNextWordSync, delayMs);
  }

  async function findNextAudioPage(afterIndex) {
    for (let i = afterIndex + 1; i < state.pages.length; i++) {
      const p = state.pages[i];
      if (!p || !p.smilUrl) continue;
      await ensurePageSmil(i);
      if (p.hasAudio) return i;
    }
    return null;
  }

  async function advanceToNextAudioPage() {
    if (!state.isPlaying || state.audioPageIndex === null) return;
    const nextIdx = await findNextAudioPage(state.audioPageIndex);
    if (nextIdx !== null && state.isPlaying) {
      if (state.useChunks) {
        state.pausedOffset = 0;
        playPageAudio(nextIdx, 0, false);
      } else {
        // Single-file continuous stream: just switch active page & turn spread without seeking!
        state.audioPageIndex = nextIdx;
        const currentPages = state.spreads[state.spreadIndex] || [];
        if (!currentPages.includes(nextIdx)) {
          renderSpread(findSpreadForPage(nextIdx), { syncAudio: false });
        }
        scheduleNextWordSync();
      }
    } else {
      pauseAudio();
    }
  }

  async function playPageAudio(pageIndex, startTimeSec = null, fromPageStart = false) {
    const page = state.pages[pageIndex];
    if (!page) return;

    const token = ++state.playToken;
    stopSyncTimer();

    await ensurePageSmil(pageIndex);
    if (token !== state.playToken) return;

    if (!page.hasAudio) {
      const nextIdx = await findNextAudioPage(pageIndex);
      if (token !== state.playToken) return;
      if (nextIdx !== null) playPageAudio(nextIdx, null, true);
      return;
    }

    state.audioPageIndex = pageIndex;

    const currentPages = state.spreads[state.spreadIndex] || [];
    if (!currentPages.includes(pageIndex)) {
      renderSpread(findSpreadForPage(pageIndex), { syncAudio: false });
    }

    if (state.useChunks) {
      stopActiveSource(0.01);
      const ctx = getAudioContext();
      const buffer = await ensurePageAudioBuffer(page);
      if (token !== state.playToken || !buffer) return;

      const offset = fromPageStart
        ? 0
        : startTimeSec !== null
          ? Math.max(0, Math.min(startTimeSec, buffer.duration))
          : Math.max(0, Math.min(state.pausedOffset, buffer.duration));

      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      if (token !== state.playToken) return;

      const src = ctx.createBufferSource();
      src.buffer = buffer;

      const gain = ctx.createGain();
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(1, now + 0.012);

      src.connect(gain);
      gain.connect(ctx.destination);

      state.activeSource = src;
      state.activeGain = gain;
      state.startCtxTime = now;
      state.startOffset = offset;
      state.pausedOffset = offset;
      state.isPlaying = true;

      src.onended = () => {
        if (state.activeSource !== src) return;
        state.activeSource = null;
        state.activeGain = null;
        stopSyncTimer();
        clearHighlight();
        advanceToNextAudioPage();
      };

      src.start(0, offset);
      updatePlayButton();
      scheduleNextWordSync();
      prefetchAdjacentSpreads();
      resetHudTimer();
      return;
    }

    // Fallback: Direct static streaming via <audio> (HTTP 206 Range)
    if (!page.audioSrcUrl) return;
    const targetHref = new URL(page.audioSrcUrl, window.location.href).href;
    if (htmlAudio.src !== targetHref) {
      htmlAudio.src = page.audioSrcUrl;
    }

    if (fromPageStart) {
      htmlAudio.currentTime = page.clipStart;
    } else if (startTimeSec !== null) {
      htmlAudio.currentTime = startTimeSec;
    } else if (htmlAudio.currentTime < page.clipStart || htmlAudio.currentTime >= page.clipEnd) {
      htmlAudio.currentTime = page.clipStart;
    }

    try {
      await htmlAudio.play();
      if (token !== state.playToken) return;
      state.isPlaying = true;
      updatePlayButton();
      scheduleNextWordSync();
      prefetchAdjacentSpreads();
      resetHudTimer();
    } catch (err) {
      console.warn('Audio play blocked:', err);
    }
  }

  function pauseAudio() {
    state.playToken++;
    stopSyncTimer();
    if (state.useChunks) {
      state.pausedOffset = getCurrentPlaybackTime();
      stopActiveSource(0.012);
    } else {
      htmlAudio.pause();
    }
    state.isPlaying = false;
    updatePlayButton();
    resetHudTimer();
  }

  async function togglePlay() {
    if (!state.bookHasAudio) return;
    if (state.isPlaying) {
      pauseAudio();
      return;
    }

    const currentPages = state.spreads[state.spreadIndex] || [];
    await Promise.all(currentPages.map((idx) => ensurePageSmil(idx)));

    if (state.audioPageIndex !== null && currentPages.includes(state.audioPageIndex) && state.pages[state.audioPageIndex]?.hasAudio) {
      playPageAudio(state.audioPageIndex, null, false);
    } else {
      let targetIdx = currentPages.find((idx) => state.pages[idx]?.hasAudio);
      if (targetIdx === undefined) {
        targetIdx = await findNextAudioPage(currentPages[currentPages.length - 1] ?? -1);
      }
      if (targetIdx !== undefined && targetIdx !== null) {
        state.pausedOffset = 0;
        playPageAudio(targetIdx, null, true);
      }
    }
  }

  function updatePlayButton() {
    dom.iconPlay.classList.toggle('hidden', state.isPlaying);
    dom.iconPause.classList.toggle('hidden', !state.isPlaying);
  }

  // --- UI & Controls ---

  function updateHudState() {
    const totalPages = state.pages.length;
    const pageIndices = state.spreads[state.spreadIndex] || [0];
    const label =
      pageIndices.length === 2
        ? `${pageIndices[0] + 1}–${pageIndices[1] + 1} / ${totalPages}`
        : `${pageIndices[0] + 1} / ${totalPages}`;

    dom.pageLabel.textContent = label;
    dom.pageSlider.max = Math.max(0, state.spreads.length - 1);
    dom.pageSlider.value = String(state.spreadIndex);

    dom.btnPrev.disabled = state.spreadIndex <= 0;
    dom.btnNext.disabled = state.spreadIndex >= state.spreads.length - 1;

    dom.btnModeSingle.classList.toggle('active', state.mode === 'single');
    dom.btnModeSpread.classList.toggle('active', state.mode === 'spread');

    dom.btnCoverToggle.classList.toggle('active', state.separateCover);
    dom.btnCoverToggle.setAttribute('aria-pressed', String(state.separateCover));
    dom.btnCoverToggle.classList.toggle('is-hidden', state.mode !== 'spread');
  }

  function setMode(newMode) {
    if (state.mode === newMode) return;
    const anchorPage = state.spreads[state.spreadIndex]?.[0] ?? 0;
    state.mode = newMode;
    computeSpreads();
    const nextSpread = findSpreadForPage(anchorPage);
    renderSpread(nextSpread, { syncAudio: false });
  }

  function toggleSeparateCover() {
    const anchorPage = state.spreads[state.spreadIndex]?.[0] ?? 0;
    state.separateCover = !state.separateCover;
    computeSpreads();
    const nextSpread = findSpreadForPage(anchorPage);
    renderSpread(nextSpread, { syncAudio: false });
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  function updateFullscreenIcon() {
    const isFs = Boolean(document.fullscreenElement);
    dom.iconFsEnter.classList.toggle('hidden', isFs);
    dom.iconFsExit.classList.toggle('hidden', !isFs);
    fitSpreadToStage();
  }

  function resetHudTimer() {
    document.body.classList.remove('hud-hidden');
    clearTimeout(state.hudTimer);
    if (state.hudHovered) return;
    if (state.isPlaying || document.fullscreenElement) {
      state.hudTimer = setTimeout(() => {
        document.body.classList.add('hud-hidden');
      }, 2800);
    }
  }

  function handleKeyDown(e) {
    if (e.target?.tagName === 'INPUT') return;
    switch (e.key) {
      case 'ArrowRight':
      case 'PageDown':
        e.preventDefault();
        renderSpread(state.spreadIndex + 1, { syncAudio: true });
        break;
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault();
        renderSpread(state.spreadIndex - 1, { syncAudio: true });
        break;
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        toggleFullscreen();
        break;
      case '1':
        setMode('single');
        break;
      case '2':
        setMode('spread');
        break;
      case 'c':
      case 'C':
        if (state.mode === 'spread') toggleSeparateCover();
        break;
    }
    resetHudTimer();
  }

  function bindEvents() {
    dom.btnPrev.addEventListener('click', () => {
      renderSpread(state.spreadIndex - 1, { syncAudio: true });
      resetHudTimer();
    });

    dom.btnNext.addEventListener('click', () => {
      renderSpread(state.spreadIndex + 1, { syncAudio: true });
      resetHudTimer();
    });

    dom.pageSlider.addEventListener('input', (e) => {
      const idx = parseInt(e.target.value, 10);
      renderSpread(idx, { syncAudio: false });
      resetHudTimer();
    });

    dom.pageSlider.addEventListener('change', (e) => {
      const idx = parseInt(e.target.value, 10);
      renderSpread(idx, { syncAudio: true });
      resetHudTimer();
    });

    dom.btnPlay.addEventListener('click', togglePlay);
    dom.btnModeSingle.addEventListener('click', () => setMode('single'));
    dom.btnModeSpread.addEventListener('click', () => setMode('spread'));
    dom.btnCoverToggle.addEventListener('click', toggleSeparateCover);
    dom.btnFullscreen.addEventListener('click', toggleFullscreen);

    htmlAudio.addEventListener('ended', () => {
      stopSyncTimer();
      clearHighlight();
      state.isPlaying = false;
      updatePlayButton();
      resetHudTimer();
    });

    document.addEventListener('fullscreenchange', updateFullscreenIcon);
    window.addEventListener('resize', fitSpreadToStage);

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(fitSpreadToStage).observe(dom.stage);
    }

    window.addEventListener('mousemove', resetHudTimer, { passive: true });
    window.addEventListener('touchstart', resetHudTimer, { passive: true });
    dom.hud.addEventListener('mouseenter', () => {
      state.hudHovered = true;
      clearTimeout(state.hudTimer);
      document.body.classList.remove('hud-hidden');
    });
    dom.hud.addEventListener('mouseleave', () => {
      state.hudHovered = false;
      resetHudTimer();
    });

    window.addEventListener('keydown', handleKeyDown);
  }

  // --- Init ---

  async function init() {
    const prefs = loadPrefs();
    state.mode = prefs.mode;
    state.separateCover = prefs.separateCover;

    bindEvents();

    try {
      await resolveBookBase();
      await loadEpubManifest();
      computeSpreads();
      const startSpread = findSpreadForPage(prefs.lastPage);
      renderSpread(startSpread, { syncAudio: false });
    } catch (err) {
      console.error(err);
      dom.loadingOverlay.innerHTML = `<span>Gagal memuat EPUB: ${err.message}</span>`;
      return;
    }

    dom.loadingOverlay.classList.add('done');
    setTimeout(() => dom.loadingOverlay.remove(), 300);
  }

  init();
})();
