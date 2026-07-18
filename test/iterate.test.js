const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');

const TaskQueue = require('../queue');
const { isIterableStatus } = require('../queue');
const { ensureSchema, createTaskRepo, createProjectRepo } = require('../db');

function createIterateQueue() {
  const dbPath = path.join(__dirname, `iterate-${Date.now()}-${Math.random()}.db`);
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  ensureSchema(db);
  const projects = createProjectRepo(db);
  projects.createProject({
    id: 'board',
    name: '测试项目',
    type: 'normal',
    workdir: process.cwd(),
    created_at: new Date().toISOString(),
  });
  const repo = createTaskRepo(db);

  const projectsApi = {
    getProject(id) {
      return projects.getProject(id);
    },
  };
  const config = {
    security: { workdirAllowlist: [process.cwd()] },
    cursor: {
      models: {
        simpleDefault: 'luna-id',
        complexDefault: 'opus-id',
        options: [
          { id: 'luna-id', name: 'Luna' },
          { id: 'opus-id', name: 'Opus' },
        ],
      },
    },
  };
  const queue = new TaskQueue({
    repo,
    projects: projectsApi,
    config,
    broadcast() {},
  });
  queue.kick = () => {};

  return {
    queue,
    repo,
    cleanup() {
      db.close();
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    },
  };
}

test('isIterableStatus 允许 done 与 pending_deploy', () => {
  assert.equal(isIterableStatus('done'), true);
  assert.equal(isIterableStatus('pending_deploy'), true);
  assert.equal(isIterableStatus('developing'), false);
});

test('iterateTask 在同一任务上继续迭代并保留会话', () => {
  const { queue, repo, cleanup } = createIterateQueue();
  try {
    const source = repo.createTask({
      id: 'source-1',
      project_id: 'board',
      title: '登录页样式优化',
      template: 'feature',
      variables: { requirement: '优化登录页' },
      workdir: process.cwd(),
      status: 'done',
      is_complex: false,
      pipeline_mode: true,
      model_id: 'opus-id',
      prompt_rendered: 'prompt',
      session_id: 'session-abc',
      created_at: new Date().toISOString(),
    });
    repo.updateStatus(source.id, {
      status: 'done',
      session_id: 'session-abc',
      result_summary: '第一轮完成摘要',
      finished_at: new Date().toISOString(),
    });
    repo.addEvent(source.id, 'log_chunk', { chunk: '第一轮输出', stream: 'message' });

    const iteration = queue.iterateTask(source.id, {
      requirement: '按钮颜色改成蓝色，间距再紧凑一些',
    });

    assert.equal(iteration.id, source.id);
    assert.equal(iteration.status, 'pending');
    assert.equal(iteration.session_id, 'session-abc');
    assert.equal(iteration.result_summary, null);
    assert.equal(iteration.deploy_completed, false);
    assert.match(iteration.prompt_rendered, /按钮颜色改成蓝色/);
    assert.equal(iteration.variables.requirement, '按钮颜色改成蓝色，间距再紧凑一些');

    const events = repo.listEvents(source.id);
    assert.ok(events.some((event) => event.type === 'iteration_round' && event.payload.round === 1));
    assert.ok(events.some((event) => event.type === 'iteration_start' && event.payload.round === 2));
    assert.equal(events.filter((event) => event.type === 'iteration_round')[0].payload.summary, '第一轮完成摘要');
  } finally {
    cleanup();
  }
});

test('iterateTask 支持待部署任务继续迭代', () => {
  const { queue, repo, cleanup } = createIterateQueue();
  try {
    const source = repo.createTask({
      id: 'deploy-1',
      project_id: 'board',
      title: '流水线任务',
      template: 'feature',
      variables: { requirement: '新功能' },
      workdir: process.cwd(),
      status: 'pending_deploy',
      is_complex: false,
      pipeline_mode: true,
      model_id: 'opus-id',
      prompt_rendered: 'prompt',
      session_id: 'session-deploy',
      created_at: new Date().toISOString(),
    });
    repo.updateStatus(source.id, {
      status: 'pending_deploy',
      result_summary: '开发测试已完成，等待部署',
      session_id: 'session-deploy',
    });

    const iteration = queue.iterateTask(source.id, {
      requirement: '再补一个边界校验',
    });

    assert.equal(iteration.id, source.id);
    assert.equal(iteration.status, 'pending');
    assert.equal(iteration.session_id, 'session-deploy');
  } finally {
    cleanup();
  }
});

test('iterateTask 默认启用 Git 提交并支持单独控制 push', () => {
  const dbPath = path.join(__dirname, `iterate-git-${Date.now()}-${Math.random()}.db`);
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  ensureSchema(db);
  const projects = createProjectRepo(db);
  projects.createProject({
    id: 'board',
    name: 'Git 项目',
    type: 'normal',
    workdir: process.cwd(),
    git_enabled: true,
    git_push: false,
    created_at: new Date().toISOString(),
  });
  const repo = createTaskRepo(db);
  const queue = new TaskQueue({
    repo,
    projects: { getProject: (id) => projects.getProject(id) },
    config: {
      security: { workdirAllowlist: [process.cwd()] },
      cursor: { models: { simpleDefault: 'luna-id', complexDefault: 'opus-id', options: [] } },
    },
    broadcast() {},
  });
  queue.kick = () => {};

  try {
    const source = repo.createTask({
      id: 'git-source',
      project_id: 'board',
      title: '流水线任务',
      template: 'feature',
      variables: { requirement: '初版' },
      workdir: process.cwd(),
      status: 'done',
      is_complex: false,
      pipeline_mode: true,
      git_commit: false,
      model_id: 'opus-id',
      prompt_rendered: 'prompt',
      created_at: new Date().toISOString(),
    });
    repo.updateStatus(source.id, { status: 'done', finished_at: new Date().toISOString() });

    const defaulted = queue.iterateTask(source.id, { requirement: '继续优化' });
    assert.equal(defaulted.git_commit, true);
    repo.updateStatus(source.id, { status: 'done', finished_at: new Date().toISOString() });

    const withoutPush = queue.iterateTask(source.id, {
      requirement: '关闭 push',
      gitCommit: true,
      gitPush: false,
    });
    assert.equal(withoutPush.git_commit, true);
    assert.equal(withoutPush.variables.__git_push, false);
    repo.updateStatus(source.id, { status: 'done', finished_at: new Date().toISOString() });

    const withPush = queue.iterateTask(source.id, {
      requirement: '开启 push',
      gitCommit: true,
      gitPush: true,
    });
    assert.equal(withPush.git_commit, true);
    assert.equal(withPush.variables.__git_push, true);
  } finally {
    db.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
});

test('iterateTask 拒绝非可迭代状态与空需求', () => {
  const { queue, repo, cleanup } = createIterateQueue();
  try {
    const pending = repo.createTask({
      id: 'pending-1',
      project_id: 'board',
      title: '进行中',
      template: 'general',
      variables: { description: '测试' },
      workdir: process.cwd(),
      status: 'pending',
      is_complex: false,
      pipeline_mode: false,
      model_id: 'luna-id',
      prompt_rendered: 'prompt',
      created_at: new Date().toISOString(),
    });

    assert.throws(
      () => queue.iterateTask(pending.id, { requirement: '继续优化' }),
      /仅已完成或待部署任务可发起迭代/,
    );
    assert.throws(
      () => queue.iterateTask(pending.id.replace('pending', 'missing'), { requirement: 'x' }),
      /任务不存在/,
    );

    repo.updateStatus(pending.id, { status: 'done', finished_at: new Date().toISOString() });
    assert.throws(
      () => queue.iterateTask(pending.id, { requirement: '   ' }),
      /请填写优化需求/,
    );
  } finally {
    cleanup();
  }
});
