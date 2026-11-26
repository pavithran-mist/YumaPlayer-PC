# YumaPlayer PC

**Created by Pavithran**

A native Windows desktop music & video player inspired by [MuwMx/YumaPlayer](https://github.com/MuwMx/YumaPlayer), featuring a sleek dark desktop interface, YouTube Music & Music Video streaming, Hi-Res local FLAC/MP3/WAV/MP4 playback, Synced Lyrics, SponsorBlock skipping, Dual-Deck Web Audio DSP, and in-app OTA Auto-Updates.

## Features
- **Hybrid Audio Library:** Stream from YouTube Music or scan local folders on any SSD/HDD (`FLAC`, `WAV`, `MP3`, `M4A`, `OGG`, `OPUS`, `ALAC`).
- **Dual-Deck Crossfade & Smart Bass-Swap:** Equal-power transitions (`0s–12s`) with sub-bass attenuation.
- **10-Band Graphic Equalizer:** Real-time Web Audio `BiquadFilterNode` chain with presets (`Flat`, `Bass Boost`, `Hi-Res Studio`, `Vocal Clarity`, `Club / EDM`, `Late Night`) and live spectrum visualizer.
- **Synced Lyrics:** Loads local `.lrc` sidecar files or fetches synced/plain lyrics via LRCLIB with click-to-seek.
- **SponsorBlock Integration:** Automatically skips sponsor/intro/outro/non-music segments on YouTube tracks.
- **Online Auto-Updater & Upstream Sync:** Built-in `electron-updater` checks GitHub Releases for new `.exe` updates and tracks upstream `MuwMx/YumaPlayer` releases.

## Running Locally
- Double-click **`Launch YumaPlayer.vbs`** (no console window) or **`Launch YumaPlayer.bat`**, or run:
  ```bash
  npm start
  ```

## Building Windows `.exe` Installer
```bash
npm run build:win
```

## GitHub Auto-Build & Releases
1. Create a GitHub repository named `YumaPlayer-PC` under your account (`pavithran-mist`).
2. Push this repo to `main`:
   ```bash
   git remote add origin https://github.com/pavithran-mist/YumaPlayer-PC.git
   git push -u origin main
   ```
3. To publish a release `.exe` that triggers in-app auto-updates:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
   GitHub Actions (`.github/workflows/release.yml`) will automatically test, build the NSIS `.exe` installer + portable `.exe`, and publish them to GitHub Releases.

## Running Tests
```bash
npm test
```
