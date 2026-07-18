const assert = require('node:assert/strict');
const test = require('node:test');

const AcpRunner = require('../acp-runner');
const TaskQueue = require('../queue');
const {
  isActiveTaskStatus,
  buildSteerPrompt,
} = require('../pipeline');

test('isActiveTaskStatus 识别可干预的运行状态', () => {
  assert.equal(isActiveTaskStatus('developing'), true);
  assert.equal(isActiveTaskStatus('testing'), true);
  assert.equal(isActiveTaskStatus('committing'), true);
  assert.equal(isActiveTaskStatus('running'), true);
  assert.equal(isActiveTaskStatus('done'), false);
  assert.equal(isActiveTaskStatus('pending'), false);
});

test('buildSteerPrompt 包含用户说明', () => {
  assert.match(buildSteerPrompt('跳过 mvn test'), /跳过 mvn test/);
  assert.match(buildSteerPrompt('跳过 mvn test'), /用户补充说明/);
});

test('shouldSkipTestFromMessage 识别跳过测试意图', () => {
  const { shouldSkipTestFromMessage } = require('../pipeline');
  assert.equal(shouldSkipTestFromMessage('跳过 mvn test'), false);
  assert.equal(shouldSkipTestFromMessage('跳过测试'), true);
  assert.equal(shouldSkipTestFromMessage('不要跑测试了'), true);
  assert.equal(shouldSkipTestFromMessage('skip test'), true);
});

test('AcpRunner.cancelTask 对未运行任务报错', () => {
  const runner = new AcpRunner({ security: {} });
  assert.throws(() => runner.cancelTask('missing'), /未在运行中/);
});

test('AcpRunner.steerTask 对未运行任务报错', () => {
  const runner = new AcpRunner({ security: {} });
  assert.throws(() => runner.steerTask('missing', 'hello'), /未在运行中/);
});

test('TaskQueue.cancelTask 委托 runner 终止', () => {
  let cancelled = false;
  const { queue } = createControlQueue({
    runner: {
      isTaskRunning: () => true,
      cancelTask(id) {
        cancelled = id;
      },
    },
  });

  queue.cancelTask('task-1');
  assert.equal(cancelled, 'task-1');
});

test('TaskQueue.sendTaskMessage 委托 runner 注入说明', () => {
  let steered;
  const { queue } = createControlQueue({
    runner: {
      isTaskRunning: () => true,
      steerTask(id, message, options) {
        steered = { id, message, options };
        return { queued: true, skipTest: false };
      },
    },
  });

  queue.sendTaskMessage('task-1', { message: '改这里' });
  assert.deepEqual(steered, {
    id: 'task-1',
    message: '改这里',
    options: { skipTest: false },
  });
});

test('TaskQueue.sendTaskMessage 支持 skipTest', () => {
  let steered;
  const { queue } = createControlQueue({
    runner: {
      isTaskRunning: () => true,
      steerTask(id, message, options) {
        steered = { id, message, options };
        return { queued: false, skipTest: true };
      },
    },
  });

  queue.sendTaskMessage('task-1', { skipTest: true });
  assert.equal(steered.options.skipTest, true);
});

function createControlQueue({ runner }) {
  const events = [];
  const repo = {
    getTask(id) {
      return { id, status: 'developing' };
    },
    addEvent(taskId, type, payload) {
      events.push({ taskId, type, payload });
    },
  };
  const queue = new TaskQueue({
    repo,
    projects: {},
    config: {},
    broadcast() {},
  });
  queue.runner = runner;
  return { queue, events };
}
