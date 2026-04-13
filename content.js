'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const HIGHLIGHT_CLASS = 'ytm-ps-highlight';
const HIGHLIGHT_DURATION_MS = 3500;
const MAX_RESULTS_SHOWN = 60;
const DEBOUNCE_MS = 200;

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  songs: [],
  playlistId: null,
  loading: false,
  clickAction: 'scroll',
  panelOpen: false,
};

// ─── Boot ─────────────────────────────────────────────────────────────────────
function boot() {
  chrome.storage.sync.get(['clickAction'], ({ clickAction }) => {
    state.clickAction = clickAction || 'scroll';
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'updateSetting') state.clickAction = msg.value;
  });

  let lastUrl = '';
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onNavigate();
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  onNavigate();
}

function onNavigate() {
  const pid = new URLSearchParams(location.search).get('list');

  if (!pid) {
    const btn = document.getElementById('ytm-ps-toggle');
    if (btn) btn.style.display = 'none';
    return;
  }

  ensureToggleButton();

  if (pid !== state.playlistId) {
    state.playlistId = pid;
    state.songs = [];
    resetPanel();
    // MODIFICARE: Încărcăm melodiile imediat ce am intrat pe playlist, în fundal
    loadAllSongs(pid);
  }
}

// ─── InnerTube API ────────────────────────────────────────────────────────────
function getYTConfig() {
  try {
    const d = window.ytcfg?.data_ ?? {};
    return {
      apiKey: d.INNERTUBE_API_KEY ?? '',
      clientVersion: d.INNERTUBE_CLIENT_VERSION ?? '1.20240101.01.00',
      hl: d.HL ?? 'en',
      gl: d.GL ?? 'US',
      visitorData: d.VISITOR_DATA ?? '',
    };
  } catch {
    return { apiKey: '', clientVersion: '1.20240101.01.00', hl: 'en', gl: 'US', visitorData: '' };
  }
}

async function innerTubeFetch(body) {
  const cfg = getYTConfig();
  const qs = cfg.apiKey ? `?key=${cfg.apiKey}` : '';
  const url = `https://music.youtube.com/youtubei/v1/browse${qs}`;

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.visitorData) headers['X-Goog-Visitor-Id'] = cfg.visitorData;

  const resp = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'WEB_REMIX',
          clientVersion: cfg.clientVersion,
          hl: cfg.hl,
          gl: cfg.gl,
        }
      },
      ...body,
    }),
  });

  if (!resp.ok) throw new Error(`InnerTube HTTP ${resp.status}`);
  return resp.json();
}

function extractSongs(contents, startIndex) {
  const songs = [];
  for (const item of (contents ?? [])) {
    const r = item.musicResponsiveListItemRenderer;
    if (!r) continue;

    const videoId =
      r.playlistItemData?.videoId ??
      r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
    if (!videoId) continue;

    const titleRuns = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [];
    const title = titleRuns.map(x => x.text).join('').trim() || 'Unknown Title';

    const col1Runs = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [];
    const namedRuns = col1Runs.filter(x => x.navigationEndpoint);
    const artist = namedRuns.length
      ? namedRuns.map(x => x.text).join(', ')
      : col1Runs.map(x => x.text).join('').split('•')[0].trim();

    const duration = r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text ?? '';
    const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ?? [];
    const thumbnail = thumbs[0]?.url ?? '';

    songs.push({ index: startIndex + songs.length, videoId, title, artist, duration, thumbnail });
  }
  return songs;
}

function getContinuation(obj) {
  if (obj?.continuations?.[0]?.nextContinuationData?.continuation) {
    return obj.continuations[0].nextContinuationData.continuation;
  }

  const contents = Array.isArray(obj) ? obj : (obj?.contents || []);
  if (contents.length > 0) {
    const lastItem = contents[contents.length - 1];
    if (lastItem?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
      return lastItem.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
    }
  }

  return null;
}

async function loadAllSongs(playlistId) {
  if (state.loading) return;
  state.loading = true;
  setStatus('Connecting…');

  try {
    const firstData = await innerTubeFetch({ browseId: `VL${playlistId}` });
    const contents = firstData.contents;

    const sectionContents =
      contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer?.contents ??
      contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ??
      [];

    let all = [];
    let cont = null;

    for (const section of sectionContents) {
      const shelf = section.musicShelfRenderer ?? section.musicPlaylistShelfRenderer;
      if (!shelf?.contents) continue;

      all = all.concat(extractSongs(shelf.contents, all.length));
      cont = cont ?? getContinuation(shelf);
    }

    // Actualizăm statusul discret în fundal
    setStatus(`Loading… ${all.length}`);

    while (cont) {
      const data = await innerTubeFetch({ continuation: cont });
      let newItems = [];
      const shelf = data.continuationContents?.musicShelfContinuation ?? data.continuationContents?.musicPlaylistShelfContinuation;

      if (shelf?.contents) {
        newItems = shelf.contents;
        cont = getContinuation(shelf);
      } else {
        const actions = data.onResponseReceivedActions ?? [];
        const appendAction = actions.find(a => a.appendContinuationItemsAction)?.appendContinuationItemsAction;
        if (appendAction?.continuationItems) {
          newItems = appendAction.continuationItems;
          cont = getContinuation(newItems);
        } else break;
      }

      if (newItems.length > 0) {
        all = all.concat(extractSongs(newItems, all.length));
        setStatus(`Loading… ${all.length}`);
        await sleep(150);
      } else break;
    }

    state.songs = all;
    setStatus(`${all.length} songs ready`);
  } catch (err) {
    console.error('[YTM-PS]', err);
    setStatus('❌ Error loading songs.');
  } finally {
    state.loading = false;
  }
}

function findScrollContainer() {
  const shelf = document.querySelector('ytmusic-playlist-shelf-renderer') ?? document.querySelector('ytmusic-shelf-renderer');
  if (shelf) {
    let el = shelf.parentElement;
    while (el && el !== document.documentElement) {
      const { overflowY } = getComputedStyle(el);
      if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
  }
  const layout = document.querySelector('ytmusic-app-layout');
  if (layout && (getComputedStyle(layout).overflowY === 'auto' || getComputedStyle(layout).overflowY === 'scroll')) return layout;
  return document.documentElement;
}

function playSong(song) {
  location.href = `https://music.youtube.com/watch?v=${song.videoId}&list=${state.playlistId}`;
}

async function scrollToSong(song) {
  const scroller = findScrollContainer();
  const useWindow = scroller === document.documentElement;
  const playlistShelf = document.querySelector('ytmusic-playlist-shelf-renderer') ?? document.querySelector('ytmusic-shelf-renderer');
  if (!playlistShelf) return;

  setStatus(`🚀 Navigating to #${song.index + 1}...`);
  if (useWindow) window.scrollTo({ top: song.index * 56, behavior: 'auto' });
  else scroller.scrollTo({ top: song.index * 56, behavior: 'auto' });

  let target = null;
  let attempts = 0;
  const MAX_ATTEMPTS = 60;
  let lastScrollTop = -1;

  while (!target && attempts < MAX_ATTEMPTS) {
    attempts++;
    await sleep(250);
    target = findRenderedItem(song);
    if (target) break;

    const els = Array.from(playlistShelf.querySelectorAll('ytmusic-responsive-list-item-renderer'));
    if (els.length === 0) {
        if (useWindow) window.scrollBy(0, -1000); else scroller.scrollBy(0, -1000);
        continue;
    }

    let firstSong = null; let lastSong = null;
    for (let i = 0; i < els.length; i++) { firstSong = getSongFromElement(els[i]); if (firstSong) break; }
    for (let i = els.length - 1; i >= 0; i--) { lastSong = getSongFromElement(els[i]); if (lastSong) break; }

    const spinner = playlistShelf.querySelector('ytmusic-continuation-item-renderer');
    if (lastSong && song.index > lastSong.index) {
        if (spinner) {
            spinner.scrollIntoView({ behavior: 'auto', block: 'end' });
            if (useWindow) window.scrollBy(0, 80); else scroller.scrollBy(0, 80);
        } else {
            let leap = Math.min((song.index - lastSong.index) * 56, 4000);
            if (useWindow) window.scrollBy(0, leap); else scroller.scrollBy(0, leap);
        }
    } else if (firstSong && song.index < firstSong.index) {
        let leap = Math.min((firstSong.index - song.index) * 56, 4000);
        if (useWindow) window.scrollBy(0, -leap); else scroller.scrollBy(0, -leap);
    } else {
        if (useWindow) window.scrollBy(0, 200); else scroller.scrollBy(0, 200);
    }
    lastScrollTop = useWindow ? window.scrollY : scroller.scrollTop;
  }

  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    pulseHighlight(target);
    setStatus(`${state.songs.length} songs ready`);
  }
}

function getSongFromElement(el) {
   const links = el.querySelectorAll('a[href]');
   for (const link of links) {
      const vidMatch = link.href.match(/[?&]v=([^&]+)/);
      if (vidMatch && vidMatch[1]) {
         const found = state.songs.find(s => s.videoId === vidMatch[1]);
         if (found) return found;
      }
   }
   return null;
}

function findRenderedItem(song) {
  const shelf = document.querySelector('ytmusic-playlist-shelf-renderer') ?? document.querySelector('ytmusic-shelf-renderer');
  if (!shelf) return null;
  const els = shelf.querySelectorAll('ytmusic-responsive-list-item-renderer');
  for (const el of els) {
    const links = el.querySelectorAll('a[href]');
    for (const link of links) if (link.href.includes(song.videoId)) return el;
  }
  return null;
}

function pulseHighlight(el) {
  document.querySelectorAll('.' + HIGHLIGHT_CLASS).forEach(e => e.classList.remove(HIGHLIGHT_CLASS));
  el.classList.add(HIGHLIGHT_CLASS);
  setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_DURATION_MS);
}

function ensureToggleButton() {
  if (document.getElementById('ytm-ps-toggle')) {
    document.getElementById('ytm-ps-toggle').style.display = '';
    return;
  }

  const btn = document.createElement('button');
  btn.id = 'ytm-ps-toggle';
  btn.title = 'Search in playlist (YTM Playlist Search)';
  
  // Înlocuim SVG-ul vechi cu imaginea ta icon48.png
  const imgUrl = chrome.runtime.getURL("icon128.png");
  btn.innerHTML = `<img src="${imgUrl}" alt="Search" style="width:100%; height:100%; border-radius:50%;">`;
  
  btn.addEventListener('click', togglePanel);
  document.body.appendChild(btn);
}

function buildPanel() {
  const panel = document.createElement('div');
  panel.id = 'ytm-ps-panel';
  panel.innerHTML = `
    <div id="ytm-ps-header"><span id="ytm-ps-title">Playlist Search</span><button id="ytm-ps-close">✕</button></div>
    <div id="ytm-ps-input-wrap"><input id="ytm-ps-input" type="text" placeholder="Search song or artist..." autocomplete="off" /></div>
    <div id="ytm-ps-status"></div>
    <div id="ytm-ps-results"></div>
  `;
  document.body.appendChild(panel);
  panel.querySelector('#ytm-ps-close').addEventListener('click', () => { state.panelOpen = false; panel.classList.remove('ytm-ps-open'); });
  let debouncer;
  panel.querySelector('#ytm-ps-input').addEventListener('input', e => {
    clearTimeout(debouncer);
    debouncer = setTimeout(() => renderResults(e.target.value), DEBOUNCE_MS);
  });
  return panel;
}

function togglePanel() {
  const panel = document.getElementById('ytm-ps-panel') ?? buildPanel();
  state.panelOpen = !state.panelOpen;
  if (state.panelOpen) {
    panel.classList.add('ytm-ps-open');
    panel.querySelector('#ytm-ps-input')?.focus();
    renderResults(panel.querySelector('#ytm-ps-input').value);
  } else panel.classList.remove('ytm-ps-open');
}

function resetPanel() {
  const panel = document.getElementById('ytm-ps-panel');
  if (!panel) return;
  panel.querySelector('#ytm-ps-input').value = '';
  panel.querySelector('#ytm-ps-results').innerHTML = '';
}

function setStatus(msg) {
  const el = document.getElementById('ytm-ps-status');
  if (el) el.textContent = msg;
}

function renderResults(query) {
  const container = document.getElementById('ytm-ps-results');
  if (!container) return;
  const q = query.trim().toLowerCase();
  if (!q) { container.innerHTML = ''; return; }
  const matches = state.songs.filter(s => s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q));
  if (!matches.length) { container.innerHTML = '<div class="ytm-ps-notice">No matches.</div>'; return; }
  const shown = matches.slice(0, MAX_RESULTS_SHOWN);
  container.innerHTML = shown.map(s => `
    <div class="ytm-ps-item" data-idx="${s.index}">
      <img class="ytm-ps-thumb" src="${esc(s.thumbnail)}" />
      <div class="ytm-ps-info"><div class="ytm-ps-song-title">${esc(s.title)}</div><div class="ytm-ps-song-artist">${esc(s.artist)}</div></div>
      <div class="ytm-ps-meta"><span class="ytm-ps-dur">${esc(s.duration)}</span><span class="ytm-ps-num">#${s.index + 1}</span></div>
    </div>
  `).join('');
  container.querySelectorAll('.ytm-ps-item').forEach(el => {
    el.addEventListener('click', () => {
      const song = state.songs[parseInt(el.dataset.idx, 10)];
      if (state.clickAction === 'play') playSong(song); else scrollToSong(song);
    });
  });
}

function esc(str) { return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
boot();