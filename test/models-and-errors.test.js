const assert = require('node:assert/strict');
const test = require('node:test');

const { getModelSettings, resolveTaskModel } = require('../model-config');
const {
  assertAgentResultSucceeded,
  isAgentAbortSummary,
  isModelUnavailableError,
  isTransientConnectionError,
} = require('../agent-errors');

const config = {
  cursor: {
    models: {
      simpleDefault: 'luna-id',
      complexDefault: 'opus-id',
      options: [
        { id: 'luna-id', name: 'GPT-5.6 Luna' },
        { id: 'opus-id', name: 'Opus 4.8 High' },
        { id: 'composer-id', name: 'Composer 2.5' },
      ],
    },
  },
};

test('任务模型默认值根据复杂度选择', () => {
  assert.equal(resolveTaskModel(config, false), 'luna-id');
  assert.equal(resolveTaskModel(config, true), 'opus-id');
});

test('任务可以选择配置白名单中的其他模型', () => {
  assert.equal(resolveTaskModel(config, false, 'composer-id'), 'composer-id');
  assert.throws(
    () => resolveTaskModel(config, false, 'auto-smart[optimize_for=cost]'),
    /模型不可用/,
  );
});

test('前端模型配置只暴露所需字段', () => {
  assert.deepEqual(getModelSettings(config), {
    simpleDefault: 'luna-id',
    complexDefault: 'opus-id',
    options: [
      { id: 'luna-id', name: 'GPT-5.6 Luna' },
      { id: 'opus-id', name: 'Opus 4.8 High' },
      { id: 'composer-id', name: 'Composer 2.5' },
    ],
  });
});

test('Cursor 路由权限错误会被识别为任务失败', () => {
  const summary =
    'Error: T: [permission_denied] This Cursor Router Optimize For mode was disabled for your team';

  assert.throws(() => assertAgentResultSucceeded(summary), /permission_denied/);
});

test('ECONNRESET 连接中断会被识别为可重试错误', () => {
  const summary = 'Error: T: [aborted] read ECONNRESET';
  assert.equal(isTransientConnectionError(summary), true);
  assert.equal(isAgentAbortSummary(summary), true);
  assert.throws(
    () => assertAgentResultSucceeded(summary),
    /Agent 连接中断，请稍后重试/,
  );
});

test('ACP 模型不可用错误会被识别', () => {
  assert.equal(isModelUnavailableError('Error: T: [unavailable] Error'), true);
  assert.equal(isModelUnavailableError('模型配置格式错误'), false);
  assert.equal(
    isModelUnavailableError({
      code: -32602,
      message: 'Invalid params',
      data: { message: 'Invalid model value: gpt-5.6-luna-medium-fast' },
    }),
    true,
  );
});

test('RetriableError: Connection stalled 会被识别为可重试且转任务失败', () => {
  const summary = 'Error: RetriableError: Connection stalled';
  assert.equal(isTransientConnectionError(summary), true);
  assert.throws(
    () => assertAgentResultSucceeded(summary),
    /Agent 连接中断，请稍后重试/,
  );
});

test('用户终止时 abort 摘要转为友好取消信息', () => {
  const summary = 'Error: T: [aborted] read ECONNRESET';
  assert.throws(
    () => assertAgentResultSucceeded(summary, { cancelled: true }),
    /用户终止任务/,
  );
});

test('正常结果中提到 Error 不会被误判为失败', () => {
  assert.doesNotThrow(() => assertAgentResultSucceeded('已完成 Error handling 优化。'));
});
