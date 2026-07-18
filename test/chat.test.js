const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { ensureSchema, createProjectRepo, createChatRepo } = require('../db');
const ChatService = require('../chat-service');
const { ROOT } = require('../src/config');

function createFixture() {
  const db = new Database(':memory:');
  ensureSchema(db);
  const projects = createProjectRepo(db);
  projects.ensureMachineProject();
  const project = projects.createProject({
    id: 'proj-chat',
    name: 'Chat Project',
    type: 'normal',
    workdirs: [{ label: 'root', path: ROOT }],
    created_at: new Date().toISOString(),
  });
  const chatRepo = createChatRepo(db);
  const events = [];
  const chatService = new ChatService({
    chatRepo,
    projects,
    config: {
      security: { workdirAllowlist: ['D:\\', 'C:\\'] },
      cursor: {
        models: {
          simpleDefault: 'gpt-test',
          complexDefault: 'opus-test',
          options: [{ id: 'gpt-test', name: 'GPT Test' }],
        },
      },
    },
    broadcast: (event, data) => events.push({ event, data }),
    runner: {
      isTaskRunning: () => false,
      runChatTurn: async () => ({
        resultSummary: '你好，我是 Agent',
        sessionId: 'agent-session-1',
      }),
      submitInteraction: async () => {},
      cancelTask: () => {},
    },
  });
  return { chatRepo, chatService, project, events };
}

test('createSession 支持全局与项目对话', () => {
  const { chatService, project } = createFixture();
  const globalSession = chatService.createSession();
  assert.equal(globalSession.project_id, null);
  assert.equal(globalSession.workdir, ROOT);
  assert.equal(globalSession.status, 'idle');

  const projectSession = chatService.createSession({ projectId: project.id });
  assert.equal(projectSession.project_id, project.id);
  assert.equal(projectSession.workdir, ROOT);
});

test('startMessage 保存用户消息并异步完成助手回复', async () => {
  const { chatService, events } = createFixture();
  const session = chatService.createSession();
  const running = chatService.startMessage(session.id, { message: '这个项目怎么部署？' });
  assert.equal(running.status, 'running');
  assert.equal(chatService.listMessages(session.id).length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  const updated = chatService.getSession(session.id);
  assert.equal(updated.status, 'idle');
  assert.equal(updated.agent_session_id, 'agent-session-1');
  assert.equal(updated.title, '这个项目怎么部署？');
  const messages = chatService.listMessages(session.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].role, 'assistant');
  assert.match(messages[1].content, /Agent/);
  assert.ok(events.some((entry) => entry.event === 'chat:done'));
});

test('listSessions 按 projectId 过滤', () => {
  const { chatService, project } = createFixture();
  chatService.createSession();
  chatService.createSession({ projectId: project.id });
  assert.equal(chatService.listSessions(null).length, 1);
  assert.equal(chatService.listSessions(project.id).length, 1);
});

test('recoverStaleRunning 重置运行中对话', () => {
  const db = new Database(':memory:');
  ensureSchema(db);
  const chatRepo = createChatRepo(db);
  const now = new Date().toISOString();
  chatRepo.createSession({
    id: 's1',
    project_id: null,
    title: 'x',
    workdir: ROOT,
    status: 'running',
    created_at: now,
    updated_at: now,
  });
  assert.equal(chatRepo.recoverStaleRunning(), 1);
  assert.equal(chatRepo.getSession('s1').status, 'idle');
});
