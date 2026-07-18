const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const { ensureSchema, createProjectRepo, createTaskRepo } = require('../db');
const TaskQueue = require('../queue');

test('流水线测试通过后停在待部署，等待项目部署按钮', async () => {
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
    created_at: new Date().toISOString(),
  });
  const task = repo.createTask({
    id: 'pipeline-task',
    project_id: 'board',
    title: '任务',
    template: 'general',
    variables: {},
    attachments: [],
    workdir: process.cwd(),
    status: 'pending',
    is_complex: false,
    pipeline_mode: true,
    model_id: 'model',
    prompt_rendered: 'test',
    created_at: new Date().toISOString(),
  });
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
    async runTask() {
      return {
        awaitingDeploy: true,
        resultSummary: '开发和测试完成',
      };
    },
  };

  await queue.runTask(task);

  const updated = repo.getTask(task.id);
  assert.equal(updated.status, 'pending_deploy');
  assert.equal(updated.pipeline_phase, 'pending_deploy');
  assert.equal(updated.deploy_completed, false);
  assert.equal(updated.result_summary, '开发和测试完成');
  db.close();
});
