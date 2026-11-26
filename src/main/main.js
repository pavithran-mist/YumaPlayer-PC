const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Readable } = require('stream');

const { JsonStore } = require('./store');
const { isSupportedAudioFile, getMimeType, scanLocalFolders, parseAudioFile } = require('./library');
const { searchMusic, getHomeDiscovery, resolveAudioStream } = require('./youtubeService');
const { fetchLyrics } = require('./lyricsService');
const { fetchSponsorSegments } = require('./sponsorBlock');
const { UpdateManager } = require('./updater');

let mainWindow = null;
let streamServer = null;
let streamPort = 0;
let store = null;
let updateManager = null;

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
            res.end('Audio file not found');
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

        if (reqUrl.pathname === '/stream') {
          const videoId = reqUrl.searchParams.get('id');
          if (!videoId) {
            res.writeHead(400);
            res.end('Missing video id');
            return;
          }

          const info = await resolveAudioStream(videoId);
          const upstreamHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          };
          if (req.headers.range) {
            upstreamHeaders.Range = req.headers.range;
          }

          const upstream = await fetch(info.url, { headers: upstreamHeaders });
          const outHeaders = {
            'Content-Type': upstream.headers.get('content-type') || info.mimeType,
            'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes'
          };
          const contentLength = upstream.headers.get('content-length');
          const contentRange = upstream.headers.get('content-range');
          if (contentLength) outHeaders['Content-Length'] = contentLength;
          if (contentRange) outHeaders['Content-Range'] = contentRange;

          res.writeHead(upstream.status, outHeaders);
          if (upstream.body) {
            const nodeStream = Readable.fromWeb(upstream.body);
            nodeStream.on('error', () => {
              if (!res.writableEnded) res.end();
            });
            req.on('close', () => nodeStream.destroy());
            nodeStream.pipe(res);
          } else {
            res.end();
          }
          return;
        }

        res.writeHead(404);
        res.end('Not found');
      } catch (err) {
        console.error('Stream proxy error:', err.message);
        if (!res.headersSent) {
          res.writeHead(500);
        }
        if (!res.writableEnded) {
          res.end('Stream error');
        }
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
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 680,
    frame: false,
    backgroundColor: '#090b12',
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

  // Local Library
  ipcMain.handle('library:pickFolder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Music Folder (FLAC, MP3, WAV, M4A, OGG)',
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
      title: 'Open Audio Files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Audio Files',
          extensions: ['flac', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'alac']
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

  // Streaming, Lyrics & SponsorBlock
  ipcMain.handle('yt:search', (_e, query) => searchMusic(query));
  ipcMain.handle('yt:home', () => getHomeDiscovery());
  ipcMain.handle('lyrics:get', (_e, track) => fetchLyrics(track));
  ipcMain.handle('sponsor:get', (_e, videoId) => fetchSponsorSegments(videoId));

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
  await createStreamServer();
  registerIpc();
  createWindow();

  setTimeout(() => {
    updateManager?.checkForUpdates();
  }, 4000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (streamServer) streamServer.close();
  if (process.platform !== 'darwin') app.quit();
});
