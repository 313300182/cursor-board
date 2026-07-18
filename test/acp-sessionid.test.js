const assert = require('node:assert/strict');
const test = require('node:test');
const AcpRunner = require('../acp-runner');

function stubSession(summary) {
  return {
    permissionEvents: [],
    context: {},
    async prompt() {},
    getTurnSummary() {
      return summary;
    },
    getSummary() {
      return summary;
    },
  };
}

test('runSingleTask 返回结果时不引用未定义的 sessionId', async () => {
  const runner = new AcpRunner({ cursor: {}, security: {} });
  runner.withSession = async ({ run }) => {
    const result = await run(stubSession('任务已完成'));
    assert.ok(result && typeof result === 'object');
    result.sessionId = 'sess-single';
    return result;
  };

  const result = await runner.runSingleTask({
    taskId: 't1',
    workdir: process.cwd(),
    prompt: 'hello',
  });

  assert.equal(result.sessionId, 'sess-single');
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'undefined'));
});

test('runPipelineTask 测试通过后返回 awaitingDeploy，且不引用未定义的 sessionId', async () => {
  const runner = new AcpRunner({ cursor: {}, security: {} });
  runner.withSession = async ({ run }) => {
    const result = await run(stubSession('测试通过\n[TEST:PASS]'));
    assert.ok(result && typeof result === 'object');
    result.sessionId = 'sess-pipe';
    return result;
  };

  const result = await runner.runPipelineTask({
    taskId: 't2',
    workdir: process.cwd(),
    prompt: 'hello',
    testCommand: 'npm test',
    onEvent() {},
  });

  assert.equal(result.awaitingDeploy, true);
  assert.equal(result.sessionId, 'sess-pipe');
});

test('runPipelineTask Git 跳过提交时通过 activeRun.emit 写日志', async () => {
  const runner = new AcpRunner({ cursor: {}, security: {} });
  const logs = [];
  runner.withSession = async ({ taskId, run, onEvent }) => {
    runner.activeRuns.set(taskId, {
      emit: (type, payload) => {
        if (onEvent) onEvent(type, payload);
      },
      flags: { skipTest: false },
    });
    let turn = 0;
    const session = {
      permissionEvents: [],
      context: {},
      async prompt() {},
      getTurnSummary() {
        turn += 1;
        if (turn === 1) return '开发完成\n[TITLE:Git 跳过测试]';
        if (turn === 2) return '测试通过\n[TEST:PASS]';
        return '无变更\n[GIT:SKIP]';
      },
      getSummary() {
        return '无变更\n[GIT:SKIP]';
      },
    };
    const result = await run(session);
    runner.activeRuns.delete(taskId);
    result.sessionId = 'sess-git-skip';
    return result;
  };

  const result = await runner.runPipelineTask({
    taskId: 't3',
    workdir: process.cwd(),
    prompt: 'hello',
    testCommand: 'npm test',
    gitCommit: true,
    onEvent(type, payload) {
      if (type === 'log') logs.push(payload.chunk);
    },
  });

  assert.equal(result.awaitingDeploy, true);
  assert.equal(result.sessionId, 'sess-git-skip');
  assert.equal(result.suggestedTitle, 'Git 跳过测试');
  assert.ok(logs.some((line) => line.includes('无变更，已跳过 Git 提交')));
});
