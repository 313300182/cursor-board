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
