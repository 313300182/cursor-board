const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function writePrivateFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, record) {
  const actual = crypto.scryptSync(String(password || ''), record.salt, 32);
  const expected = Buffer.from(record.hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createAuthService(options) {
  const {
    passwordPath,
    tokenPath,
    initialPassword = '123456',
    maxAttempts = 5,
    lockoutMs = 5 * 60 * 1000,
    now = Date.now,
  } = options;
  const attempts = new Map();

  if (!fs.existsSync(passwordPath)) {
    writePrivateFile(passwordPath, JSON.stringify(createPasswordRecord(initialPassword)));
  }
  if (!fs.existsSync(tokenPath)) {
    writePrivateFile(tokenPath, crypto.randomBytes(32).toString('hex'));
  }

  let passwordRecord = JSON.parse(fs.readFileSync(passwordPath, 'utf8'));
  let token = fs.readFileSync(tokenPath, 'utf8').trim();

  function failure(clientKey) {
    const key = String(clientKey || 'unknown');
    const current = attempts.get(key) || { count: 0, lockedUntil: 0 };
    current.count += 1;
    if (current.count >= maxAttempts) {
      current.lockedUntil = now() + lockoutMs;
    }
    attempts.set(key, current);
    return {
      ok: false,
      locked: current.lockedUntil > now(),
      retryAfterMs: Math.max(0, current.lockedUntil - now()),
    };
  }

  function login(password, clientKey) {
    const key = String(clientKey || 'unknown');
    const current = attempts.get(key);
    if (current?.lockedUntil > now()) {
      return {
        ok: false,
        locked: true,
        retryAfterMs: current.lockedUntil - now(),
      };
    }
    if (!verifyPassword(password, passwordRecord)) {
      return failure(key);
    }
    attempts.delete(key);
    return { ok: true, token };
  }

  function changePassword(currentPassword, newPassword, clientKey) {
    const authenticated = login(currentPassword, clientKey);
    if (!authenticated.ok) return authenticated;
    if (String(newPassword || '').length < 6) {
      return { ok: false, invalid: true };
    }

    passwordRecord = createPasswordRecord(String(newPassword));
    writePrivateFile(passwordPath, JSON.stringify(passwordRecord));
    token = crypto.randomBytes(32).toString('hex');
    writePrivateFile(tokenPath, token);
    attempts.clear();
    return { ok: true, token };
  }

  return {
    getToken: () => token,
    verifyToken: (candidate) => {
      const actual = Buffer.from(String(candidate || ''));
      const expected = Buffer.from(token);
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    },
    login,
    changePassword,
  };
}

module.exports = {
  createAuthService,
};
