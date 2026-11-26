const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('yumaAPI', {
  getConfig: () => ipcRenderer.invoke('app:getConfig'),
  getPathForFile: (file) => webUtils.getPathForFile(file),

  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    setFullscreen: (flag) => ipcRenderer.invoke('window:setFullscreen', flag),
    onMaximizedChanged: (cb) => ipcRenderer.on('window:maximized-changed', (_e, val) => cb(val))
  },

  store: {
    getState: () => ipcRenderer.invoke('store:getState'),
    toggleLike: (track) => ipcRenderer.invoke('store:toggleLike', track),
    addHistory: (track) => ipcRenderer.invoke('store:addHistory', track),
    createPlaylist: (name) => ipcRenderer.invoke('store:createPlaylist', name),
    deletePlaylist: (id) => ipcRenderer.invoke('store:deletePlaylist', id),
    addToPlaylist: (playlistId, track) => ipcRenderer.invoke('store:addToPlaylist', { playlistId, track }),
    removeFromPlaylist: (playlistId, trackId) =>
      ipcRenderer.invoke('store:removeFromPlaylist', { playlistId, trackId }),
    updateSettings: (partial) => ipcRenderer.invoke('store:updateSettings', partial)
  },

  library: {
    pickFolder: () => ipcRenderer.invoke('library:pickFolder'),
    pickFiles: () => ipcRenderer.invoke('library:pickFiles'),
    parsePaths: (filePaths) => ipcRenderer.invoke('library:parsePaths', filePaths),
    scan: () => ipcRenderer.invoke('library:scan'),
    removeFolder: (folderPath) => ipcRenderer.invoke('library:removeFolder', folderPath)
  },

  music: {
    search: (query, mode = 'all') => ipcRenderer.invoke('yt:search', { query, mode }),
    getHome: () => ipcRenderer.invoke('yt:home'),
    getLyrics: (track) => ipcRenderer.invoke('lyrics:get', track),
    getSponsorSegments: (videoId) => ipcRenderer.invoke('sponsor:get', videoId)
  },

  ytmPlayer: {
    play: (videoId, preferVideo = false) => ipcRenderer.invoke('ytm:play', { videoId, preferVideo }),
    pause: () => ipcRenderer.invoke('ytm:pause'),
    resume: () => ipcRenderer.invoke('ytm:resume'),
    stop: () => ipcRenderer.invoke('ytm:stop'),
    seek: (seconds) => ipcRenderer.invoke('ytm:seek', seconds),
    setVolume: (volume) => ipcRenderer.invoke('ytm:volume', volume),
    setPlaybackRate: (rate) => ipcRenderer.invoke('ytm:rate', rate),
    setStage: (visible, bounds) => ipcRenderer.invoke('ytm:setStage', { visible, bounds }),
    onState: (cb) => ipcRenderer.on('ytm:state', (_e, st) => cb(st))
  },

  onMediaCommand: (cb) => ipcRenderer.on('media:command', (_e, cmd) => cb(cmd)),

  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
    onStatus: (cb) => ipcRenderer.on('updater:status', (_e, status) => cb(status))
  },

  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url)
});
