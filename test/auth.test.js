const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAuthService } = require('../src/auth-service');
const { assertSafeHost } = require('../src/config');

function createTempAuth() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-board-auth-'));
  const auth = createAuthService({
    passwordPath: path.join(dir, 'password.json'),
    tokenPath: path.join(dir, 'token'),
    initialPassword: '123456',
  });
  return { dir, auth };
}

test('允许服务监听所有网卡以供局域网访问', () => {
  assert.equal(assertSafeHost({ server: { host: '0.0.0.0' } }), '0.0.0.0');
});

test('初始密码可以登录且磁盘中不保存明文密码', () => {
  const { dir, auth } = createTempAuth();
  try {
    const result = auth.login('123456', 'client-a');
    assert.equal(result.ok, true);
    assert.equal(result.token, auth.getToken());

    const stored = fs.readFileSync(path.join(dir, 'password.json'), 'utf8');
    assert.doesNotMatch(stored, /123456/);
    assert.ok(JSON.parse(stored).salt);
    assert.ok(JSON.parse(stored).hash);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('修改密码后旧密码和旧令牌失效', () => {
  const { dir, auth } = createTempAuth();
  try {
    const oldToken = auth.getToken();
    const changed = auth.changePassword('123456', '654321', 'client-a');

    assert.equal(changed.ok, true);
    assert.notEqual(changed.token, oldToken);
    assert.equal(auth.verifyToken(oldToken), false);
    assert.equal(auth.login('123456', 'client-a').ok, false);
    assert.equal(auth.login('654321', 'client-a').ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('连续输错密码会触发短时锁定', () => {
  let now = 1000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-board-auth-'));
  const auth = createAuthService({
    passwordPath: path.join(dir, 'password.json'),
    tokenPath: path.join(dir, 'token'),
    initialPassword: '123456',
    maxAttempts: 3,
    lockoutMs: 60_000,
    now: () => now,
  });

  try {
    assert.equal(auth.login('bad-1', 'client-a').ok, false);
    assert.equal(auth.login('bad-2', 'client-a').ok, false);
    const locked = auth.login('bad-3', 'client-a');
    assert.equal(locked.locked, true);
    assert.equal(auth.login('123456', 'client-a').locked, true);

    now += 60_001;
    assert.equal(auth.login('123456', 'client-a').ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
