const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  ensureSchema,
  createProjectRepo,
  createProjectTemplateRepo,
  createScheduleRepo,
} = require('../db');

function setup() {
  const db = new Database(':memory:');
  ensureSchema(db);
  const projects = createProjectRepo(db);
  projects.createProject({
    id: 'p1',
    name: 'P1',
    type: 'normal',
    workdir: 'D:\\code\\p1',
    created_at: new Date().toISOString(),
  });
  return {
    db,
    projects,
    projectTemplates: createProjectTemplateRepo(db),
    schedules: createScheduleRepo(db),
  };
}

test('project_templates 支持增删改查', () => {
  const { db, projectTemplates } = setup();
  const created = projectTemplates.create({
    id: 'pt1',
    project_id: 'p1',
    name: '金融分析',
    category: '分析',
    prompt: '分析 {{data}}',
    variables: [{ name: 'data', required: true }],
    defaults: { pipeline: false, git: false, complex: false },
  });
  assert.equal(created.scope, 'project');
  assert.equal(created.variables.length, 1);
  assert.equal(projectTemplates.list('p1').length, 1);

  const updated = projectTemplates.update('pt1', { name: '金融分析V2', defaults: { pipeline: true, git: true } });
  assert.equal(updated.name, '金融分析V2');
  assert.equal(updated.defaults.pipeline, true);

  projectTemplates.delete('pt1');
  assert.equal(projectTemplates.list('p1').length, 0);
  assert.equal(projectTemplates.get('pt1'), null);
  db.close();
});

test('schedules CRUD 与 listAllEnabledCron / recordRun', () => {
  const { db, schedules } = setup();
  const cron = schedules.create({
    id: 's-cron',
    project_id: 'p1',
    template_id: 'general',
    name: '盘后分析',
    variables: { note: 'x' },
    trigger: 'cron',
    cron_expr: '30 15 * * 1-5',
  });
  assert.equal(cron.trigger, 'cron');
  assert.equal(cron.enabled, true);
  assert.deepEqual(cron.variables, { note: 'x' });

  const manual = schedules.create({
    id: 's-manual',
    project_id: 'p1',
    template_id: 'general',
    name: '盘中分析',
    trigger: 'manual',
  });
  assert.equal(manual.trigger, 'manual');

  const disabledCron = schedules.create({
    id: 's-off',
    project_id: 'p1',
    template_id: 'general',
    name: '停用的定时',
    trigger: 'cron',
    cron_expr: '0 9 * * *',
    enabled: false,
  });
  assert.equal(disabledCron.enabled, false);

  const enabledCron = schedules.listAllEnabledCron();
  assert.equal(enabledCron.length, 1);
  assert.equal(enabledCron[0].id, 's-cron');

  assert.equal(schedules.list('p1').length, 3);

  schedules.update('s-manual', { name: '盘中分析V2', trigger: 'cron', cron_expr: '* * * * *' });
  assert.equal(schedules.get('s-manual').trigger, 'cron');
  assert.equal(schedules.listAllEnabledCron().length, 2);

  schedules.recordRun('s-cron', {
    last_run_at: '2026-07-19T07:30:00.000Z',
    last_task_id: 'task-1',
    last_status: 'ok',
    next_run_at: '2026-07-20T07:30:00.000Z',
  });
  const afterRun = schedules.get('s-cron');
  assert.equal(afterRun.last_task_id, 'task-1');
  assert.equal(afterRun.last_status, 'ok');
  assert.equal(afterRun.next_run_at, '2026-07-20T07:30:00.000Z');

  schedules.delete('s-off');
  assert.equal(schedules.list('p1').length, 2);
  db.close();
});

test('schedules 保存并读回工作目录，更新可修改', () => {
  const { db, schedules } = setup();
  const created = schedules.create({
    id: 's-wd',
    project_id: 'p1',
    template_id: 'general',
    name: '多目录任务',
    trigger: 'manual',
    workdirs: [{ label: '后端', path: 'D:/repo/back' }, 'D:/repo/front'],
  });
  assert.deepEqual(created.workdirs.map((w) => w.path), ['D:/repo/back', 'D:/repo/front']);
  assert.equal(created.workdirs[0].label, '后端');

  schedules.update('s-wd', { workdirs: ['D:/repo/only'] });
  assert.deepEqual(schedules.get('s-wd').workdirs.map((w) => w.path), ['D:/repo/only']);

  schedules.update('s-wd', { name: '改名不动目录' });
  assert.deepEqual(schedules.get('s-wd').workdirs.map((w) => w.path), ['D:/repo/only']);
  db.close();
});
