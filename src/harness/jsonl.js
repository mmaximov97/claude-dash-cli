const fs = require('fs');

const cache = new Map(); // file -> { size, mtimeMs, records }

function readJsonlCached(file) {
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.records;

  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch { /* truncated/partial line */ }
  }
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, records });
  return records;
}

module.exports = { readJsonlCached };
