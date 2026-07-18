const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const { ensureSchema, createProjectRepo, createTaskRepo } = require('../db');
const TaskQueue = require('../queue');

test('流水线在测试通过后执行 Git 提交再进入待部署', async () => {
  const db = new Database(':memory:');
  ensureSchema(db);
  const projects = createProjectRepo(db);
  const repo = createTaskRepo(db);
  projects.createProject({
    id: 'board',
    name: 'Board',
    type: 'normal',
    workdir: process.cwd(),
    deploy_command: 'npm run deploy',
    git_enabled: true,
    git_push: false,
    created_at: new Date().toISOString(),
  });
  const task = repo.createTask({
    id: 'pipeline-task',
    project_id: 'board',
    title: 'Git 任务',
    template: 'general',
    variables: {},
    attachments: [],
    workdir: process.cwd(),
    status: 'pending',
    is_complex: false,
    pipeline_mode: true,
    git_commit: true,
    model_id: 'model',
    prompt_rendered: 'test',
    created_at: new Date().toISOString(),
  });
  let gitCommitCalled = false;
  const queue = new TaskQueue({
    repo,
    projects,
    config: {
      queue: { maxConcurrent: 1 },
      cursor: { models: { options: [] } },
      security: { workdirAllowlist: [process.cwd()] },
    },
    broadcast() {},
  });
  queue.runner = {
    async runTask(options) {
      gitCommitCalled = options.gitCommit;
      assert.equal(options.gitPush, false);
      assert.equal(options.taskTitle, 'Git 任务');
      return {
        awaitingDeploy: true,
        resultSummary: '开发、测试与 Git 提交完成',
      };
    },
  };

  await queue.runTask(task);

  assert.equal(gitCommitCalled, true);
  const updated = repo.getTask(task.id);
  assert.equal(updated.status, 'pending_deploy');
  assert.equal(updated.pipeline_phase, 'pending_deploy');
  assert.equal(updated.result_summary, '开发、测试与 Git 提交完成');
  db.close();
});

test('未启用 Git 或任务未勾选时不传递 gitCommit', async () => {
  const db = new Database(':memory:');
  ensureSchema(db);
  const projects = createProjectRepo(db);
  const repo = createTaskRepo(db);
  projects.createProject({
    id: 'board',
    name: 'Board',
    type: 'normal',
    workdir: process.cwd(),
    git_enabled: true,
    created_at: new Date().toISOString(),
  });
  const task = repo.createTask({
    id: 'pipeline-task',
    project_id: 'board',
    title: '无提交',
    template: 'general',
    variables: {},
    workdir: process.cwd(),
    status: 'pending',
    is_complex: false,
    pipeline_mode: true,
    git_commit: false,
    model_id: 'model',
    prompt_rendered: 'test',
    created_at: new Date().toISOString(),
  });
  let gitCommitCalled = null;
  const queue = new TaskQueue({
    repo,
    projects,
    config: {
      queue: { maxConcurrent: 1 },
      security: { workdirAllowlist: [process.cwd()] },
    },
    broadcast() {},
  });
  queue.runner = {
    async runTask(options) {
      gitCommitCalled = options.gitCommit;
      return { awaitingDeploy: true, resultSummary: 'ok' };
    },
  };

  await queue.runTask(task);
  assert.equal(gitCommitCalled, false);
  db.close();
});
