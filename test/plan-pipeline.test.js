const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const { ensureSchema, createProjectRepo, createTaskRepo } = require('../db');
const TaskQueue = require('../queue');

test('Plan 批准后流水线任务进入开发并继续测试', async () => {
  const db = new Database(':memory:');
  ensureSchema(db);
  const projects = createProjectRepo(db);
  const repo = createTaskRepo(db);
  projects.createProject({
    id: 'board',
    name: 'Board',
    type: 'normal',
    workdir: process.cwd(),
    created_at: new Date().toISOString(),
  });
  const task = repo.createTask({
    id: 'plan-pipeline-task',
    project_id: 'board',
    title: 'Plan 开发',
    template: 'feature',
    variables: { requirement: '新功能' },
    attachments: [],
    workdir: process.cwd(),
    status: 'pending',
    is_complex: true,
    pipeline_mode: true,
    git_commit: false,
    model_id: 'model',
    prompt_rendered: 'test',
    created_at: new Date().toISOString(),
  });
  let planModePassed = false;
  const queue = new TaskQueue({
    repo,
    projects,
    config: {
      queue: { maxConcurrent: 1 },
      security: { workdirAllowlist: [process.cwd()] },
      cursor: { models: { options: [] } },
    },
    broadcast() {},
  });
  queue.runner = {
    async runTask(options) {
      planModePassed = options.planMode === true && options.mode === 'pipeline';
      return {
        awaitingDeploy: true,
        resultSummary: 'Plan、开发、测试完成',
      };
    },
  };

  await queue.runTask(task);

  assert.equal(planModePassed, true);
  const updated = repo.getTask(task.id);
  assert.equal(updated.status, 'pending_deploy');
  db.close();
});

test('Plan 批准后状态切到 developing 并标记 dev 阶段', async () => {
  const db = new Database(':memory:');
  ensureSchema(db);
  const projects = createProjectRepo(db);
  const repo = createTaskRepo(db);
  projects.createProject({
    id: 'board',
    name: 'Board',
    type: 'normal',
    workdir: process.cwd(),
    created_at: new Date().toISOString(),
  });
  const task = repo.createTask({
    id: 'plan-task',
    project_id: 'board',
    title: 'Plan 任务',
    template: 'general',
    variables: {},
    workdir: process.cwd(),
    status: 'pending_approval',
    is_complex: true,
    pipeline_mode: true,
    git_commit: false,
    model_id: 'model',
    prompt_rendered: 'test',
    created_at: new Date().toISOString(),
  });
  repo.setInteraction(task.id, { type: 'plan', plan: '步骤一' });
  const queue = new TaskQueue({
    repo,
    projects,
    config: {
      queue: { maxConcurrent: 1 },
      security: { workdirAllowlist: [process.cwd()] },
      cursor: { models: { options: [] } },
    },
    broadcast() {},
  });
  queue.runner = {
    async submitInteraction() {},
  };

  const updated = await queue.submitInteraction(task.id, { accepted: true });

  assert.equal(updated.status, 'developing');
  assert.equal(updated.pipeline_phase, 'dev');
  db.close();
});
