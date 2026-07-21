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

test('isBoardSelfKillAttempt 拦截针对看板 PID 的 taskkill', () => {
  const { isBoardSelfKillAttempt } = AcpRunner;
  assert.equal(
    isBoardSelfKillAttempt('taskkill /PID 3272 /T /F', { pids: ['3272'] }),
    true,
  );
  assert.equal(
    isBoardSelfKillAttempt('Stop-Process -Id 3272 -Force', { pids: ['3272'] }),
    true,
  );
  assert.equal(
    isBoardSelfKillAttempt('taskkill /PID 9999 /T /F', { pids: ['3272'] }),
    false,
  );
});

test('isBoardSelfKillAttempt 拦截整杀 node 进程', () => {
  const { isBoardSelfKillAttempt } = AcpRunner;
  assert.equal(isBoardSelfKillAttempt('taskkill /IM node.exe /F'), true);
  assert.equal(isBoardSelfKillAttempt('Stop-Process -Name node -Force'), true);
});

test('shouldDenyPermission 拒绝终止看板自身进程', () => {
  const runner = new AcpRunner({ security: { denyPatterns: [] } });
  const params = {
    toolCall: { title: `taskkill /PID ${process.pid} /T /F` },
  };
  assert.equal(runner.getPermissionDenialReason(params), '禁止终止看板自身进程');
  assert.equal(runner.shouldDenyPermission(params), true);
  assert.equal(
    runner.shouldDenyPermission({ toolCall: { title: 'npm test' } }),
    false,
  );
});

test('submitInteraction permission 拒绝后回复 reject-once', async () => {
  const runner = new AcpRunner({ security: {} });
  let responded;
  runner.pendingInteractions.set('task-1', {
    type: 'permission',
    requestId: 'req-1',
    allowOnce: false,
    respond(id, payload) {
      responded = { id, payload };
    },
  });
  runner.activeRuns.set('task-1', { endHumanWait() {} });
  await runner.submitInteraction('task-1', { allowed: false });
  assert.deepEqual(responded, {
    id: 'req-1',
    payload: { outcome: { outcome: 'selected', optionId: 'reject-once' } },
  });
  assert.equal(runner.pendingInteractions.has('task-1'), false);
});

test('submitInteraction permission 禁止放行看板 kill', async () => {
  const runner = new AcpRunner({ security: {} });
  runner.pendingInteractions.set('task-1', {
    type: 'permission',
    requestId: 'req-1',
    allowOnce: false,
    respond() {},
  });
  runner.activeRuns.set('task-1', { endHumanWait() {} });
  await assert.rejects(
    () => runner.submitInteraction('task-1', { allowed: true }),
    /不允许放行/,
  );
});

test('TaskQueue.submitInteraction permission 恢复 resumeStatus', async () => {
  let submitted;
  const task = {
    id: 'task-1',
    status: 'pending_approval',
    pipeline_mode: true,
    pipeline_phase: 'dev',
    interaction: {
      type: 'permission',
      resumeStatus: 'developing',
      allowOnce: true,
    },
  };
  const repo = {
    getTask() {
      return task;
    },
    setInteraction(_id, value) {
      task.interaction = value;
    },
    updateStatus(_id, patch) {
      Object.assign(task, patch);
      return { ...task };
    },
    addEvent() {},
  };
  const queue = new TaskQueue({
    repo,
    projects: {},
    config: {},
    broadcast() {},
  });
  queue.runner = {
    async submitInteraction(_id, input) {
      submitted = input;
    },
  };
  const updated = await queue.submitInteraction('task-1', { allowed: false });
  assert.deepEqual(submitted, { allowed: false });
  assert.equal(updated.status, 'developing');
  assert.equal(task.interaction, null);
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
    options: { skipTest: false, attachments: [] },
  });
});

test('TaskQueue.sendTaskMessage 支持图片附件', () => {
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

  queue.sendTaskMessage('task-1', {
    message: '参考截图',
    attachments: [{ mimeType: 'image/png', data: 'aGVsbG8=' }],
  });
  assert.deepEqual(steered, {
    id: 'task-1',
    message: '参考截图',
    options: {
      skipTest: false,
      attachments: [{ mimeType: 'image/png', data: 'aGVsbG8=', field: null }],
    },
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
