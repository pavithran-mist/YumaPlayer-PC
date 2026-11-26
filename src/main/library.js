const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUDIO_EXTENSIONS = new Set([
  '.flac',
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.alac',
  '.webm'
]);

const MIME_TYPES = {
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.alac': 'audio/mp4',
  '.webm': 'audio/webm'
};

function isSupportedAudioFile(filePath) {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function getMimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function walkAudioFiles(dirPath, maxDepth = 5, currentDepth = 0, out = []) {
  if (!dirPath || !fs.existsSync(dirPath) || currentDepth > maxDepth) return out;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkAudioFiles(fullPath, maxDepth, currentDepth + 1, out);
    } else if (entry.isFile() && isSupportedAudioFile(fullPath)) {
      out.push(fullPath);
    }
  }
  return out;
}

function makeTrackId(filePath) {
  return 'local_' + crypto.createHash('sha1').update(path.resolve(filePath)).digest('hex').slice(0, 16);
}

async function parseAudioFile(filePath, mmModule = null) {
  const ext = path.extname(filePath).replace('.', '').toUpperCase();
  const baseName = path.basename(filePath, path.extname(filePath));
  let title = baseName;
  let artist = 'Unknown Artist';
  let album = 'Local Library';
  let duration = 0;
  let artwork = null;
  let sampleRate = null;
  let bitDepth = null;
  let codec = ext;

  try {
    const mm = mmModule || (await import('music-metadata'));
    const metadata = await mm.parseFile(filePath, { duration: true });
    const { common, format } = metadata;
    if (common.title) title = common.title;
    if (common.artist) artist = common.artist;
    if (common.album) album = common.album;
    if (format.duration) duration = Math.round(format.duration);
    if (format.sampleRate) sampleRate = format.sampleRate;
    if (format.bitsPerSample) bitDepth = format.bitsPerSample;
    if (format.codec) codec = format.codec;

    if (Array.isArray(common.picture) && common.picture.length > 0) {
      const pic = common.picture[0];
      const base64 = Buffer.from(pic.data).toString('base64');
      artwork = `data:${pic.format || 'image/jpeg'};base64,${base64}`;
    }
  } catch {
    // Fallback to filename metadata
  }

  return {
    id: makeTrackId(filePath),
    source: 'local',
    title,
    artist,
    album,
    duration,
    artwork,
    filePath: path.resolve(filePath),
    codec,
    sampleRate,
    bitDepth,
    lossless: ext === 'FLAC' || ext === 'WAV' || ext === 'ALAC'
  };
}

async function scanLocalFolders(folderPaths) {
  if (!Array.isArray(folderPaths) || folderPaths.length === 0) return [];
  const fileSet = new Set();
  for (const folder of folderPaths) {
    for (const file of walkAudioFiles(folder)) {
      fileSet.add(path.resolve(file));
    }
  }

  let mmModule = null;
  try {
    mmModule = await import('music-metadata');
  } catch {
    mmModule = null;
  }

  const files = Array.from(fileSet);
  const tracks = [];
  const batchSize = 8;
  for (let i = 0; i < files.length; i += batchSize) {
    const chunk = files.slice(i, i + batchSize);
    const parsed = await Promise.all(chunk.map((f) => parseAudioFile(f, mmModule)));
    tracks.push(...parsed);
  }
  return tracks.sort((a, b) => a.title.localeCompare(b.title));
}

module.exports = {
  AUDIO_EXTENSIONS,
  isSupportedAudioFile,
  getMimeType,
  walkAudioFiles,
  parseAudioFile,
  scanLocalFolders
};
