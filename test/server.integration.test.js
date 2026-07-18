const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { ensureSchema, createProjectRepo, createTaskRepo, createChatRepo } = require('../db');
const ChatService = require('../chat-service');
const { createApp } = require('../src/app');
const { ROOT } = require('../src/config');
const { createBroadcaster } = require('../src/sse/broadcaster');

function createTestDeps(overrides = {}) {
  const db = new Database(':memory:');
  ensureSchema(db);
  const repo = createTaskRepo(db);
  const chatRepo = createChatRepo(db);
  const projects = createProjectRepo(db);
  projects.ensureMachineProject();

  const token = 'test-token';
  let currentToken = token;
  const authService = {
    getToken: () => currentToken,
    verifyToken: (candidate) => candidate === currentToken,
    login: (password) =>
      password === '123456'
        ? { ok: true, token: currentToken }
        : { ok: false, locked: false },
    changePassword: (currentPassword, newPassword) => {
      if (currentPassword !== '123456' || String(newPassword).length < 6) {
        return { ok: false, locked: false };
      }
      currentToken = 'rotated-token';
      return { ok: true, token: currentToken };
    },
  };
  const config = {
    server: { host: '127.0.0.1', port: 0 },
    security: { workdirAllowlist: ['D:\\', 'C:\\'] },
    queue: { maxConcurrent: 3 },
    cursor: {
      models: {
        simpleDefault: 'gpt-test',
        complexDefault: 'opus-test',
        options: [{ id: 'gpt-test', name: 'GPT Test' }],
      },
    },
  };

  const broadcaster = createBroadcaster();
  const chatService = new ChatService({
    chatRepo,
    projects,
    config,
    broadcast: (event, data) => broadcaster.send(event, data),
    runner: {
      isTaskRunning: () => false,
      runChatTurn: async () => ({
        resultSummary: 'mock reply',
        sessionId: 'mock-agent-session',
      }),
      submitInteraction: async () => {},
      cancelTask: () => {},
    },
  });
  const queue = {
    currentTaskId: null,
    runningTaskIds: [],
    running: false,
    isWorkdirAllowed: () => true,
    createTask: () => {
      throw new Error('queue.createTask not mocked');
    },
    ...overrides.queue,
  };
  const projectDeployer = {
    deployProject: async () => {
      throw new Error('projectDeployer.deployProject not mocked');
    },
    approveRepair: async () => {
      throw new Error('projectDeployer.approveRepair not mocked');
    },
    ...overrides.projectDeployer,
  };

  const app = createApp({
    config,
    token,
    authService,
    repo,
    projects,
    queue,
    projectDeployer,
    chatService,
    broadcaster,
    root: ROOT,
  });

  return { app, db, repo, chatRepo, projects, token, authService, config, broadcaster, queue, chatService };
}

function request(app, method, urlPath, options = {}) {
  const { token, body, headers = {} } = options;
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const reqHeaders = { ...headers };
      if (token) {
        reqHeaders.Authorization = `Bearer ${token}`;
      }
      if (body !== undefined) {
        reqHeaders['Content-Type'] = 'application/json';
      }

      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: reqHeaders,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          server.close(() => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let json = null;
            if (raw && res.headers['content-type']?.includes('json')) {
              try {
                json = JSON.parse(raw);
              } catch (_err) {
                json = null;
              }
            }
            resolve({ status: res.statusCode, json, raw, headers: res.headers });
          });
        });
      });
      req.on('error', (err) => {
        server.close(() => reject(err));
      });
      if (body !== undefined) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
    server.on('error', reject);
  });
}

test('GET /api/health 无需 token 返回运行状态', async () => {
  const { app, db } = createTestDeps();
  const res = await request(app, 'GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.runningTaskId, null);
  assert.equal(res.json.queueBusy, false);
  assert.equal(res.json.maxConcurrent, 3);
  db.close();
});

test('GET /api/bootstrap 无 token 返回 401', async () => {
  const { app, db } = createTestDeps();
  const res = await request(app, 'GET', '/api/bootstrap');
  assert.equal(res.status, 401);
  db.close();
});

test('POST /api/auth/login 使用正确密码返回 token', async () => {
  const { app, db, token } = createTestDeps();
  const res = await request(app, 'POST', '/api/auth/login', {
    body: { password: '123456' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.token, token);
  db.close();
});

test('POST /api/auth/login 使用错误密码返回 401', async () => {
  const { app, db } = createTestDeps();
  const res = await request(app, 'POST', '/api/auth/login', {
    body: { password: 'wrong-password' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error, '密码错误');
  db.close();
});

test('GET /api/bootstrap 带 token 返回模型配置但不泄露 token', async () => {
  const { app, db, token } = createTestDeps();
  const res = await request(app, 'GET', '/api/bootstrap', { token });
  assert.equal(res.status, 200);
  assert.equal(Object.hasOwn(res.json, 'token'), false);
  assert.equal(res.json.workdirDefault, ROOT);
  assert.ok(Array.isArray(res.json.workdirAllowlist));
  assert.ok(res.json.models);
  assert.ok(Array.isArray(res.json.models.options));
  db.close();
});

test('PUT /api/auth/password 修改密码后返回轮换令牌', async () => {
  const { app, db, token } = createTestDeps();
  const res = await request(app, 'PUT', '/api/auth/password', {
    token,
    body: { currentPassword: '123456', newPassword: '654321' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.token, 'rotated-token');

  const oldTokenRes = await request(app, 'GET', '/api/templates', { token });
  assert.equal(oldTokenRes.status, 401);
  const newTokenRes = await request(app, 'GET', '/api/templates', {
    token: 'rotated-token',
  });
  assert.equal(newTokenRes.status, 200);
  db.close();
});

test('GET /api/templates 无 token 返回 401', async () => {
  const { app, db } = createTestDeps();
  const res = await request(app, 'GET', '/api/templates');
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'Unauthorized');
  db.close();
});

test('GET /api/templates 带 token 返回模板列表', async () => {
  const { app, db, token } = createTestDeps();
  const res = await request(app, 'GET', '/api/templates', { token });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json));
  assert.ok(res.json.length > 0);
  db.close();
});

test('GET /api/projects 无 token 返回 401', async () => {
  const { app, db } = createTestDeps();
  const res = await request(app, 'GET', '/api/projects');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /api/projects 带 token 返回项目列表', async () => {
  const { app, db, token } = createTestDeps();
  const res = await request(app, 'GET', '/api/projects', { token });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json));
  assert.ok(res.json.some((project) => project.type === 'machine'));
  db.close();
});

test('GET /api/projects/missing 返回 404', async () => {
  const { app, db, token } = createTestDeps();
  const res = await request(app, 'GET', '/api/projects/missing', { token });
  assert.equal(res.status, 404);
  assert.equal(res.json.error, '项目不存在');
  db.close();
});

test('POST /api/projects 缺 name 返回 400', async () => {
  const { app, db, token } = createTestDeps();
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-workdir-'));
  try {
    const res = await request(app, 'POST', '/api/projects', {
      token,
      body: { workdir },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /项目名称不能为空/);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
    db.close();
  }
});

test('POST /api/projects 合法 body 返回 201', async () => {
  const { app, db, token } = createTestDeps();
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-workdir-'));
  try {
    const res = await request(app, 'POST', '/api/projects', {
      token,
      body: {
        name: 'Integration Project',
        workdir,
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.json.name, 'Integration Project');
    assert.deepEqual(res.json.workdirs, [{ label: '', path: workdir }]);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
    db.close();
  }
});

test('GET /api/tasks/missing 返回 404', async () => {
  const { app, db, token } = createTestDeps();
  const res = await request(app, 'GET', '/api/tasks/missing', { token });
  assert.equal(res.status, 404);
  assert.equal(res.json.error, '任务不存在');
  db.close();
});

test('POST /api/tasks/archive 缺 projectId 返回 400', async () => {
  const { app, db, token } = createTestDeps();
  const res = await request(app, 'POST', '/api/tasks/archive', {
    token,
    body: { ids: ['task-1'] },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, '缺少 projectId');
  db.close();
});

test('GET /api/events 无 token 返回 401', async () => {
  const { app, db } = createTestDeps();
  const res = await request(app, 'GET', '/api/events');
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'Unauthorized');
  db.close();
});

test('POST /api/chats 创建全局对话会话', async () => {
  const { app, db, token } = createTestDeps();
  const res = await request(app, 'POST', '/api/chats', {
    token,
    body: { projectId: null },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.project_id, null);
  assert.equal(res.json.status, 'idle');
  assert.ok(res.json.id);
  db.close();
});

test('GET /api/chats?projectId=global 返回全局会话列表', async () => {
  const { app, db, token } = createTestDeps();
  await request(app, 'POST', '/api/chats', { token, body: { projectId: null } });
  const res = await request(app, 'GET', '/api/chats?projectId=global', { token });
  assert.equal(res.status, 200);
  assert.equal(res.json.length, 1);
  db.close();
});

test('POST /api/chats/:id/messages 接受用户消息并返回 202', async () => {
  const { app, db, token } = createTestDeps();
  const created = await request(app, 'POST', '/api/chats', {
    token,
    body: { projectId: null },
  });
  const res = await request(app, 'POST', `/api/chats/${created.json.id}/messages`, {
    token,
    body: { message: '你好' },
  });
  assert.equal(res.status, 202);
  assert.equal(res.json.status, 'running');
  db.close();
});
