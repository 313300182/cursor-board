const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensureDataDir, DATA_DIR } = require('../db');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const TOKEN_PATH = path.join(DATA_DIR, '.token');
const PASSWORD_PATH = path.join(DATA_DIR, '.password.json');
const PID_PATH = path.join(DATA_DIR, 'server.pid');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function loadOrCreateToken() {
  ensureDataDir();
  if (fs.existsSync(TOKEN_PATH)) {
    return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_PATH, token, { encoding: 'utf8', mode: 0o600 });
  return token;
}

function assertSafeHost(config) {
  const host = config.server?.host || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '0.0.0.0'].includes(host)) {
    throw new Error('安全限制：server.host 必须为 127.0.0.1、localhost 或 0.0.0.0');
  }
  return host;
}

function getPort(config) {
  return config.server?.port || 3920;
}

module.exports = {
  ROOT,
  CONFIG_PATH,
  TOKEN_PATH,
  PASSWORD_PATH,
  PID_PATH,
  loadConfig,
  loadOrCreateToken,
  assertSafeHost,
  getPort,
};
