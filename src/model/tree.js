const DEFAULTS = { liveMs: 30_000, idleMs: 5 * 60_000, windowMs: 6 * 3600_000 };

function emptyUsage() {
  return { in: 0, out: 0, cacheCreate: 0, cacheRead: 0 };
}

function addUsage(a, b) {
  return {
    in: a.in + b.in,
    out: a.out + b.out,
    cacheCreate: a.cacheCreate + b.cacheCreate,
    cacheRead: a.cacheRead + b.cacheRead,
  };
}

function classifyStatus(lastActivity, now, opts = {}) {
  const merged = { ...DEFAULTS };
  for (const k of Object.keys(opts)) {
    if (opts[k] !== undefined) merged[k] = opts[k];
  }
  const { liveMs, idleMs, windowMs } = merged;
  const age = now - (lastActivity ?? 0);
  if (age <= liveMs) return 'live';
  if (age <= idleMs) return 'idle';
  if (age <= windowMs) return 'done';
  return null;
}

function computeRollup(node) {
  let acc = { ...(node.usage || emptyUsage()) };
  for (const child of node.children || []) {
    acc = addUsage(acc, computeRollup(child));
  }
  node.rollup = acc;
  return acc;
}

function flattenVisible(nodes, expandedIds, depth = 0, out = []) {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.children && node.children.length && expandedIds.has(node.id)) {
      flattenVisible(node.children, expandedIds, depth + 1, out);
    }
  }
  return out;
}

function fmtTokens(n) {
  if (n == null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

module.exports = { emptyUsage, addUsage, classifyStatus, computeRollup, flattenVisible, fmtTokens, DEFAULTS };
