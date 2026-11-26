(function () {
  if (!window.YumaAndroid) return;

  const pending = new Map();
  let reqSeq = 0;

  function nextId() {
    reqSeq += 1;
    return `req_${reqSeq}_${Date.now()}`;
  }

  function callNativeAsync(fn) {
    return new Promise((resolve) => {
      const id = nextId();
      pending.set(id, resolve);
      fn(id);
    });
  }

  window.__yumaResolveCallback = function (reqId, jsonStr) {
    const resolve = pending.get(reqId);
    if (!resolve) return;
    pending.delete(reqId);
    try {
      resolve(JSON.parse(jsonStr));
    } catch {
      resolve(null);
    }
  };

  const DEFAULT_DATA = {
    likedTracks: [],
    playlists: [],
    history: [],
    localFolders: [],
    settings: {
      crossfadeSeconds: 4,
      bassSwap: true,
      sponsorBlockEnabled: true,
      eqPreset: 'Flat',
      eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      preampDb: 0,
      volume: 0.85,
      ambientBackdrop: true,
      endlessQueue: true
    }
  };

  function loadStoreData() {
    try {
      const raw = JSON.parse(window.YumaAndroid.storeGet() || '{}');
      return {
        ...structuredClone(DEFAULT_DATA),
        ...raw,
        settings: { ...DEFAULT_DATA.settings, ...(raw.settings || {}) }
      };
    } catch {
      return structuredClone(DEFAULT_DATA);
    }
  }

  let storeData = loadStoreData();
  function saveStore() {
    window.YumaAndroid.storeSet(JSON.stringify(storeData));
  }

  const ytmListeners = [];
  const mediaCmdListeners = [];
  const updaterListeners = [];
  let cachedLocalTracks = [];
  let lastUpdateInfo = null;

  window.__onYtmState = function (st) {
    ytmListeners.forEach((cb) => cb(st));
  };
  window.__onAndroidMediaCmd = function (cmd) {
    mediaCmdListeners.forEach((cb) => cb(cmd));
  };
  window.__onAndroidUpdateStatus = function (st) {
    updaterListeners.forEach((cb) => cb(st));
  };
  window.__onLocalLibraryScanned = function (jsonStr) {
    try {
      cachedLocalTracks = JSON.parse(jsonStr);
    } catch {
      cachedLocalTracks = [];
    }
  };

  window.yumaAPI = {
    getConfig: async () => JSON.parse(window.YumaAndroid.getConfig()),
    getPathForFile: () => null,

    windowControls: {
      minimize: async () => {},
      maximize: async () => false,
      close: async () => {},
      setFullscreen: async (flag) => {
        window.YumaAndroid.setFullscreen(Boolean(flag));
        return Boolean(flag);
      },
      onMaximizedChanged: () => {}
    },

    store: {
      getState: async () => storeData,
      toggleLike: async (track) => {
        const idx = storeData.likedTracks.findIndex((t) => t.id === track.id);
        let liked = false;
        if (idx >= 0) storeData.likedTracks.splice(idx, 1);
        else {
          storeData.likedTracks.unshift(track);
          liked = true;
        }
        saveStore();
        return { liked, likedTracks: storeData.likedTracks };
      },
      addHistory: async (track) => {
        storeData.history = [track, ...storeData.history.filter((t) => t.id !== track.id)].slice(0, 50);
        saveStore();
        window.YumaAndroid.updateMediaNotification(track.title || 'YumaPlayer', track.artist || 'by Pavithran', true);
        return storeData.history;
      },
      createPlaylist: async (name) => {
        const clean = String(name || '').trim();
        const pl = { id: `pl_${Date.now()}`, name: clean, tracks: [], createdAt: new Date().toISOString() };
        storeData.playlists.push(pl);
        saveStore();
        return pl;
      },
      deletePlaylist: async (id) => {
        storeData.playlists = storeData.playlists.filter((p) => p.id !== id);
        saveStore();
        return storeData.playlists;
      },
      addToPlaylist: async (playlistId, track) => {
        const pl = storeData.playlists.find((p) => p.id === playlistId);
        if (pl && !pl.tracks.some((t) => t.id === track.id)) {
          pl.tracks.push(track);
          saveStore();
        }
        return pl;
      },
      removeFromPlaylist: async (playlistId, trackId) => {
        const pl = storeData.playlists.find((p) => p.id === playlistId);
        if (pl) {
          pl.tracks = pl.tracks.filter((t) => t.id !== trackId);
          saveStore();
        }
        return pl;
      },
      updateSettings: async (partial) => {
        storeData.settings = { ...storeData.settings, ...partial };
        saveStore();
        return storeData.settings;
      }
    },

    library: {
      pickFolder: async () => {
        const tracks = await callNativeAsync((id) => window.YumaAndroid.scanLocalMedia(id));
        cachedLocalTracks = Array.isArray(tracks) ? tracks : [];
        return { canceled: false, folders: ['Device Media'], tracks: cachedLocalTracks };
      },
      pickFiles: async () => {
        const tracks = await callNativeAsync((id) => window.YumaAndroid.pickMediaFiles(id));
        const list = Array.isArray(tracks) ? tracks : [];
        return { canceled: list.length === 0, tracks: list };
      },
      parsePaths: async () => [],
      scan: async () => {
        const tracks = await callNativeAsync((id) => window.YumaAndroid.scanLocalMedia(id));
        cachedLocalTracks = Array.isArray(tracks) ? tracks : [];
        return { folders: ['Device Media'], tracks: cachedLocalTracks };
      },
      removeFolder: async () => ({ folders: ['Device Media'], tracks: cachedLocalTracks })
    },

    music: {
      search: (query, mode = 'all') =>
        callNativeAsync((id) => window.YumaAndroid.searchMusic(id, query, mode)),
      getHome: () => callNativeAsync((id) => window.YumaAndroid.getHomeDiscovery(id)),
      getUpNext: (videoId, fallbackQuery = '') =>
        callNativeAsync((id) => window.YumaAndroid.getUpNext(id, videoId || '', fallbackQuery || '')),
      getLyrics: (track) =>
        callNativeAsync((id) =>
          window.YumaAndroid.getLyrics(
            id,
            track.title || '',
            track.artist || '',
            track.album || '',
            Math.round(track.duration || 0)
          )
        ),
      getSponsorSegments: (videoId) =>
        callNativeAsync((id) => window.YumaAndroid.getSponsorSegments(id, videoId || ''))
    },

    ytmPlayer: {
      play: async (videoId, preferVideo = false) => window.YumaAndroid.ytmPlay(videoId, Boolean(preferVideo)),
      pause: async () => window.YumaAndroid.ytmPause(),
      resume: async () => window.YumaAndroid.ytmResume(),
      stop: async () => window.YumaAndroid.ytmStop(),
      seek: async (seconds) => window.YumaAndroid.ytmSeek(Number(seconds) || 0),
      setVolume: async (vol) => window.YumaAndroid.ytmSetVolume(Number(vol) || 0.85),
      setPlaybackRate: async (rate) => window.YumaAndroid.ytmSetRate(Number(rate) || 1.0),
      setStage: async (visible, bounds) =>
        window.YumaAndroid.setVideoStage(
          Boolean(visible),
          bounds?.x || 0,
          bounds?.y || 0,
          bounds?.width || 0,
          bounds?.height || 0
        ),
      onState: (cb) => ytmListeners.push(cb)
    },

    onMediaCommand: (cb) => mediaCmdListeners.push(cb),

    updater: {
      check: async () => {
        const res = await callNativeAsync((id) => window.YumaAndroid.checkUpdates(id));
        lastUpdateInfo = res;
        updaterListeners.forEach((cb) => cb(res));
        return res;
      },
      download: async () => {
        if (!lastUpdateInfo?.apkUrl) return { started: false };
        window.YumaAndroid.downloadAndInstallUpdate(lastUpdateInfo.apkUrl, lastUpdateInfo.apkName || 'YumaPlayer.apk');
        return { started: true };
      },
      install: async () => {},
      onStatus: (cb) => updaterListeners.push(cb)
    },

    openExternal: async () => false
  };

  window.__onAndroidBack = function () {
    const cinema = document.getElementById('cinemaOverlay');
    if (cinema && !cinema.classList.contains('hidden')) {
      document.getElementById('closeCinemaBtn')?.click();
      return;
    }
    const modal = document.querySelector('.modal:not(.hidden)');
    if (modal) {
      modal.classList.add('hidden');
      return;
    }
    const navBack = document.getElementById('navBackBtn');
    navBack?.click();
  };
})();
