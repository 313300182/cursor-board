const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('首页提供全局自由对话入口', () => {
  assert.match(html, /id="openGlobalChatBtn"/);
  assert.match(html, /openChat\('global'\)/);
  assert.match(html, /id="chatModal"/);
});

test('项目页提供项目对话入口', () => {
  assert.match(html, /id="projectChatBtn"/);
  assert.match(html, /openChat\('project',state\.projectId\)/);
  assert.match(html, /\/api\/chats/);
});

test('对话弹窗支持新会话与多轮消息区', () => {
  assert.match(html, /id="chatNewSessionBtn"/);
  assert.match(html, /id="chatMessages"/);
  assert.match(html, /chat-display\.js/);
});

test('新对话创建使用 upsert 避免 SSE 与 API 重复插入', () => {
  assert.match(html, /function upsertChatSession/);
  assert.match(html, /async function createChatSession\(\)[\s\S]*?upsertChatSession\(session,\{toFront:true\}\)/);
  assert.match(html, /if\(eventName==='chat:created'\)[\s\S]*?upsertChatSession\(payload,\{toFront:true\}\)/);
});
