const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { JsonStore } = require('../src/main/store');
const { isSupportedAudioFile, getMimeType, walkAudioFiles, scanLocalFolders } = require('../src/main/library');
const { normalizeSegments, findActiveSkipSegment } = require('../src/main/sponsorBlock');
const { findSidecarLrc } = require('../src/main/lyricsService');
const { parseDurationText, normalizeYtmSong } = require('../src/main/youtubeService');
const { parseLrc, findActiveLineIndex } = require('../src/renderer/scripts/lrcParser');
const { computeCrossfadeGains, EQ_FREQUENCIES, EQ_PRESETS } = require('../src/renderer/scripts/audioEngine');
const { normalizeVersion, compareSemver } = require('../src/main/updater');

test('JsonStore persists likes, playlists, folders, and settings', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuma-store-'));
  const storePath = path.join(tmpDir, 'data.json');
  const store = new JsonStore(storePath);

  const track = { id: 'yt_abc123', title: 'Test Song', artist: 'Artist' };
  const like1 = store.toggleLike(track);
  assert.equal(like1.liked, true);
  assert.equal(like1.likedTracks.length, 1);

  const pl = store.createPlaylist('Chill Mix');
  store.addTrackToPlaylist(pl.id, track);
  assert.equal(store.getState().playlists[0].tracks.length, 1);

  store.updateSettings({ crossfadeSeconds: 6, bassSwap: false });

  // Reload from disk
  const reloaded = new JsonStore(storePath);
  assert.equal(reloaded.getState().likedTracks.length, 1);
  assert.equal(reloaded.getState().playlists[0].name, 'Chill Mix');
  assert.equal(reloaded.getState().settings.crossfadeSeconds, 6);
  assert.equal(reloaded.getState().settings.bassSwap, false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Local library scanner detects supported audio & video files and sidecar LRC', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuma-lib-'));
  const flacFile = path.join(tmpDir, 'Track One.flac');
  const mp4File = path.join(tmpDir, 'Video Song.mp4');
  const lrcFile = path.join(tmpDir, 'Track One.lrc');
  const txtFile = path.join(tmpDir, 'notes.txt');

  fs.writeFileSync(flacFile, Buffer.from('fLaCdummy'));
  fs.writeFileSync(mp4File, Buffer.from('mp4dummy'));
  fs.writeFileSync(lrcFile, '[00:01.00] Hello world');
  fs.writeFileSync(txtFile, 'ignore me');

  assert.equal(isSupportedAudioFile(flacFile), true);
  assert.equal(isSupportedAudioFile(mp4File), true);
  assert.equal(isSupportedAudioFile(txtFile), false);
  assert.equal(getMimeType(flacFile), 'audio/flac');
  assert.equal(getMimeType(mp4File), 'video/mp4');

  const files = walkAudioFiles(tmpDir);
  assert.equal(files.length, 2);

  const tracks = await scanLocalFolders([tmpDir]);
  assert.equal(tracks.length, 2);
  const flacTrack = tracks.find((t) => t.title === 'Track One');
  const mp4Track = tracks.find((t) => t.title === 'Video Song');
  assert.equal(flacTrack.lossless, true);
  assert.equal(flacTrack.mediaType, 'audio');
  assert.equal(mp4Track.mediaType, 'video');
  assert.equal(findSidecarLrc(flacFile), '[00:01.00] Hello world');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('LRC parser parses timestamps and finds active line via binary search', () => {
  const lrc = '[00:05.00] First line\n[00:12.50] Second line\n[00:20.00] Third line';
  const lines = parseLrc(lrc);
  assert.equal(lines.length, 3);
  assert.equal(lines[1].time, 12.5);
  assert.equal(lines[1].text, 'Second line');

  assert.equal(findActiveLineIndex(lines, 1.0), -1);
  assert.equal(findActiveLineIndex(lines, 6.0), 0);
  assert.equal(findActiveLineIndex(lines, 15.0), 1);
  assert.equal(findActiveLineIndex(lines, 25.0), 2);
});

test('SponsorBlock normalizes and detects active skip segments', () => {
  const segs = normalizeSegments([
    { segment: [30, 45], category: 'music_offtopic' },
    { segment: [0, 12], category: 'intro' }
  ]);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].category, 'intro');
  assert.equal(findActiveSkipSegment(segs, 5)?.end, 12);
  assert.equal(findActiveSkipSegment(segs, 20), null);
});

test('Equal-power crossfade math and 10-band EQ presets are valid', () => {
  assert.equal(EQ_FREQUENCIES.length, 10);
  assert.equal(EQ_PRESETS['Bass Boost'].length, 10);

  const start = computeCrossfadeGains(0);
  assert.ok(Math.abs(start.outgoing - 1) < 1e-6);
  assert.ok(Math.abs(start.incoming - 0) < 1e-6);

  const mid = computeCrossfadeGains(0.5);
  const powerSum = mid.outgoing ** 2 + mid.incoming ** 2;
  assert.ok(Math.abs(powerSum - 1) < 1e-6);
});

test('YouTube Music normalizer parses song items cleanly', () => {
  assert.equal(parseDurationText('3:45'), 225);
  assert.equal(parseDurationText('1:02:10'), 3730);

  const track = normalizeYtmSong({
    id: 'dQw4w9WgXcQ',
    title: 'Sample Song',
    artists: [{ name: 'Artist A' }, { name: 'Artist B' }],
    duration: { text: '3:32' }
  });
  assert.equal(track.id, 'yt_dQw4w9WgXcQ');
  assert.equal(track.artist, 'Artist A, Artist B');
  assert.equal(track.duration, 212);
  assert.equal(track.mediaType, 'audio');

  const videoTrack = normalizeYtmSong({ id: 'vid123', title: 'MV' }, 'video');
  assert.equal(videoTrack.mediaType, 'video');
  assert.equal(videoTrack.codec, 'VIDEO');
});

test('Updater semver comparison handles v-prefixes and release tags', () => {
  assert.equal(normalizeVersion('v1.2.0-RC1'), '1.2.0-RC1');
  assert.equal(compareSemver('v1.2.0', '1.0.0'), 1);
  assert.equal(compareSemver('1.0.0', 'v1.0.0'), 0);
  assert.equal(compareSemver('1.0.0', '1.1.0'), -1);
});
