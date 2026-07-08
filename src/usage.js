const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const POLL_INTERVAL = 5 * 60_000;
const MAX_BACKOFF   = 15 * 60_000;

const HISTORY_DIR = path.join(os.homedir(), '.config', 'claude-dash-cli');
const HISTORY_PATH = path.join(HISTORY_DIR, 'history.json');

class UsageTracker {
  constructor(auth) {
    this.auth = auth;
    this.pollTimer = null;
    this.currentInterval = POLL_INTERVAL;
    this.history = this._loadHistory();
    this.latest = null;
    this.error = null;
    this.onUpdate = null;
  }

  _loadHistory() {
    try {
      const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
      const data = JSON.parse(raw);
      const cutoff = Date.now() - 24 * 3600_000;
      return Array.isArray(data) ? data.filter((h) => h.timestamp > cutoff) : [];
    } catch {
      return [];
    }
  }

  _saveHistory() {
    try {
      fs.mkdirSync(HISTORY_DIR, { recursive: true });
      fs.writeFileSync(HISTORY_PATH, JSON.stringify(this.history));
    } catch { /* non-fatal */ }
  }

  start(onUpdate) {
    this.onUpdate = onUpdate;
    this._poll();
    this._schedule();
  }

  stop() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  _schedule() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this._poll(), this.currentInterval);
  }

  async _poll() {
    try {
      const token = await this.auth.ensureValidToken();
      if (!token) throw new Error('No access token');

      const raw = await this._fetchUsage(token);
      const enriched = this._enrich(raw);
      this._recordHistory(enriched);
      this._resetBackoff();
      this.latest = enriched;
      this.error = null;
      if (this.onUpdate) this.onUpdate(enriched);
    } catch (err) {
      if (err.status === 401) {
        try {
          await this.auth.refreshTokens();
          return this._poll();
        } catch (e) {
          this.error = 'auth_expired: ' + e.message;
          this.stop();
          if (this.onUpdate) this.onUpdate(null);
          return;
        }
      }
      if (err.status === 429) {
        try { await this.auth.refreshTokens(); } catch {}
        this._increaseBackoff(err.retryAfter || 60_000);
        this.error = 'rate_limited: rotating token, retry in ' + Math.round(this.currentInterval / 1000) + 's';
        if (this.onUpdate) this.onUpdate(null);
        this._schedule();
        return;
      }
      this._increaseBackoff(err.retryAfter);
      this.error = err.message;
      if (this.onUpdate) this.onUpdate(null);
    }
    this._schedule();
  }

  _fetchUsage(accessToken) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(USAGE_URL);
      const req = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'claude-code/2.1',
        },
      }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode === 429) {
            const retryAfter = parseInt(res.headers['retry-after'] || '60', 10);
            const err = new Error(`Rate limited, retry in ${retryAfter}s`);
            err.status = 429;
            err.retryAfter = retryAfter * 1000;
            reject(err);
          } else if (res.statusCode >= 400) {
            const err = new Error(`Usage API ${res.statusCode}: ${body.slice(0, 200)}`);
            err.status = res.statusCode;
            reject(err);
          } else {
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(e); }
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  _enrich(raw) {
    const now = Date.now();
    const result = { timestamp: now, limits: {}, spend: raw.spend, extra_usage: raw.extra_usage };

    for (const entry of raw.limits || []) {
      if (!entry) continue;
      const key = this._limitKey(entry);
      const resetsAt = new Date(entry.resets_at).getTime();
      const timeToReset = Math.max(0, resetsAt - now);
      const prediction = this._predict(key, entry.percent);
      result.limits[key] = {
        label: this._limitLabel(entry),
        utilization: entry.percent,
        resets_at: entry.resets_at,
        timeToReset,
        estimatedTimeToLimit: prediction.eta,
        consumptionRate: prediction.rate,
        confidence: prediction.confidence,
        isActive: entry.is_active,
        severity: entry.severity,
      };
    }
    return result;
  }

  // Stable per-limit key: kind alone, or kind+model when scoped (e.g. 'weekly_scoped:Fable').
  // Any future per-model weekly limit gets its own key automatically — no hardcoded list.
  _limitKey(entry) {
    const model = entry.scope && entry.scope.model && entry.scope.model.display_name;
    return model ? `${entry.kind}:${model}` : entry.kind;
  }

  _limitLabel(entry) {
    if (entry.kind === 'session') return '5H';
    if (entry.kind === 'weekly_all') return '7D';
    const model = entry.scope && entry.scope.model && entry.scope.model.display_name;
    return model ? `${model} 7D` : entry.kind;
  }

  // ── Prediction engine (ported verbatim — see ai_dash/src/main/usage.js:151) ──

  _predict(key, currentUtil) {
    if (currentUtil >= 100) return { eta: 0, rate: null, confidence: 'high' };

    const segment = this._getSegment(key);
    if (segment.length < 2) return { eta: null, rate: null, confidence: 'none' };

    const rates = {
      short:  this._windowRate(segment, key, 10 * 60_000),
      medium: this._windowRate(segment, key, 30 * 60_000),
      long:   this._windowRate(segment, key, 60 * 60_000),
      full:   this._windowRate(segment, key, 2 * 3600_000),
      ewma:   this._ewmaRate(segment, key, 15 * 60_000),
    };

    const { rate, confidence } = this._selectRate(rates, segment, key);

    if (rate == null || rate <= 0 || currentUtil === 0) {
      return { eta: null, rate: this._toPerHour(rate), confidence: 'none' };
    }
    const eta = (100 - currentUtil) / rate;
    return { eta, rate: this._toPerHour(rate), confidence };
  }

  _getSegment(key) {
    const all = this.history.filter((h) => h.limits?.[key]?.utilization != null);
    if (all.length < 2) return all;
    let startIdx = 0;
    for (let i = all.length - 1; i > 0; i--) {
      if (all[i].limits[key].utilization < all[i - 1].limits[key].utilization) {
        startIdx = i;
        break;
      }
    }
    return all.slice(startIdx);
  }

  _windowRate(segment, key, windowMs) {
    const now = Date.now();
    const windowed = segment.filter((h) => h.timestamp > now - windowMs);
    if (windowed.length < 2) return null;
    const first = windowed[0];
    const last = windowed[windowed.length - 1];
    const dt = last.timestamp - first.timestamp;
    const du = last.limits[key].utilization - first.limits[key].utilization;
    if (dt < 30_000 || du < 0) return null;
    return du / dt;
  }

  _ewmaRate(segment, key, halfLifeMs) {
    if (segment.length < 2) return null;
    const now = Date.now();
    const lambda = Math.LN2 / halfLifeMs;
    let weightedRateSum = 0;
    let totalWeight = 0;
    for (let i = 1; i < segment.length; i++) {
      const dt = segment[i].timestamp - segment[i - 1].timestamp;
      const du = segment[i].limits[key].utilization - segment[i - 1].limits[key].utilization;
      if (dt < 10_000 || du < 0) continue;
      const midAge = now - (segment[i].timestamp + segment[i - 1].timestamp) / 2;
      const weight = Math.exp(-lambda * midAge);
      weightedRateSum += (du / dt) * weight;
      totalWeight += weight;
    }
    return totalWeight > 0 ? weightedRateSum / totalWeight : null;
  }

  _selectRate(rates, segment) {
    const valid = Object.entries(rates)
      .filter(([, r]) => r != null && r > 0)
      .map(([name, r]) => ({ name, r }));
    if (valid.length === 0) return { rate: null, confidence: 'none' };
    if (valid.length === 1) return { rate: valid[0].r, confidence: 'low' };

    const mean = valid.reduce((s, v) => s + v.r, 0) / valid.length;
    const variance = valid.reduce((s, v) => s + (v.r - mean) ** 2, 0) / valid.length;
    const cv = Math.sqrt(variance) / (mean || 1);

    const shortRate = rates.short ?? rates.medium;
    const longRate = rates.full ?? rates.long;
    let bestRate = rates.ewma != null ? rates.ewma : mean;

    if (shortRate != null && longRate != null && longRate > 0) {
      const accelRatio = shortRate / longRate;
      if (accelRatio > 1.5)       bestRate = shortRate * 0.7 + bestRate * 0.3;
      else if (accelRatio < 0.5)  bestRate = bestRate   * 0.7 + longRate * 0.3;
    }

    const confidence = (valid.length >= 3 && cv < 0.3 && segment.length >= 5)  ? 'high'
                     : (valid.length >= 2 && cv < 0.6 && segment.length >= 3)  ? 'medium'
                     : 'low';
    return { rate: bestRate, confidence };
  }

  _toPerHour(ratePerMs) {
    return ratePerMs != null ? ratePerMs * 3600_000 : null;
  }

  _recordHistory(data) {
    this.history.push({ timestamp: data.timestamp, limits: data.limits });
    const cutoff = Date.now() - 24 * 3600_000;
    this.history = this.history.filter((h) => h.timestamp > cutoff);
    this._saveHistory();
  }

  _resetBackoff() {
    this.currentInterval = POLL_INTERVAL;
  }

  _increaseBackoff(retryAfterMs) {
    this.currentInterval = retryAfterMs
      ? Math.min(retryAfterMs, MAX_BACKOFF)
      : Math.min(this.currentInterval * 2, MAX_BACKOFF);
  }
}

module.exports = { UsageTracker };
