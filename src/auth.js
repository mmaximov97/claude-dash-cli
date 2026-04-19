const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

class AuthManager {
  constructor() {
    this._cached = null;
  }

  _readClaudeCredentials() {
    try {
      const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
      return JSON.parse(raw).claudeAiOauth || null;
    } catch {
      return null;
    }
  }

  _writeClaudeCredentials(oauth) {
    try {
      let creds = {};
      try { creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8')); } catch {}
      creds.claudeAiOauth = oauth;
      fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 4));
    } catch { /* non-fatal */ }
  }

  _postForm(url, params, _depth = 0) {
    if (_depth > 5) return Promise.reject(new Error('Too many redirects'));
    const formBody = new URLSearchParams(params).toString();
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const req = mod.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(formBody),
          'User-Agent': 'claude-code/2.1',
        },
      }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          this._postForm(next, params, _depth + 1).then(resolve, reject);
          return;
        }
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 400) {
              const msg = json.error_description || json.error || JSON.stringify(json);
              const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
              err.status = res.statusCode;
              reject(err);
            } else {
              resolve(json);
            }
          } catch {
            reject(new Error(`Invalid JSON (${res.statusCode}): ${data.slice(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.write(formBody);
      req.end();
    });
  }

  async refreshTokens() {
    const creds = this._readClaudeCredentials();
    if (!creds?.refreshToken) throw new Error('No refresh token in ~/.claude/.credentials.json');

    const tokens = await this._postForm(TOKEN_URL, {
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: CLIENT_ID,
    });

    const oauth = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || creds.refreshToken,
      expiresAt: new Date(Date.now() + (tokens.expires_in || 28800) * 1000).toISOString(),
      scopes: tokens.scope ? tokens.scope.split(' ') : (creds.scopes || ['user:inference', 'user:profile']),
    };
    this._writeClaudeCredentials(oauth);
    this._cached = oauth;
    return oauth;
  }

  getAccessToken() {
    if (this._cached?.accessToken) return this._cached.accessToken;
    const creds = this._readClaudeCredentials();
    return creds?.accessToken || null;
  }

  isTokenExpired() {
    const creds = this._cached || this._readClaudeCredentials();
    if (!creds?.expiresAt) return true;
    // Refresh 5 min before expiry for safety
    return Date.now() > new Date(creds.expiresAt).getTime() - 5 * 60_000;
  }

  async ensureValidToken() {
    if (this.isTokenExpired()) {
      await this.refreshTokens();
    }
    return this.getAccessToken();
  }
}

module.exports = { AuthManager };
