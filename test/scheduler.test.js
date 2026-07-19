const assert = require('node:assert/strict');
const test = require('node:test');

const ProjectScheduler = require('../scheduler');

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('同一项目任务串行，不同项目最多并行三个', async () => {
  const started = [];
  const gates = new Map();
  const pending = [
    { id: 'a1', project_id: 'a' },
    { id: 'a2', project_id: 'a' },
    { id: 'b1', project_id: 'b' },
    { id: 'c1', project_id: 'c' },
    { id: 'd1', project_id: 'd' },
  ];
  const repo = {
    listTasks(status) {
      return status === 'pending' ? pending.filter((task) => !started.includes(task.id)) : [];
    },
  };
  const scheduler = new ProjectScheduler({
    repo,
    maxConcurrent: 3,
    runTask: async (task) => {
      started.push(task.id);
      const gate = deferred();
      gates.set(task.id, gate);
      await gate.promise;
    },
  });

  scheduler.kick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(started.sort(), ['a1', 'b1', 'c1']);
  assert.equal(started.includes('a2'), false);
  assert.equal(started.includes('d1'), false);

  gates.get('a1').resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(started.includes('a2'), true);
  assert.equal(started.includes('d1'), false);

  for (const gate of gates.values()) gate.resolve();
});

test('不同项目指向同一物理目录时串行执行', async () => {
  const started = [];
  const gates = new Map();
  const pending = [
    { id: 'x1', project_id: 'x', workdirs: [{ path: 'D:\\repo\\app' }] },
    { id: 'y1', project_id: 'y', workdirs: [{ path: 'D:/repo/app/' }] },
    { id: 'z1', project_id: 'z', workdirs: [{ path: 'D:\\repo\\other' }] },
  ];
  const repo = {
    listTasks(status) {
      return status === 'pending' ? pending.filter((task) => !started.includes(task.id)) : [];
    },
  };
  const scheduler = new ProjectScheduler({
    repo,
    maxConcurrent: 3,
    runTask: async (task) => {
      started.push(task.id);
      const gate = deferred();
      gates.set(task.id, gate);
      await gate.promise;
    },
  });

  scheduler.kick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(started.includes('x1'), true);
  assert.equal(started.includes('z1'), true);
  assert.equal(started.includes('y1'), false);

  gates.get('x1').resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(started.includes('y1'), true);

  for (const gate of gates.values()) gate.resolve();
});

test('内存不足时只放行第一个任务，恢复后再放行并发', async () => {
  const started = [];
  const gates = new Map();
  const pending = [
    { id: 'a1', project_id: 'a' },
    { id: 'b1', project_id: 'b' },
  ];
  const repo = {
    listTasks(status) {
      return status === 'pending' ? pending.filter((task) => !started.includes(task.id)) : [];
    },
  };
  let free = 512 * 1024 * 1024; // 低于 1GB 阈值
  const scheduler = new ProjectScheduler({
    repo,
    maxConcurrent: 2,
    minFreeMemMB: 1024,
    memoryRetryMs: 5,
    freeMem: () => free,
    runTask: async (task) => {
      started.push(task.id);
      const gate = deferred();
      gates.set(task.id, gate);
      await gate.promise;
    },
  });

  scheduler.kick();
  await new Promise((resolve) => setImmediate(resolve));

  // 第一个任务永远放行，但内存不足时不再放行第二个
  assert.equal(started.length, 1);
  assert.equal(started[0], 'a1');

  // 内存恢复后，延时重试会放行第二个
  free = 4096 * 1024 * 1024;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(started.includes('b1'), true);

  for (const gate of gates.values()) gate.resolve();
});

test('plan 任务启动时不锁目录，同目录可并行规划', async () => {
  const started = [];
  const gates = new Map();
  const pending = [
    { id: 'p1', project_id: 'p', is_complex: 1, workdirs: [{ path: 'D:\\repo\\app' }] },
    { id: 'q1', project_id: 'q', is_complex: 1, workdirs: [{ path: 'D:/repo/app/' }] },
  ];
  const repo = {
    listTasks(status) {
      return status === 'pending' ? pending.filter((task) => !started.includes(task.id)) : [];
    },
  };
  const scheduler = new ProjectScheduler({
    repo,
    maxConcurrent: 3,
    runTask: async (task) => {
      started.push(task.id);
      const gate = deferred();
      gates.set(task.id, gate);
      await gate.promise;
    },
  });

  scheduler.kick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(started.includes('p1'), true);
  assert.equal(started.includes('q1'), true);
  assert.equal(scheduler.workdirLock.heldCount, 0);

  for (const gate of gates.values()) gate.resolve();
});
