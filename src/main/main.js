const { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const { JsonStore } = require('./store');
const { isSupportedAudioFile, getMimeType, scanLocalFolders, parseAudioFile } = require('./library');
const { searchMusic, getHomeDiscovery } = require('./youtubeService');
const { fetchLyrics } = require('./lyricsService');
const { fetchSponsorSegments } = require('./sponsorBlock');
const { UpdateManager } = require('./updater');
const { YtmPlayer } = require('./ytmPlayer');

let mainWindow = null;
let streamServer = null;
let streamPort = 0;
let store = null;
let updateManager = null;
let ytmPlayer = null;

function createStreamServer() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, 'http://127.0.0.1');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        if (reqUrl.pathname === '/local') {
          const filePath = reqUrl.searchParams.get('path');
          if (!filePath || !fs.existsSync(filePath) || !isSupportedAudioFile(filePath)) {
            res.writeHead(404);
            res.end('Media file not found');
            return;
          }

          const stat = fs.statSync(filePath);
          const total = stat.size;
          const mimeType = getMimeType(filePath);
          const range = req.headers.range;

          if (range) {
            const match = /bytes=(\d*)-(\d*)/.exec(range);
            const start = match && match[1] ? parseInt(match[1], 10) : 0;
            const end = match && match[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;
            if (start >= total || start > end) {
              res.writeHead(416, { 'Content-Range': `bytes */${total}` });
              res.end();
              return;
            }
            res.writeHead(206, {
              'Content-Range': `bytes ${start}-${end}/${total}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': end - start + 1,
              'Content-Type': mimeType
            });
            fs.createReadStream(filePath, { start, end }).pipe(res);
          } else {
            res.writeHead(200, {
              'Content-Length': total,
              'Accept-Ranges': 'bytes',
              'Content-Type': mimeType
            });
            fs.createReadStream(filePath).pipe(res);
          }
          return;
        }

        res.writeHead(404);
        res.end('Not found');
      } catch (err) {
        console.error('Stream server error:', err.message);
        if (!res.headersSent) res.writeHead(500);
        if (!res.writableEnded) res.end('Stream error');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      streamPort = server.address().port;
      streamServer = server;
      resolve(streamPort);
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1060,
    minHeight: 700,
    frame: false,
    backgroundColor: '#090b12',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    title: 'YumaPlayer PC',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', true);
  });
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', false);
  });
  mainWindow.on('closed', () => {
    ytmPlayer?.destroy();
    mainWindow = null;
  });
}

function registerMediaKeys() {
  try {
    globalShortcut.register('MediaPlayPause', () => {
      mainWindow?.webContents.send('media:command', 'toggle');
    });
    globalShortcut.register('MediaNextTrack', () => {
      mainWindow?.webContents.send('media:command', 'next');
    });
    globalShortcut.register('MediaPreviousTrack', () => {
      mainWindow?.webContents.send('media:command', 'prev');
    });
  } catch {
    // ignore if another app holds media keys
  }
}

function registerIpc() {
  ipcMain.handle('app:getConfig', () => ({
    streamPort,
    version: app.getVersion(),
    dataPath: store.filePath
  }));

  // Window controls
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
      return false;
    }
    mainWindow.maximize();
    return true;
  });
  ipcMain.handle('window:close', () => mainWindow?.close());

  // Store
  ipcMain.handle('store:getState', () => store.getState());
  ipcMain.handle('store:toggleLike', (_e, track) => store.toggleLike(track));
  ipcMain.handle('store:addHistory', (_e, track) => store.addHistory(track));
  ipcMain.handle('store:createPlaylist', (_e, name) => store.createPlaylist(name));
  ipcMain.handle('store:deletePlaylist', (_e, id) => store.deletePlaylist(id));
  ipcMain.handle('store:addToPlaylist', (_e, { playlistId, track }) =>
    store.addTrackToPlaylist(playlistId, track)
  );
  ipcMain.handle('store:removeFromPlaylist', (_e, { playlistId, trackId }) =>
    store.removeTrackFromPlaylist(playlistId, trackId)
  );
  ipcMain.handle('store:updateSettings', (_e, partial) => store.updateSettings(partial));

  // Local Library (Audio & Video Songs)
  ipcMain.handle('library:pickFolder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Music or Video Folder',
      properties: ['openDirectory']
    });
    if (res.canceled || res.filePaths.length === 0) {
      return { canceled: true };
    }
    const folders = store.addLocalFolder(res.filePaths[0]);
    const tracks = await scanLocalFolders(folders);
    return { canceled: false, folders, tracks };
  });

  ipcMain.handle('library:pickFiles', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Audio or Video Files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Audio & Video Files',
          extensions: ['flac', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'alac', 'mp4', 'mkv', 'mov', 'webm']
        }
      ]
    });
    if (res.canceled || res.filePaths.length === 0) {
      return { canceled: true, tracks: [] };
    }
    const tracks = await Promise.all(res.filePaths.map((f) => parseAudioFile(f)));
    return { canceled: false, tracks };
  });

  ipcMain.handle('library:parsePaths', async (_e, filePaths) => {
    const valid = (Array.isArray(filePaths) ? filePaths : []).filter(
      (p) => fs.existsSync(p) && isSupportedAudioFile(p)
    );
    return Promise.all(valid.map((f) => parseAudioFile(f)));
  });

  ipcMain.handle('library:scan', async () => {
    const folders = store.getState().localFolders;
    const tracks = await scanLocalFolders(folders);
    return { folders, tracks };
  });

  ipcMain.handle('library:removeFolder', async (_e, folderPath) => {
    const folders = store.removeLocalFolder(folderPath);
    const tracks = await scanLocalFolders(folders);
    return { folders, tracks };
  });

  // Streaming, Search, Lyrics & SponsorBlock
  ipcMain.handle('yt:search', (_e, payload) => {
    if (typeof payload === 'string') return searchMusic(payload, 'all');
    return searchMusic(payload?.query, payload?.mode || 'all');
  });
  ipcMain.handle('yt:home', () => getHomeDiscovery());
  ipcMain.handle('lyrics:get', (_e, track) => fetchLyrics(track));
  ipcMain.handle('sponsor:get', (_e, videoId) => fetchSponsorSegments(videoId));

  // Embedded YouTube Music & Video Player (WebContentsView)
  ipcMain.handle('ytm:play', (_e, payload) => {
    if (typeof payload === 'string') return ytmPlayer.play(payload);
    return ytmPlayer.play(payload?.videoId, { preferVideo: Boolean(payload?.preferVideo) });
  });
  ipcMain.handle('ytm:pause', () => ytmPlayer.pause());
  ipcMain.handle('ytm:resume', () => ytmPlayer.resume());
  ipcMain.handle('ytm:stop', () => ytmPlayer.stop());
  ipcMain.handle('ytm:seek', (_e, seconds) => ytmPlayer.seek(seconds));
  ipcMain.handle('ytm:volume', (_e, volume) => ytmPlayer.setVolume(volume));
  ipcMain.handle('ytm:rate', (_e, rate) => ytmPlayer.setPlaybackRate(rate));
  ipcMain.handle('ytm:setStage', (_e, { visible, bounds }) => ytmPlayer.setVideoStage(visible, bounds));

  // Updates & External Links
  ipcMain.handle('updater:check', () => updateManager.checkForUpdates());
  ipcMain.handle('updater:download', () => updateManager.downloadUpdate());
  ipcMain.handle('updater:install', () => updateManager.quitAndInstall());
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      return shell.openExternal(url);
    }
    return false;
  });
}

app.whenReady().then(async () => {
  const storePath = path.join(app.getPath('userData'), 'yumaplayer-data.json');
  store = new JsonStore(storePath);
  updateManager = new UpdateManager(() => mainWindow);
  updateManager.init();
  ytmPlayer = new YtmPlayer(
    () => mainWindow,
    (ytState) => {
      mainWindow?.webContents.send('ytm:state', ytState);
    }
  );
  await createStreamServer();
  registerIpc();
  createWindow();
  registerMediaKeys();

  setTimeout(() => {
    updateManager?.checkForUpdates();
  }, 3500);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  ytmPlayer?.destroy();
  if (streamServer) streamServer.close();
  if (process.platform !== 'darwin') app.quit();
});
