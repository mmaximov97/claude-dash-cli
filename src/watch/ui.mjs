// src/watch/ui.mjs
import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import htm from 'htm';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { flattenVisible, fmtTokens } = require('../model/tree.js');
const { createPoller } = require('./poller.js');

const html = htm.bind(React.createElement);

export function resolveSelIndex(rows, selId) {
  const i = rows.findIndex((r) => r.node.id === selId);
  return i < 0 ? 0 : i;
}

const STATUS_COLOR = { live: 'green', idle: 'yellow', done: 'gray' };
const STATUS_DOT = { live: '●', idle: '◐', done: '○' };

function tokenSummary(u) {
  if (!u) return '';
  return `${fmtTokens(u.in)}→${fmtTokens(u.out)} ⇄${fmtTokens(u.cacheRead)}`;
}

function NodeRow({ node, depth, selected }) {
  const indent = '  '.repeat(depth);
  const dot = STATUS_DOT[node.status] || '·';
  const label = node.kind === 'session'
    ? `${node.harness}:${node.project || node.id}`
    : `${node.agentType || 'agent'} (${node.id})`;
  const tokens = tokenSummary(node.rollup || node.usage);
  return html`
    <${Text} color=${selected ? 'cyan' : undefined} inverse=${selected}>
      ${indent}<${Text} color=${STATUS_COLOR[node.status]}>${dot}</> ${label}  <${Text} color="gray">${tokens}</>
    </>`;
}

function TreeView({ rows, sel }) {
  if (!rows.length) return html`<${Text} color="gray">  (no live or recent sessions)</>`;
  return html`
    <${Box} flexDirection="column">
      ${rows.map((r, i) => html`<${NodeRow} key=${r.node.id + ':' + r.depth} node=${r.node} depth=${r.depth} selected=${i === sel} />`)}
    </>`;
}

function StatusBar({ sessions, limitInfo, err }) {
  const total = sessions.reduce((a, s) => a + ((s.rollup && s.rollup.out) || 0), 0);
  const live = sessions.filter((s) => s.status === 'live').length;
  const five = limitInfo && limitInfo.limits && limitInfo.limits.five_hour;
  const extra = limitInfo && limitInfo.extra_usage;
  return html`
    <${Box} flexDirection="column" marginBottom=${1}>
      <${Text} bold>claude-dash-cli watch — ${live} live · ${sessions.length} recent · out ${fmtTokens(total)}</>
      <${Text} color="gray">
        ${five ? `5h limit: ${Math.round(five.utilization)}%` : '5h limit: —'}${extra ? `  extra: ${JSON.stringify(extra)}` : ''}
        ${err ? html`  <${Text} color="red">${err}</>` : ''}
      </>
    </>`;
}

function DetailPane({ node }) {
  const u = node.rollup || node.usage || {};
  return html`
    <${Box} flexDirection="column" borderStyle="round" borderColor="gray" paddingX=${1}>
      <${Text} bold>${node.harness}:${node.kind} ${node.id}</>
      <${Text} color="gray">cwd: ${node.cwd || '—'}  model: ${node.model || '—'}</>
      <${Text} color="gray">status: ${node.status}  in ${fmtTokens(u.in)} · out ${fmtTokens(u.out)}</>
    </>`;
}

export function App({ discover, intervalMs = 2000, limitSource = null }) {
  const [sessions, setSessions] = useState([]);
  const [err, setErr] = useState(null);
  const [limitInfo, setLimitInfo] = useState(null);
  const [selId, setSelId] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [showDetail, setShowDetail] = useState(false);
  const { exit } = useApp();

  useEffect(() => {
    const poller = createPoller({
      intervalMs, discover,
      onUpdate: (s, e) => { if (e) setErr(String(e.message || e)); else { setSessions(s); setErr(null); } },
    });
    poller.start();
    return () => poller.stop();
  }, [discover, intervalMs]);

  useEffect(() => {
    if (!limitSource) return undefined;
    limitSource.start((info) => setLimitInfo(info));
    return () => limitSource.stop();
  }, [limitSource]);

  const rows = flattenVisible(sessions, expanded);
  const selIndex = resolveSelIndex(rows, selId);
  const current = rows[selIndex] && rows[selIndex].node;

  useInput((input, key) => {
    if (input === 'q' || key.escape) { exit(); return; }
    if (key.downArrow) { const ni = Math.min(rows.length - 1, selIndex + 1); if (rows[ni]) setSelId(rows[ni].node.id); }
    if (key.upArrow) { const ni = Math.max(0, selIndex - 1); if (rows[ni]) setSelId(rows[ni].node.id); }
    if (key.rightArrow || key.return) { const n = current; if (n && n.children && n.children.length) setExpanded((s) => new Set(s).add(n.id)); }
    if (key.leftArrow) { const n = current; if (n) setExpanded((s) => { const c = new Set(s); c.delete(n.id); return c; }); }
    if (input === 'd') setShowDetail((v) => !v);
  });

  return html`
    <${Box} flexDirection="column">
      <${StatusBar} sessions=${sessions} limitInfo=${limitInfo} err=${err} />
      <${TreeView} rows=${rows} sel=${selIndex} />
      ${showDetail && current ? html`<${DetailPane} node=${current} />` : null}
      <${Text} color="gray">↑↓ move · →/Enter expand · ← collapse · d detail · q quit</>
    </>`;
}

export function run({ intervalMs = 2000, discover, limitSource = null } = {}) {
  const require2 = createRequire(import.meta.url);
  const finalDiscover = discover || (() => {
    const { discoverAll } = require2('../harness/index.js');
    return discoverAll({ now: Date.now() });
  });
  const app = render(html`<${App} discover=${finalDiscover} intervalMs=${intervalMs} limitSource=${limitSource} />`);
  app.waitUntilExit().then(() => {
    if (limitSource) { try { limitSource.stop(); } catch { /* ignore */ } }
    process.exit(0);
  });
  return app;
}
