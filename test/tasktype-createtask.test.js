const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('path');
const Database = require('better-sqlite3');

const {
  ensureSchema,
  createProjectRepo,
  createTaskRepo,
  createProjectTemplateRepo,
} = require('../db');
const { createTemplateService } = require('../template-service');
const TaskQueue = require('../queue');

function setup() {
  const db = new Database(':memory:');
  ensureSchema(db);
  const projects = createProjectRepo(db);
  const repo = createTaskRepo(db);
  const projectTemplates = createProjectTemplateRepo(db);
  const templateService = createTemplateService({ projectTemplates });
  projects.createProject({
    id: 'p1',
    name: 'P1',
    type: 'normal',
    workdir: process.cwd(),
    git_enabled: true,
    created_at: new Date().toISOString(),
  });
  const config = {
    security: { workdirAllowlist: [process.cwd(), path.dirname(process.cwd())] },
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
    repo, projects, config, broadcast: () => {}, templateService, projectTemplates,
  });
  return { db, projects, repo, projectTemplates, queue };
}

test('私有模板 defaults 驱动流水线与 Git，并透传 source_schedule_id', () => {
  const { db, projectTemplates, queue, repo } = setup();
  projectTemplates.create({
    id: 'pt-fin',
    project_id: 'p1',
    name: '金融分析',
    prompt: '分析 {{data}}',
    variables: [{ name: 'data', required: true }],
    defaults: { pipeline: true, git: true, complex: false },
  });

  const task = queue.createTask({
    projectId: 'p1',
    template: 'pt-fin',
    variables: { data: '沪深300' },
    sourceScheduleId: 'sched-1',
  });

  const saved = repo.getTask(task.id);
  assert.equal(saved.template, 'pt-fin');
  assert.equal(saved.pipeline_mode, true);
  assert.equal(saved.git_commit, true);
  assert.equal(saved.source_schedule_id, 'sched-1');
  assert.match(saved.prompt_rendered, /沪深300/);
  db.close();
});

test('分析型私有模板（defaults 关闭流水线/Git）不进流水线也不提交', () => {
  const { db, projectTemplates, queue, repo } = setup();
  projectTemplates.create({
    id: 'pt-report',
    project_id: 'p1',
    name: '每日报告',
    prompt: '整理 {{topic}}',
    variables: [{ name: 'topic', required: true }],
    defaults: { pipeline: false, git: false, complex: false },
  });

  const task = queue.createTask({
    projectId: 'p1',
    template: 'pt-report',
    variables: { topic: '市场情绪' },
  });

  const saved = repo.getTask(task.id);
  assert.equal(saved.pipeline_mode, false);
  assert.equal(saved.git_commit, false);
  db.close();
});

test('私有模板的 __requirement 追加到提示词末尾并可作标题来源', () => {
  const { db, projectTemplates, queue, repo } = setup();
  projectTemplates.create({
    id: 'pt-mcp',
    project_id: 'p1',
    name: '数据处理',
    prompt: '调用 MySQL MCP 处理数据。',
    variables: [],
    defaults: { pipeline: false, git: false, complex: false },
  });

  const task = queue.createTask({
    projectId: 'p1',
    template: 'pt-mcp',
    variables: { __requirement: '统计上周各仓库出库量' },
  });

  const saved = repo.getTask(task.id);
  assert.match(saved.prompt_rendered, /调用 MySQL MCP 处理数据。/);
  assert.match(saved.prompt_rendered, /补充需求：\n统计上周各仓库出库量/);
  assert.match(saved.title, /统计上周各仓库出库量/);
  db.close();
});

test('提示词已显式包含 {{__requirement}} 时不重复追加', () => {
  const { db, projectTemplates, queue, repo } = setup();
  projectTemplates.create({
    id: 'pt-inline',
    project_id: 'p1',
    name: '内联需求',
    prompt: '处理：{{__requirement}} 结束',
    variables: [],
    defaults: { pipeline: false, git: false, complex: false },
  });

  const task = queue.createTask({
    projectId: 'p1',
    template: 'pt-inline',
    variables: { __requirement: '导出报表' },
  });

  const saved = repo.getTask(task.id);
  assert.equal(saved.prompt_rendered, '处理：导出报表 结束');
  assert.doesNotMatch(saved.prompt_rendered, /补充需求：/);
  db.close();
});

test('项目 enabled_templates 持久化与读取', () => {
  const { db, projects } = setup();
  assert.equal(projects.getProject('p1').enabled_templates, null);
  projects.updateEnabledTemplates('p1', ['feature', 'general']);
  assert.deepEqual(projects.getProject('p1').enabled_templates, ['feature', 'general']);
  db.close();
});
