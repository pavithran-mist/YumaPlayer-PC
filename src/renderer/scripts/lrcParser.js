(function (root) {
  const TIMESTAMP_RE = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

  function parseLrc(lrcText) {
    if (!lrcText || typeof lrcText !== 'string') return [];
    const lines = [];
    const rawLines = lrcText.split(/\r?\n/);

    for (const raw of rawLines) {
      const timestamps = [];
      let match;
      TIMESTAMP_RE.lastIndex = 0;
      while ((match = TIMESTAMP_RE.exec(raw)) !== null) {
        const mins = parseInt(match[1], 10);
        const secs = parseInt(match[2], 10);
        const fracRaw = match[3] || '0';
        const frac = parseInt(fracRaw.padEnd(3, '0').slice(0, 3), 10) / 1000;
        timestamps.push(mins * 60 + secs + frac);
      }

      if (timestamps.length === 0) continue;
      const text = raw.replace(TIMESTAMP_RE, '').trim();
      for (const time of timestamps) {
        lines.push({ time, text: text || '♪' });
      }
    }

    return lines.sort((a, b) => a.time - b.time);
  }

  function findActiveLineIndex(lines, currentTime) {
    if (!Array.isArray(lines) || lines.length === 0) return -1;
    let low = 0;
    let high = lines.length - 1;
    let ans = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (lines[mid].time <= currentTime + 0.15) {
        ans = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return ans;
  }

  const api = { parseLrc, findActiveLineIndex };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.LrcParser = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
