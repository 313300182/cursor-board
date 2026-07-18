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
