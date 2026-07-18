const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseTestResult,
  buildTestPrompt,
  buildFixPrompt,
  buildDeployPrompt,
  appendDevSuffix,
  statusForPhase,
  buildDeployRepairPrompt,
} = require('../pipeline');

test('parseTestResult 识别通过标记', () => {
  assert.deepEqual(parseTestResult('全部通过\n[TEST:PASS]'), {
    passed: true,
    error: null,
  });
});

test('parseTestResult 识别失败并提取报错', () => {
  const result = parseTestResult('执行失败\n[TEST:FAIL]\nAssertionError: expected 1 to equal 2');
  assert.equal(result.passed, false);
  assert.match(result.error, /AssertionError/);
});

test('parseTestResult 无标记视为失败', () => {
  assert.equal(parseTestResult('测试跑完了').passed, false);
});

test('buildFixPrompt 包含报错信息', () => {
  assert.match(buildFixPrompt('boom'), /boom/);
  assert.match(buildFixPrompt('boom'), /测试打回/);
});

test('appendDevSuffix 追加流水线开发说明', () => {
  assert.match(appendDevSuffix('hello'), /不要运行部署/);
});

test('statusForPhase 映射阶段到状态', () => {
  assert.equal(statusForPhase('dev'), 'developing');
  assert.equal(statusForPhase('test'), 'testing');
  assert.equal(statusForPhase('pending_deploy'), 'pending_deploy');
  assert.equal(statusForPhase('deploy'), 'deploying');
});

test('buildTestPrompt 包含测试命令', () => {
  assert.match(buildTestPrompt('npm run test:unit'), /npm run test:unit/);
});

test('buildTestPrompt 无命令时引导 AI 自动识别', () => {
  assert.match(buildTestPrompt(), /package\.json/);
});

test('buildDeployPrompt 无命令时引导 AI 自动识别', () => {
  const prompt = buildDeployPrompt();
  assert.match(prompt, /package\.json/);
  assert.match(prompt, /npm run deploy/);
  assert.match(prompt, /预约/);
});

test('buildDeployPrompt 包含批量部署任务列表', () => {
  const prompt = buildDeployPrompt(null, {
    currentTitle: '修复登录',
    backlog: [{ title: '修复注册', result_summary: '改了 auth.js' }],
  });
  assert.match(prompt, /修复注册/);
  assert.match(prompt, /修复登录/);
  assert.match(prompt, /一并部署/);
});

test('buildDeployRepairPrompt 要求修复但不直接部署', () => {
  const prompt = buildDeployRepairPrompt('npm run deploy', 'exit 1');
  assert.match(prompt, /npm run deploy/);
  assert.match(prompt, /exit 1/);
  assert.match(prompt, /不要执行部署命令/);
});
