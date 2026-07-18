const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const { ensureSchema, createProjectRepo, createTaskRepo } = require('../db');
const TaskQueue = require('../queue');

function createFixture() {
  const db = new Database(':memory:');
  ensureSchema(db);
  const projects = createProjectRepo(db);
  projects.ensureMachineProject();
  projects.createProject({
    id: 'proj-a',
    name: '项目 A',
    type: 'normal',
    workdirs: [{ label: '', path: process.cwd() }],
    created_at: '2026-01-01T00:00:00.000Z',
  });
  const repo = createTaskRepo(db);
  return { db, repo, projects };
}

function createPendingTask(repo, patch = {}) {
  return repo.createTask({
    id: patch.id,
    project_id: patch.project_id || 'proj-a',
    title: patch.title || '待执行任务',
    template: 'general',
    variables: { description: patch.title || '待执行任务' },
    workdir: process.cwd(),
    workdirs: [{ label: '', path: process.cwd() }],
    status: 'pending',
    is_complex: false,
    pipeline_mode: false,
    git_commit: false,
    prompt_rendered: 'prompt',
    created_at: patch.created_at || new Date().toISOString(),
  });
}

test('新建 pending 任务自动追加 queue_position', () => {
  const { repo } = createFixture();
  const first = createPendingTask(repo, { id: 't1', title: '第一个', created_at: '2026-01-01T00:00:00.000Z' });
  const second = createPendingTask(repo, { id: 't2', title: '第二个', created_at: '2026-01-02T00:00:00.000Z' });
  assert.equal(first.queue_position, 1);
  assert.equal(second.queue_position, 2);
});

test('listTasks(pending) 按 queue_position 排序', () => {
  const { repo } = createFixture();
  createPendingTask(repo, { id: 't1', created_at: '2026-01-01T00:00:00.000Z' });
  createPendingTask(repo, { id: 't2', created_at: '2026-01-02T00:00:00.000Z' });
  repo.reorderPendingTasks('proj-a', ['t2', 't1']);
  const pending = repo.listTasks('pending', 'proj-a');
  assert.deepEqual(pending.map((task) => task.id), ['t2', 't1']);
});

test('reorderPendingTasks 要求完整 pending 列表', () => {
  const { repo } = createFixture();
  createPendingTask(repo, { id: 't1' });
  createPendingTask(repo, { id: 't2' });
  assert.throws(
    () => repo.reorderPendingTasks('proj-a', ['t2']),
    /任务列表已变化/,
  );
});

test('TaskQueue.reorderPendingTasks 广播并触发调度', () => {
  const { repo, projects } = createFixture();
  createPendingTask(repo, { id: 't1' });
  createPendingTask(repo, { id: 't2' });
  const events = [];
  let kicked = 0;
  const queue = new TaskQueue({
    repo,
    projects,
    config: { security: { workdirAllowlist: [process.cwd()] }, queue: { maxConcurrent: 3 } },
    broadcast(type, payload) {
      events.push({ type, payload });
    },
  });
  queue.scheduler.kick = () => { kicked += 1; };

  const tasks = queue.reorderPendingTasks('proj-a', ['t2', 't1']);
  assert.deepEqual(tasks.map((task) => task.id), ['t2', 't1']);
  assert.equal(events.some((event) => event.type === 'queue:reordered'), true);
  assert.equal(kicked, 1);
});
