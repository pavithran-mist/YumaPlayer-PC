const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const UPSTREAM_REPO = 'MuwMx/YumaPlayer';
const PC_REPO = 'pavithran-mist/YumaPlayer-PC';

function normalizeVersion(v) {
  return String(v || '').replace(/^v/i, '').trim();
}

function compareSemver(a, b) {
  const pa = normalizeVersion(a).split(/[-.]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const pb = normalizeVersion(b).split(/[-.]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

async function fetchLatestGithubRelease(repo) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6500);
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'YumaPlayer-PC/1.1.0',
        Accept: 'application/vnd.github+json'
      }
    });
    if (!res.ok) {
      const tagsRes = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=1`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'YumaPlayer-PC/1.1.0' }
      });
      if (!tagsRes.ok) return null;
      const tags = await tagsRes.json();
      if (!Array.isArray(tags) || tags.length === 0) return null;
      return {
        tag: tags[0].name,
        name: tags[0].name,
        url: `https://github.com/${repo}/releases`,
        publishedAt: null,
        notes: '',
        assets: []
      };
    }
    const data = await res.json();
    const assets = Array.isArray(data.assets)
      ? data.assets.map((a) => ({
          name: a.name,
          size: a.size,
          downloadUrl: a.browser_download_url
        }))
      : [];
    return {
      tag: data.tag_name,
      name: data.name || data.tag_name,
      url: data.html_url,
      publishedAt: data.published_at,
      notes: (data.body || '').slice(0, 800),
      assets
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

class UpdateManager {
  constructor(getWindow) {
    this.getWindow = getWindow;
    this.autoUpdater = null;
    this.downloadedInstallerPath = null;
    this.status = {
      state: 'idle',
      currentVersion: app.getVersion(),
      availableVersion: null,
      progress: 0,
      message: 'Ready',
      upstream: null,
      pcRelease: null
    };
  }

  init() {
    if (!app.isPackaged) {
      return;
    }
    try {
      const { autoUpdater } = require('electron-updater');
      this.autoUpdater = autoUpdater;
      this.autoUpdater.autoDownload = false;
      this.autoUpdater.autoInstallOnAppExit = true;

      this.autoUpdater.on('checking-for-update', () => {
        this._emit({ state: 'checking', message: 'Checking GitHub Releases...' });
      });

      this.autoUpdater.on('update-available', (info) => {
        this._emit({
          state: 'available',
          availableVersion: info.version,
          message: `Update v${info.version} is available! Ready for in-app download.`
        });
      });

      this.autoUpdater.on('update-not-available', () => {
        this._emit({
          state: 'up-to-date',
          message: `You are on the latest version (v${this.status.currentVersion})`
        });
      });

      this.autoUpdater.on('download-progress', (prog) => {
        const pct = Math.round(prog.percent || 0);
        this._emit({
          state: 'downloading',
          progress: pct,
          message: `Downloading update in-app: ${pct}%`
        });
      });

      this.autoUpdater.on('update-downloaded', (info) => {
        this._emit({
          state: 'downloaded',
          availableVersion: info.version,
          progress: 100,
          message: `v${info.version} ready! Click Restart & Install.`
        });
      });

      this.autoUpdater.on('error', (err) => {
        // Keep availableVersion if pcRelease has it so fallback in-app downloader still works
        this._emit({
          state: this.status.availableVersion ? 'available' : 'error',
          message: err?.message || 'Update check error'
        });
      });
    } catch (err) {
      console.warn('electron-updater unavailable:', err.message);
    }
  }

  _emit(patch) {
    this.status = { ...this.status, ...patch };
    this.getWindow()?.webContents.send('updater:status', this.status);
  }

  async checkForUpdates() {
    this._emit({ state: 'checking', message: 'Checking for updates...' });

    const [upstream, pcRelease] = await Promise.all([
      fetchLatestGithubRelease(UPSTREAM_REPO),
      fetchLatestGithubRelease(PC_REPO)
    ]);

    const hasNewer = Boolean(pcRelease && compareSemver(pcRelease.tag, this.status.currentVersion) > 0);

    if (this.autoUpdater && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR) {
      this._emit({
        upstream,
        pcRelease,
        ...(hasNewer ? { availableVersion: normalizeVersion(pcRelease.tag) } : {})
      });
      try {
        await this.autoUpdater.checkForUpdates();
        return this.status;
      } catch {
        // Fall through to direct GitHub asset check
      }
    }

    if (hasNewer) {
      this._emit({
        state: 'available',
        availableVersion: normalizeVersion(pcRelease.tag),
        upstream,
        pcRelease,
        message: `Update ${pcRelease.tag} available! Click Download Update to install in-app.`
      });
    } else {
      this._emit({
        state: 'up-to-date',
        upstream,
        pcRelease,
        message: `Up to date (v${this.status.currentVersion})`
      });
    }
    return this.status;
  }

  async downloadUpdate() {
    this.downloadedInstallerPath = null;

    // 1. Prefer native electron-updater OTA for NSIS installs
    if (this.autoUpdater && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR) {
      try {
        await this.autoUpdater.downloadUpdate();
        return { started: true, mode: 'ota' };
      } catch {
        // Fallback to direct in-app installer download below
      }
    }

    // 2. Direct in-app download (for Portable / dev / fallback) without opening browser
    const assets = this.status.pcRelease?.assets || [];
    const setupAsset =
      assets.find((a) => /setup.*\.exe$/i.test(a.name)) ||
      assets.find((a) => /\.exe$/i.test(a.name));

    if (!setupAsset) {
      this._emit({ state: 'error', message: 'No Windows .exe asset found in release.' });
      return { started: false };
    }

    const outPath = path.join(app.getPath('temp'), setupAsset.name);
    this._emit({ state: 'downloading', progress: 0, message: `Downloading ${setupAsset.name}: 0%` });

    const res = await fetch(setupAsset.downloadUrl, {
      headers: { 'User-Agent': 'YumaPlayer-PC/1.1.0' }
    });
    if (!res.ok || !res.body) {
      this._emit({ state: 'error', message: `Download failed (HTTP ${res.status})` });
      return { started: false };
    }

    const total = Number(res.headers.get('content-length')) || setupAsset.size || 0;
    let received = 0;
    const fileStream = fs.createWriteStream(outPath);
    const reader = res.body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fileStream.write(Buffer.from(value));
        received += value.byteLength;
        if (total > 0) {
          const pct = Math.min(99, Math.round((received / total) * 100));
          this._emit({
            state: 'downloading',
            progress: pct,
            message: `Downloading ${setupAsset.name}: ${pct}%`
          });
        }
      }
      await new Promise((resolve) => fileStream.end(resolve));
      this.downloadedInstallerPath = outPath;
      this._emit({
        state: 'downloaded',
        progress: 100,
        message: `${setupAsset.name} downloaded! Click Restart & Install.`
      });
      return { started: true, mode: 'installer' };
    } catch (err) {
      fileStream.destroy();
      this._emit({ state: 'error', message: `Download error: ${err.message}` });
      return { started: false };
    }
  }

  async quitAndInstall() {
    if (this.downloadedInstallerPath && fs.existsSync(this.downloadedInstallerPath)) {
      await shell.openPath(this.downloadedInstallerPath);
      app.quit();
      return;
    }
    if (this.autoUpdater && app.isPackaged) {
      this.autoUpdater.quitAndInstall(false, true);
    }
  }
}

module.exports = {
  UPSTREAM_REPO,
  PC_REPO,
  normalizeVersion,
  compareSemver,
  fetchLatestGithubRelease,
  UpdateManager
};
