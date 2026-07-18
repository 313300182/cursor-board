const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');

const TaskQueue = require('../queue');
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

test('iterateTask 基于已完成任务创建迭代任务并继承设置', () => {
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
      finished_at: new Date().toISOString(),
    });

    const iteration = queue.iterateTask(source.id, {
      requirement: '按钮颜色改成蓝色，间距再紧凑一些',
    });

    assert.equal(iteration.template, 'iteration');
    assert.equal(iteration.parent_task_id, source.id);
    assert.equal(iteration.model_id, 'opus-id');
    assert.equal(iteration.pipeline_mode, true);
    assert.equal(iteration.is_complex, false);
    assert.equal(iteration.workdir, source.workdir);
    assert.equal(iteration.variables.requirement, '按钮颜色改成蓝色，间距再紧凑一些');
    assert.match(iteration.title, /登录页样式优化 · 迭代/);
    assert.match(iteration.prompt_rendered, /按钮颜色改成蓝色/);
  } finally {
    cleanup();
  }
});

test('iterateTask 拒绝非 done 状态与空需求', () => {
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
      /仅已完成任务可发起迭代/,
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
