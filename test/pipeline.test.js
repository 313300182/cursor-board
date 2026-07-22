const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseTestResult,
  parseTaskTitleMarker,
  buildTestPrompt,
  buildFixPrompt,
  buildDeployPrompt,
  appendDevSuffix,
  appendTitleSuffix,
  statusForPhase,
  buildDeployRepairPrompt,
  buildRetryRepairPrompt,
  buildGitMessagePrompt,
  parseGitMessage,
  truncateMiddle,
  buildPlanPrompt,
} = require('../pipeline');

test('truncateMiddle 保留头尾并省略中间', () => {
  assert.equal(truncateMiddle('short', 100), 'short');
  const big = 'A'.repeat(20000);
  const result = truncateMiddle(big, 8000);
  assert.ok(result.length < big.length);
  assert.match(result, /已省略 \d+ 个字符/);
  assert.ok(result.startsWith('A'));
  assert.ok(result.endsWith('A'));
});

test('parseTestResult 截断超长失败报错', () => {
  const huge = `[TEST:FAIL]${'E'.repeat(20000)}`;
  const result = parseTestResult(huge);
  assert.equal(result.passed, false);
  assert.ok(result.error.length < 20000);
  assert.match(result.error, /已省略/);
});

test('parseTestResult 识别通过标记', () => {
  assert.deepEqual(parseTestResult('全部通过\n[TEST:PASS]'), {
    passed: true,
    error: null,
    reason: 'pass',
  });
});

test('parseTestResult 识别失败并提取报错', () => {
  const result = parseTestResult('执行失败\n[TEST:FAIL]\nAssertionError: expected 1 to equal 2');
  assert.equal(result.passed, false);
  assert.equal(result.reason, 'fail');
  assert.match(result.error, /AssertionError/);
});

test('parseTestResult 无标记时返回 missing_marker', () => {
  const result = parseTestResult('测试跑完了');
  assert.equal(result.passed, false);
  assert.equal(result.reason, 'missing_marker');
});

test('parseTestResult 可从 node:test TAP 输出推断通过', () => {
  const summary = [
    'ok 82 - deriveTaskTitle 会截断过长描述',
    '# tests 83',
    '# pass 83',
    '# fail 0',
  ].join('\n');
  const result = parseTestResult(summary);
  assert.equal(result.passed, true);
  assert.equal(result.reason, 'inferred_pass');
});

test('buildMissingMarkerPrompt 要求补输出标记', () => {
  const { buildMissingMarkerPrompt } = require('../pipeline');
  assert.match(buildMissingMarkerPrompt(), /\[TEST:PASS\]/);
  assert.match(buildMissingMarkerPrompt(), /无需重复跑测试/);
});

test('buildFixPrompt 包含报错信息', () => {
  assert.match(buildFixPrompt('boom'), /boom/);
  assert.match(buildFixPrompt('boom'), /测试打回/);
});

test('appendDevSuffix 追加流水线开发说明', () => {
  assert.match(appendDevSuffix('hello'), /不要运行部署/);
  assert.match(appendDevSuffix('hello'), /\[TITLE:/);
});

test('parseTaskTitleMarker 解析标题标记', () => {
  assert.equal(parseTaskTitleMarker('完成修改\n[TITLE:优化任务标题]'), '优化任务标题');
  assert.equal(parseTaskTitleMarker('无标题标记'), null);
});

test('appendTitleSuffix 追加标题总结说明', () => {
  assert.match(appendTitleSuffix('执行任务'), /\[TITLE:/);
});

test('buildPlanPrompt 明确要求通过 ACP 提交可批准计划', () => {
  const prompt = buildPlanPrompt('设计新功能');
  assert.match(prompt, /Plan 阶段/);
  assert.match(prompt, /必须调用 ACP 的 create_plan/);
  assert.match(prompt, /不能只在文本中描述计划/);
  assert.match(prompt, /不要修改任何文件/);
});

test('statusForPhase 映射阶段到状态', () => {
  assert.equal(statusForPhase('dev'), 'developing');
  assert.equal(statusForPhase('test'), 'testing');
  assert.equal(statusForPhase('commit'), 'committing');
  assert.equal(statusForPhase('pending_deploy'), 'pending_deploy');
  assert.equal(statusForPhase('deploy'), 'deploying');
});

test('isActiveTaskStatus 包含执行中与流水线阶段', () => {
  const { isActiveTaskStatus } = require('../pipeline');
  assert.equal(isActiveTaskStatus('planning'), true);
  assert.equal(isActiveTaskStatus('testing'), true);
  assert.equal(isActiveTaskStatus('awaiting_input'), false);
});

test('buildTestPrompt 包含测试命令', () => {
  assert.match(buildTestPrompt('npm run test:unit'), /npm run test:unit/);
});

test('appendDevSuffix 多目录时提示可联动修改', () => {
  const workdirs = [
    { label: '后端', path: 'D:\\code\\api' },
    { label: '前端', path: 'D:\\code\\web' },
  ];
  assert.match(appendDevSuffix('hello', workdirs), /前后端联动/);
});

test('buildTestPrompt 多目录时分别测试', () => {
  const prompt = buildTestPrompt(null, [
    { label: '后端', path: 'D:\\code\\api' },
    { label: '前端', path: 'D:\\code\\web' },
  ]);
  assert.match(prompt, /多个工作目录/);
  assert.match(prompt, /后端：D:\\code\\api/);
  assert.match(prompt, /前端：D:\\code\\web/);
});

test('buildTestPrompt 单目录时也列出工作目录并禁止跨目录测试', () => {
  const prompt = buildTestPrompt('npm test', [{ label: '看板', path: 'D:\\个人开发\\cursor-board' }]);
  assert.match(prompt, /本任务的工作目录/);
  assert.match(prompt, /看板：D:\\个人开发\\cursor-board/);
  assert.match(prompt, /不要进入、读取或测试其他目录\/项目/);
});

test('appendDevSuffix 单目录时也限制在工作目录内操作', () => {
  const prompt = appendDevSuffix('hello', [{ label: '看板', path: 'D:\\个人开发\\cursor-board' }]);
  assert.match(prompt, /只在本任务工作目录范围内操作/);
});

test('buildRetryRepairPrompt 单目录时列出工作目录并限制范围', () => {
  const prompt = buildRetryRepairPrompt('Plan 模式未生成可批准的计划', {
    taskTitle: '修复 Bug',
    taskPrompt: '工作目录：D:\\个人开发\\cursor-board',
    workdirs: [{ label: '看板', path: 'D:\\个人开发\\cursor-board' }],
  });
  assert.match(prompt, /工作目录（请仅在此目录内定位与修复/);
  assert.match(prompt, /只在本任务工作目录范围内定位与修复/);
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

test('buildRetryRepairPrompt 包含失败原因与原任务上下文', () => {
  const prompt = buildRetryRepairPrompt('测试失败: assert 1 === 2', {
    taskTitle: '修复登录',
    taskPrompt: '实现登录功能',
    workdirs: [{ label: '后端', path: 'D:\\backend' }],
  });
  assert.match(prompt, /任务异常 · 修复阶段/);
  assert.match(prompt, /测试失败/);
  assert.match(prompt, /修复登录/);
  assert.match(prompt, /实现登录功能/);
  assert.match(prompt, /不要输出 \[TEST:PASS\]/);
});

test('buildGitMessagePrompt 列出已确定的提交文件并只索取提交信息', () => {
  const prompt = buildGitMessagePrompt({
    taskTitle: '修复登录',
    files: ['src/login.js', 'src/new.js'],
    push: true,
  });
  assert.match(prompt, /修复登录/);
  assert.match(prompt, /src\/login\.js/);
  assert.match(prompt, /src\/new\.js/);
  assert.match(prompt, /\[GIT:MSG\]/);
  assert.match(prompt, /\[GIT:END\]/);
  assert.match(prompt, /git push/);
  assert.doesNotMatch(prompt, /\[GIT:CHANGES\]/);
});

test('buildGitMessagePrompt 文件过多时折叠展示', () => {
  const files = Array.from({ length: 60 }, (_, i) => `src/file${i}.js`);
  const prompt = buildGitMessagePrompt({ taskTitle: 't', files });
  assert.match(prompt, /另有 10 个文件/);
});

test('parseGitMessage 提取单行提交信息', () => {
  const parsed = parseGitMessage([
    '我写好了',
    '[GIT:MSG]',
    '- fix: 修复登录跳转',
    '[GIT:END]',
  ].join('\n'));
  assert.equal(parsed.message, 'fix: 修复登录跳转');
});

test('parseGitMessage 无标记时返回 null 供兜底', () => {
  assert.equal(parseGitMessage('随便说点什么').message, null);
});
