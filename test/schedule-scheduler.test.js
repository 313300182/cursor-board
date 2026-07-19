const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const { ensureSchema, createProjectRepo, createScheduleRepo } = require('../db');
const ScheduleScheduler = require('../schedule-scheduler');

function setup() {
  const db = new Database(':memory:');
  ensureSchema(db);
  const projects = createProjectRepo(db);
  projects.createProject({
    id: 'p1', name: 'P1', type: 'normal', workdir: 'D:\\code\\p1', created_at: new Date().toISOString(),
  });
  const schedules = createScheduleRepo(db);
  const created = [];
  const queue = {
    createTask(input) {
      const task = { id: `task-${created.length + 1}`, ...input };
      created.push(task);
      return task;
    },
  };
  const scheduler = new ScheduleScheduler({ scheduleRepo: schedules, projects, queue, broadcast: () => {} });
  return { db, schedules, scheduler, created };
}

test('computeNextRun 校验 cron 表达式', () => {
  const { db, scheduler } = setup();
  assert.equal(scheduler.isValidCron('30 15 * * 1-5'), true);
  assert.equal(scheduler.isValidCron('not-a-cron'), false);
  assert.ok(scheduler.computeNextRun('30 15 * * 1-5'));
  scheduler.stop();
  db.close();
});

test('triggerNow 立即入队并透传 sourceScheduleId 与记录结果', () => {
  const { db, schedules, scheduler, created } = setup();
  schedules.create({
    id: 's1', project_id: 'p1', template_id: 'general', name: '盘中分析', trigger: 'manual', variables: { note: 'x' },
  });
  const result = scheduler.triggerNow('s1');
  assert.equal(created.length, 1);
  assert.equal(created[0].sourceScheduleId, 's1');
  assert.equal(created[0].projectId, 'p1');
  assert.equal(created[0].template, 'general');
  assert.equal(result.error, null);
  const after = schedules.get('s1');
  assert.equal(after.last_task_id, created[0].id);
  assert.equal(after.last_status, 'ok');
  scheduler.stop();
  db.close();
});

test('触发失败时记录失败状态且不抛出', () => {
  const { db, schedules } = setup();
  const failingQueue = {
    createTask() { throw new Error('缺少必填变量: data'); },
  };
  const scheduler = new ScheduleScheduler({ scheduleRepo: schedules, projects: {}, queue: failingQueue, broadcast: () => {} });
  schedules.create({ id: 's1', project_id: 'p1', template_id: 'general', name: '会失败', trigger: 'manual' });
  const result = scheduler.triggerNow('s1');
  assert.match(result.error, /缺少必填变量/);
  assert.match(schedules.get('s1').last_status, /失败/);
  scheduler.stop();
  db.close();
});

test('register/reconcile 处理 cron 启停与 next_run', () => {
  const { db, schedules, scheduler } = setup();
  const cron = schedules.create({
    id: 's1', project_id: 'p1', template_id: 'general', name: '定时', trigger: 'cron', cron_expr: '30 15 * * 1-5',
  });
  scheduler.register(cron);
  assert.ok(scheduler.jobs.has('s1'));
  assert.ok(schedules.get('s1').next_run_at);

  schedules.update('s1', { enabled: false });
  scheduler.reconcileById('s1');
  assert.equal(scheduler.jobs.has('s1'), false);
  assert.equal(schedules.get('s1').next_run_at, null);
  scheduler.stop();
  db.close();
});

test('start 注册所有启用的 cron 常驻任务', () => {
  const { db, schedules, scheduler } = setup();
  schedules.create({ id: 'c1', project_id: 'p1', template_id: 'general', name: 'A', trigger: 'cron', cron_expr: '0 9 * * *' });
  schedules.create({ id: 'c2', project_id: 'p1', template_id: 'general', name: 'B', trigger: 'cron', cron_expr: '0 15 * * *' });
  schedules.create({ id: 'm1', project_id: 'p1', template_id: 'general', name: 'C', trigger: 'manual' });
  const count = scheduler.start();
  assert.equal(count, 2);
  scheduler.stop();
  db.close();
});

test('cron 到点自动入队（每秒触发）', async () => {
  const { db, schedules, scheduler, created } = setup();
  const cron = schedules.create({
    id: 's1', project_id: 'p1', template_id: 'general', name: '每秒', trigger: 'cron', cron_expr: '* * * * * *',
  });
  scheduler.register(cron);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  scheduler.stop();
  assert.ok(created.length >= 1, `expected >=1 fired task, got ${created.length}`);
  assert.equal(created[0].sourceScheduleId, 's1');
  db.close();
});
