const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('页面提供手机友好的密码登录界面', () => {
  assert.match(html, /id="loginGate"/);
  assert.match(html, /id="loginPassword"/);
  assert.match(html, /id="loginBtn"/);
  assert.match(html, /\/api\/auth\/login/);
  assert.match(html, /autocomplete="current-password"/);
});

test('页面提供修改密码入口并更新轮换后的令牌', () => {
  assert.match(html, /id="securityBtn"/);
  assert.match(html, /id="passwordModal"/);
  assert.match(html, /id="currentPassword"/);
  assert.match(html, /id="newPassword"/);
  assert.match(html, /\/api\/auth\/password/);
  assert.match(html, /localStorage\.setItem\('cursorBoardToken',state\.token\)/);
});

test('页面不再从公开 bootstrap 接口读取 token', () => {
  assert.doesNotMatch(html, /if\(!state\.token\)\{state\.token=data\.token/);
  assert.match(html, /await api\('\/api\/bootstrap'\)/);
});
