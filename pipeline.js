const MAX_TEST_RETRIES = 5;

const PHASE_STATUS = {
  dev: 'developing',
  test: 'testing',
  deploy: 'deploying',
  pending_deploy: 'pending_deploy',
};

/**
 * Dev → test → deploy pipeline helpers for single-session workflows.
 * @author Amadeus
 */
function parseTestResult(summary) {
  const text = String(summary || '');
  if (/\[TEST:PASS\]/i.test(text)) {
    return { passed: true, error: null };
  }
  const failMatch = text.match(/\[TEST:FAIL\]([\s\S]*?)(?=\[TEST:|$)/i);
  if (/\[TEST:FAIL\]/i.test(text)) {
    return {
      passed: false,
      error: (failMatch ? failMatch[1] : text).trim() || '测试失败，未提供详细报错',
    };
  }
  return {
    passed: false,
    error: '测试阶段未输出 [TEST:PASS] 或 [TEST:FAIL] 标记，视为未通过',
  };
}

function buildTestPrompt(testCommand) {
  const lines = ['【流水线 · 测试阶段】'];
  if (testCommand) {
    lines.push(`请运行测试命令：${testCommand}`);
  } else {
    lines.push(
      '请先检查项目的测试方式（如 package.json scripts、Makefile、pom.xml、pytest 配置、README 等），',
      '确定合适的测试命令并执行。',
    );
  }
  lines.push(
    '要求：',
    '- 在同一工作目录执行，捕获完整输出',
    '- 全部通过时在回复末尾单独一行输出：[TEST:PASS]',
    '- 若有失败时在回复末尾单独一行输出：[TEST:FAIL]，并在其后附上完整报错信息',
    '- 此阶段不要修改业务代码，不要执行部署',
  );
  return lines.join('\n');
}

function buildFixPrompt(error) {
  return [
    '【流水线 · 开发阶段（测试打回）】',
    '测试未通过，报错如下：',
    '---',
    error,
    '---',
    '请修复问题并简要说明改动。',
    '要求：',
    '- 修复后不要运行部署',
    '- 不要输出 [TEST:PASS] / [TEST:FAIL]（测试阶段会再次执行）',
  ].join('\n');
}

function buildDeployPrompt(deployCommand, { backlog = [], currentTitle = '' } = {}) {
  const lines = [
    '【流水线 · 部署阶段】',
    '测试已通过，系统自动进入部署。',
  ];
  const pendingTasks = backlog.filter((item) => item?.title);
  if (pendingTasks.length > 0) {
    lines.push(
      '',
      `以下 ${pendingTasks.length + (currentTitle ? 1 : 0)} 个任务的变更将一并部署：`,
    );
    pendingTasks.forEach((item, index) => {
      const summary = item.result_summary ? ` — ${String(item.result_summary).slice(0, 200)}` : '';
      lines.push(`${index + 1}. ${item.title}${summary}`);
    });
    if (currentTitle) {
      lines.push(`${pendingTasks.length + 1}. ${currentTitle}（当前任务）`);
    }
    lines.push('', '请一次性完成全部待部署变更的发布，不要遗漏。');
  }
  if (deployCommand) {
    lines.push('', `请执行部署命令：${deployCommand}`);
  } else {
    lines.push(
      '',
      '请先检查项目的部署方式（优先 package.json scripts，其次 Makefile、Docker、CI、README）。',
      '若存在 `npm run deploy`，必须使用它，不要直接 kill 正在运行的 node server 进程。',
      '对本看板项目：`npm run deploy` 会预约延迟重启，避免自部署时把当前任务会话一起杀掉。',
    );
  }
  lines.push(
    '完成后给出简洁的部署结果摘要。',
    '若执行的是预约重启类部署（如 npm run deploy），看到“已预约重启”即可视为部署命令成功。',
  );
  return lines.join('\n');
}

function buildDeployRepairPrompt(deployCommand, errorOutput) {
  return [
    '【项目部署失败 · 修复阶段】',
    `项目部署命令：${deployCommand}`,
    '部署失败输出：',
    '---',
    String(errorOutput || '未提供错误输出'),
    '---',
    '请分析根因并修改项目文件以修复部署问题。',
    '要求：',
    '- 只处理与本次部署失败直接相关的问题',
    '- 可以运行测试或只读诊断命令',
    '- 已获得用户批准，请自主完成修复，不要再向用户提问',
    '- 不要执行部署命令，系统会在你修复完成后自动重试一次',
    '- 完成后简洁说明修复内容',
  ].join('\n');
}

function buildDevPromptSuffix() {
  return [
    '',
    '【流水线说明】',
    '- 当前为开发阶段：完成实现即可',
    '- 不要运行部署命令',
    '- 不要输出 [TEST:PASS] / [TEST:FAIL]',
  ].join('\n');
}

function appendDevSuffix(prompt) {
  return `${String(prompt || '').trim()}\n${buildDevPromptSuffix()}`;
}

function statusForPhase(phase) {
  return PHASE_STATUS[phase] || phase;
}

function isPipelineRunningStatus(status) {
  return ['developing', 'testing', 'deploying', 'pending_deploy'].includes(status);
}

module.exports = {
  MAX_TEST_RETRIES,
  PHASE_STATUS,
  parseTestResult,
  buildTestPrompt,
  buildFixPrompt,
  buildDeployPrompt,
  buildDeployRepairPrompt,
  appendDevSuffix,
  statusForPhase,
  isPipelineRunningStatus,
};
