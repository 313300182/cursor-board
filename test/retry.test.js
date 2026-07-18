const assert = require('node:assert/strict');
const test = require('node:test');

const TaskQueue = require('../queue');

test('retryTask 保存失败原因供修复阶段使用', () => {
  const { queue, events } = createRetryQueue();
  queue.repo.tasks.set('failed-1', {
    id: 'failed-1',
    status: 'failed',
    error_message: 'Git 提交失败: nothing to commit',
    variables: { requirement: '加功能' },
    session_id: 'session-old',
  });

  const updated = queue.retryTask('failed-1');
  assert.equal(updated.status, 'pending');
  assert.equal(updated.error_message, null);
  assert.equal(updated.variables.__retry_error, 'Git 提交失败: nothing to commit');
  assert.equal(events.at(-1).payload.reason, 'retry');
  assert.equal(events.at(-1).payload.retryError, 'Git 提交失败: nothing to commit');
});

test('retryTask 拒绝非失败状态', () => {
  const { queue } = createRetryQueue();
  queue.repo.tasks.set('running-1', { id: 'running-1', status: 'running', variables: {} });
  assert.throws(() => queue.retryTask('running-1'), /failed \/ needs_human/);
});

test('retryTask 无 error_message 时不写入 __retry_error', () => {
  const { queue } = createRetryQueue();
  queue.repo.tasks.set('failed-2', {
    id: 'failed-2',
    status: 'needs_human',
    error_message: '',
    variables: { foo: 'bar' },
  });

  const updated = queue.retryTask('failed-2');
  assert.equal(updated.variables.__retry_error, undefined);
  assert.equal(updated.variables.foo, 'bar');
});

function createRetryQueue() {
  const tasks = new Map();
  const events = [];
  const repo = {
    tasks,
    getTask(id) {
      return tasks.get(id) || null;
    },
    updateForIteration(id, patch) {
      const current = tasks.get(id);
      if (!current) throw new Error('任务不存在');
      const next = { ...current, ...patch };
      if (patch.variables) next.variables = patch.variables;
      tasks.set(id, next);
      return next;
    },
    addEvent(taskId, type, payload) {
      events.push({ taskId, type, payload });
    },
    appendPendingQueuePosition(id) {
      const current = tasks.get(id);
      if (!current) throw new Error('任务不存在');
      const next = { ...current, queue_position: 1 };
      tasks.set(id, next);
      return next;
    },
  };
  const queue = new TaskQueue({
    repo,
    projects: {},
    config: {},
    broadcast() {},
  });
  queue.scheduler.kick = () => {};
  queue.repo = repo;
  return { queue, repo, events };
}
