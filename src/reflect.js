// claude-dash-cli reflect — retrospective scan of local Claude Code sessions.
//
// Pure aggregation (`aggregate`) is separated from I/O (`scanRecords`) and
// rendering (`render`) so the numbers are deterministic and testable.

// ── Pure aggregation ────────────────────────────────────────────
//
// records: array of parsed transcript objects ({ type, sessionId, cwd,
//          timestamp, message:{ model, usage, content } }).
// Returns a summary document (see tests/reflect.test.js for the shape).
function aggregate(records, { since = 0, until = Date.now() } = {}) {
  const sessions = new Map();
  const byTool = {};
  const byMcp = {};
  const bySkill = {};
  const byHour = new Array(24).fill(0);
  const activeDays = new Set();

  const totals = {
    sessions: 0, assistantMsgs: 0, userTurns: 0,
    tokensIn: 0, tokensOut: 0, cacheCreation: 0, cacheRead: 0, daysActive: 0,
  };

  for (const d of records) {
    if (!d || typeof d !== 'object') continue;
    const ts = d.timestamp ? new Date(d.timestamp).getTime() : null;
    if (ts == null || ts < since || ts > until) continue;

    const sid = d.sessionId || 'unknown';
    if (!sessions.has(sid)) {
      sessions.set(sid, {
        id: sid, cwd: d.cwd || '', first: ts, last: ts,
        assistantMsgs: 0, userTurns: 0,
        tokensIn: 0, tokensOut: 0, cacheCreation: 0, cacheRead: 0,
        models: new Set(),
      });
    }
    const s = sessions.get(sid);
    if (d.cwd) s.cwd = d.cwd;
    s.first = Math.min(s.first, ts);
    s.last = Math.max(s.last, ts);

    const day = new Date(ts);
    activeDays.add(`${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`);

    if (d.type === 'user') {
      s.userTurns++;
      totals.userTurns++;
      continue;
    }
    if (d.type !== 'assistant') continue;

    const msg = d.message || {};
    const u = msg.usage || {};
    const inTok = u.input_tokens || 0;
    const outTok = u.output_tokens || 0;
    const cacheCr = u.cache_creation_input_tokens || 0;
    const cacheRd = u.cache_read_input_tokens || 0;

    s.assistantMsgs++;
    s.tokensIn += inTok; s.tokensOut += outTok;
    s.cacheCreation += cacheCr; s.cacheRead += cacheRd;
    if (msg.model) s.models.add(msg.model);

    totals.assistantMsgs++;
    totals.tokensIn += inTok; totals.tokensOut += outTok;
    totals.cacheCreation += cacheCr; totals.cacheRead += cacheRd;
    byHour[new Date(ts).getHours()]++;

    for (const c of msg.content || []) {
      if (!c || typeof c !== 'object' || c.type !== 'tool_use') continue;
      const name = c.name || 'unknown';
      byTool[name] = (byTool[name] || 0) + 1;
      if (name.startsWith('mcp__')) {
        const server = name.split('__')[1] || 'unknown';
        byMcp[server] = (byMcp[server] || 0) + 1;
      }
      if (name === 'Skill') {
        const skill = (c.input && c.input.skill) || 'unknown';
        bySkill[skill] = (bySkill[skill] || 0) + 1;
      }
    }
  }

  const sessionRows = [...sessions.values()].map((s) => ({
    ...s, models: [...s.models],
  }));
  totals.sessions = sessionRows.length;
  totals.daysActive = activeDays.size;

  // Group by project (cwd).
  const byProject = {};
  for (const s of sessionRows) {
    const key = s.cwd || 'unknown';
    if (!byProject[key]) {
      byProject[key] = { sessions: 0, assistantMsgs: 0, tokens: 0, ms: 0 };
    }
    const p = byProject[key];
    p.sessions++;
    p.assistantMsgs += s.assistantMsgs;
    p.tokens += s.tokensIn + s.tokensOut + s.cacheCreation;
    p.ms += s.last - s.first;
  }

  return { window: { since, until }, totals, byProject, byTool, byMcp, bySkill, byHour, sessions: sessionRows };
}

// ── Window spec parsing ─────────────────────────────────────────
// '7d' → now - 7 days · 'all' → 0 · '2026-01-01' → that local midnight.
function parseSince(spec, now = Date.now()) {
  if (spec == null || spec === 'today') {
    const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime();
  }
  if (spec === 'all') return 0;
  const rel = /^(\d+)d$/.exec(spec);
  if (rel) return now - Number(rel[1]) * 86400_000;
  // Bare YYYY-MM-DD → local midnight (Date.parse would treat it as UTC).
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(spec);
  if (ymd) return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])).getTime();
  const abs = Date.parse(spec);
  if (!Number.isNaN(abs)) return abs;
  throw new Error(`unrecognized --since value: ${spec}`);
}

// ── I/O: read transcripts into records ──────────────────────────
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

async function scanRecords({ since = 0, until = Date.now(), projectsDir } = {}) {
  const dir = projectsDir || path.join(os.homedir(), '.claude', 'projects');
  const records = [];
  let projects;
  try { projects = await fs.promises.readdir(dir); } catch { return records; }

  for (const proj of projects) {
    const projPath = path.join(dir, proj);
    let entries;
    try { entries = await fs.promises.readdir(projPath); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(projPath, name);
      let stat;
      try { stat = await fs.promises.stat(full); } catch { continue; }
      if (stat.mtimeMs < since) continue; // untouched before window — skip

      const rl = readline.createInterface({
        input: fs.createReadStream(full, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (!line) continue;
        let d;
        try { d = JSON.parse(line); } catch { continue; }
        records.push(d);
      }
    }
  }
  return records;
}

// ── Rendering ───────────────────────────────────────────────────
const ESC = '\x1b[';
const C = {
  reset: ESC + '0m', bold: ESC + '1m', dim: ESC + '2m',
  green: ESC + '38;5;82m', lime: ESC + '38;5;120m', yellow: ESC + '38;5;220m',
  cyan: ESC + '38;5;117m', orange: ESC + '38;5;208m', gray: ESC + '38;5;245m',
};

function fmtCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function fmtDur(ms) {
  const m = Math.round(ms / 60_000);
  if (m >= 60) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
  return `${m}m`;
}

function hhmm(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function topEntries(obj, n) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
}

// render(doc, { label, color, section, format, width })
function render(doc, opts = {}) {
  if (opts.format === 'json') return JSON.stringify(doc, null, 2);

  const color = opts.color !== false;
  const width = opts.width || 76;
  const c = color ? C : new Proxy({}, { get: () => '' });
  const t = doc.totals;
  const want = (s) => !opts.section || opts.section === s;
  const lines = [];

  const rule = () => lines.push(`${c.dim}${'─'.repeat(Math.min(width, 64))}${c.reset}`);
  const head = (s) => { lines.push(''); lines.push(`${c.bold}${s}${c.reset}`); };

  // ── header / at a glance ──
  if (want('overview')) {
    const since = new Date(doc.window.since);
    const until = new Date(doc.window.until);
    const range = `${since.toISOString().slice(0, 10)} → ${until.toISOString().slice(0, 10)}`;
    lines.push(`${c.bold}claude-dash-cli reflect${c.reset}  ${c.dim}${opts.label || range}${c.reset}`);
    lines.push('');
    lines.push(
      `${c.bold}${t.sessions}${c.reset} sessions   ` +
      `${c.bold}${t.assistantMsgs}${c.reset} assistant msgs   ` +
      `${c.bold}${t.userTurns}${c.reset} user turns   ` +
      `${c.bold}${t.daysActive}${c.reset} day${t.daysActive === 1 ? '' : 's'} active`
    );
    lines.push(
      `${c.dim}tokens${c.reset}  ` +
      `${c.lime}in ${fmtCount(t.tokensIn)}${c.reset}  ` +
      `${c.yellow}out ${fmtCount(t.tokensOut)}${c.reset}  ` +
      `${c.cyan}cache+ ${fmtCount(t.cacheCreation)}${c.reset}  ` +
      `${c.dim}cache_rd ${fmtCount(t.cacheRead)}${c.reset}`
    );
  }

  // ── what you work on (by project) ──
  if (want('projects')) {
    const projects = Object.entries(doc.byProject)
      .sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 10);
    if (projects.length) {
      head('WHAT YOU WORK ON');
      const maxTok = Math.max(...projects.map(([, p]) => p.tokens), 1);
      for (const [cwd, p] of projects) {
        const name = (path.basename(cwd) || cwd).slice(0, 20).padEnd(20);
        const barW = Math.round((p.tokens / maxTok) * 16);
        const barStr = '█'.repeat(barW) + '░'.repeat(16 - barW);
        lines.push(
          `  ${name} ${c.green}${barStr}${c.reset} ` +
          `${c.dim}${p.sessions}s · ${p.assistantMsgs}m · ${fmtCount(p.tokens)}tok · ${fmtDur(p.ms)}${c.reset}`
        );
      }
    }
  }

  // ── tools / mcp / skills ──
  if (want('tools')) {
    const tools = topEntries(doc.byTool, 8);
    if (tools.length) {
      head('TOOLS');
      const maxC = Math.max(...tools.map(([, v]) => v), 1);
      for (const [name, count] of tools) {
        const label = name.replace(/^mcp__/, '').slice(0, 26).padEnd(26);
        const barW = Math.round((count / maxC) * 20);
        lines.push(`  ${label} ${c.cyan}${'█'.repeat(barW)}${c.reset} ${c.dim}${count}${c.reset}`);
      }
      const mcp = topEntries(doc.byMcp, 6);
      if (mcp.length) lines.push(`  ${c.dim}mcp${c.reset}    ` + mcp.map(([k, v]) => `${k} ${c.dim}${v}${c.reset}`).join('  '));
      const skills = topEntries(doc.bySkill, 8);
      if (skills.length) lines.push(`  ${c.dim}skills${c.reset} ` + skills.map(([k, v]) => `${k} ${c.dim}${v}${c.reset}`).join('  '));
    }
  }

  // ── time of day ──
  if (want('overview')) {
    const maxH = Math.max(...doc.byHour, 1);
    const ramp = ' ▁▂▃▄▅▆▇█';
    const spark = doc.byHour.map((v) => ramp[Math.round((v / maxH) * (ramp.length - 1))]).join('');
    if (doc.byHour.some((v) => v > 0)) {
      head('TIME OF DAY');
      // Axis aligned under the 24-column sparkline (one char = one hour).
      const axis = new Array(24).fill(' ');
      for (const [pos, lbl] of [[0, '0'], [6, '6'], [12, '12'], [18, '18'], [22, '23']]) {
        for (let k = 0; k < lbl.length; k++) axis[pos + k] = lbl[k];
      }
      lines.push(`  ${c.gray}${spark}${c.reset}`);
      lines.push(`  ${c.dim}${axis.join('')}${c.reset}`);
    }
  }

  // ── sessions ──
  if (want('sessions')) {
    const sessions = [...doc.sessions].sort((a, b) => b.last - a.last);
    if (sessions.length) {
      head('SESSIONS');
      for (const s of sessions) {
        const proj = (path.basename(s.cwd || '') || '?').slice(0, 18).padEnd(18);
        const models = s.models.map((m) => m.replace('claude-', '').replace(/-\d{8}$/, '')).join(',');
        lines.push(
          `  ${c.dim}${hhmm(s.first)}–${hhmm(s.last)}${c.reset} ${fmtDur(s.last - s.first).padStart(5)}  ` +
          `${proj} ${String(s.assistantMsgs).padStart(4)}m ` +
          `${fmtCount(s.tokensIn + s.tokensOut).padStart(6)}tok  ${c.dim}${models}${c.reset}`
        );
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────
const SECTIONS = ['overview', 'projects', 'tools', 'sessions'];
const HELP = `claude-dash-cli reflect — retrospective scan of your Claude Code sessions

Usage:
  claude-dash-cli reflect [section] [options]

Sections (default: all):
  overview   headline stats + time-of-day
  projects   what you worked on, grouped by project
  tools      tool / MCP / skill usage
  sessions   per-session timeline

Options:
  --since <spec>   today (default) | 7d | 30d | all | YYYY-MM-DD
  --format <fmt>   ansi (default) | json
  --no-color       plain text (no ANSI colors)
  -h, --help       this help
`;

function parseArgs(argv) {
  const opts = { section: null, since: 'today', format: 'ansi', color: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--no-color') opts.color = false;
    else if (a === '--since') opts.since = argv[++i];
    else if (a === '--format') opts.format = argv[++i];
    else if (a.startsWith('--since=')) opts.since = a.slice(8);
    else if (a.startsWith('--format=')) opts.format = a.slice(9);
    else if (SECTIONS.includes(a)) opts.section = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

async function run(argv = []) {
  let opts;
  try { opts = parseArgs(argv); }
  catch (e) { process.stderr.write(`${e.message}\n\n${HELP}`); return 2; }

  if (opts.help) { process.stdout.write(HELP); return 0; }

  const now = Date.now();
  const since = parseSince(opts.since, now);
  const labels = { today: 'today', all: 'all time' };
  const label = labels[opts.since] || (/^\d+d$/.test(opts.since) ? `last ${opts.since.slice(0, -1)} days` : opts.since);

  const records = await scanRecords({ since, until: now });
  const doc = aggregate(records, { since, until: now });
  const color = opts.color && process.stdout.isTTY;
  process.stdout.write(render(doc, { ...opts, label, color }) + '\n');
  return 0;
}

module.exports = { aggregate, parseSince, render, scanRecords, parseArgs, run };
