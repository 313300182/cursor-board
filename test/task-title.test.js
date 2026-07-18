const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const TaskQueue = require('../queue');
const { ensureSchema, createProjectRepo, createTaskRepo } = require('../db');
const { deriveTaskTitle, getTemplate } = require('../templates');

function createTitleQueue() {
  const db = new Database(':memory:');
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
  const broadcasts = [];
  const queue = new TaskQueue({
    repo,
    projects: {
      getProject(id) {
        return projects.getProject(id);
      },
    },
    config: {
      security: { workdirAllowlist: [process.cwd()] },
      cursor: { models: { simpleDefault: 'luna-id', complexDefault: 'opus-id', options: [] } },
    },
    broadcast(type, payload) {
      broadcasts.push({ type, payload });
    },
  });
  return { queue, repo, broadcasts };
}

test('deriveTaskTitle 长需求使用待总结占位', () => {
  const template = getTemplate('iteration');
  const requirement = '任务标题优化还是没完成，不是让你默认取优化需求这一长串，我想一开始可以是这样显示';
  assert.equal(
    deriveTaskTitle(template, { requirement }, ''),
    '功能优化迭代 · 待总结',
  );
});

test('applySuggestedTitle 更新标题并广播', () => {
  const { queue, repo, broadcasts } = createTitleQueue();
  const task = repo.createTask({
    id: 'task-1',
    project_id: 'board',
    title: '功能优化迭代 · 待总结',
    template: 'iteration',
    variables: { requirement: '优化标题逻辑' },
    workdir: process.cwd(),
    status: 'developing',
    is_complex: false,
    pipeline_mode: true,
    model_id: 'luna-id',
    prompt_rendered: 'prompt',
    created_at: new Date().toISOString(),
  });

  const updated = queue.applySuggestedTitle(task, 'AI 总结任务标题');
  assert.equal(updated.title, 'AI 总结任务标题');
  assert.equal(broadcasts.at(-1).type, 'task:status');
  assert.equal(broadcasts.at(-1).payload.title, 'AI 总结任务标题');
});

test('updateTitle 忽略空标题', () => {
  const { queue, repo } = createTitleQueue();
  const task = repo.createTask({
    id: 'task-2',
    project_id: 'board',
    title: '原任务标题',
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

  const updated = queue.applySuggestedTitle(task, '   ');
  assert.equal(updated.title, '原任务标题');
});
