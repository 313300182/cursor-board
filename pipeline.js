const MAX_TEST_RETRIES = 5;
const MAX_MARKER_RETRIES = 2;

const MISSING_MARKER_ERROR = '测试阶段未输出 [TEST:PASS] 或 [TEST:FAIL] 标记';

const PHASE_STATUS = {
  dev: 'developing',
  test: 'testing',
  commit: 'committing',
  deploy: 'deploying',
  pending_deploy: 'pending_deploy',
};

const MAX_ERROR_CHARS = 8000;

/**
 * Dev → test → deploy pipeline helpers for single-session workflows.
 * @author Amadeus
 */
function truncateMiddle(text, maxChars = MAX_ERROR_CHARS) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  const headChars = Math.floor(maxChars * 0.7);
  const tailChars = maxChars - headChars;
  const omitted = value.length - maxChars;
  return `${value.slice(0, headChars)}\n…（已省略 ${omitted} 个字符）…\n${value.slice(-tailChars)}`;
}

function inferTestOutcomeFromOutput(text) {
  const body = String(text || '');
  const failFooter = body.match(/#\s*fail\s+(\d+)/i);
  const passFooter = body.match(/#\s*pass\s+(\d+)/i);
  if (failFooter && passFooter) {
    const failCount = Number(failFooter[1]);
    const passCount = Number(passFooter[1]);
    if (failCount === 0 && passCount > 0) return 'pass';
    if (failCount > 0) return 'fail';
  }

  if (/#\s*tests?\s+\d+[\s\S]*#\s*fail\s+0/i.test(body) && /#\s*pass\s+[1-9]\d*/i.test(body)) {
    return 'pass';
  }

  if (/\b(?:all tests passed|tests passed successfully)\b/i.test(body)) {
    return 'pass';
  }

  if (/\b(?:tests?\s+\d+\s+failed|\bfailed\s+\d+\s+tests?)\b/i.test(body)) {
    return 'fail';
  }

  return null;
}

function parseTestResult(summary) {
  const text = String(summary || '');
  if (/\[TEST:PASS\]/i.test(text)) {
    return { passed: true, error: null, reason: 'pass' };
  }
  const failMatch = text.match(/\[TEST:FAIL\]([\s\S]*?)(?=\[TEST:|$)/i);
  if (/\[TEST:FAIL\]/i.test(text)) {
    return {
      passed: false,
      error: truncateMiddle((failMatch ? failMatch[1] : text).trim()) || '测试失败，未提供详细报错',
      reason: 'fail',
    };
  }

  const inferred = inferTestOutcomeFromOutput(text);
  if (inferred === 'pass') {
    return { passed: true, error: null, reason: 'inferred_pass' };
  }
  if (inferred === 'fail') {
    return {
      passed: false,
      error: '测试输出显示存在失败，但未提供 [TEST:FAIL] 详细报错',
      reason: 'inferred_fail',
    };
  }

  return {
    passed: false,
    error: MISSING_MARKER_ERROR,
    reason: 'missing_marker',
  };
}

function buildTestPrompt(testCommand, workdirs) {
  const lines = ['【流水线 · 测试阶段】'];
  const dirs = Array.isArray(workdirs) ? workdirs.filter((entry) => entry?.path) : [];
  if (dirs.length > 1) {
    lines.push('本任务涉及多个工作目录，请分别在每个目录下运行对应测试：');
    dirs.forEach((entry) => {
      const label = String(entry.label || '').trim() || entry.path;
      lines.push(`- ${label}：${entry.path}`);
    });
  }
  if (testCommand) {
    lines.push(`请运行测试命令：${testCommand}`);
  } else {
    lines.push(
      '请先检查各工作目录的测试方式（如 package.json scripts、Makefile、pom.xml、pytest 配置、README 等），',
      '确定合适的测试命令并执行。',
    );
  }
  lines.push(
    '要求：',
    '- 在各相关工作目录执行测试，捕获完整输出',
    '- **必须**在回复末尾单独一行输出结果标记（缺标记会导致流水线无法判定）：',
    '  - 全部通过 → [TEST:PASS]',
    '  - 存在失败 → [TEST:FAIL]，并在其后附上完整报错信息',
    '- 此阶段不要修改业务代码，不要执行部署',
  );
  return lines.join('\n');
}

function buildMissingMarkerPrompt() {
  return [
    '【流水线 · 测试阶段（补输出标记）】',
    '上一轮测试回复末尾缺少 [TEST:PASS] 或 [TEST:FAIL] 标记，系统无法判定结果。',
    '请根据刚才的测试执行情况：',
    '- 若已全部通过：在回复末尾单独一行输出 [TEST:PASS]，可简要汇总，无需重复跑测试',
    '- 若有失败：在回复末尾单独一行输出 [TEST:FAIL]，并在其后附上完整报错',
    '- 此阶段不要修改业务代码，不要执行部署',
  ].join('\n');
}

function buildFixPrompt(error) {
  if (String(error || '').includes(MISSING_MARKER_ERROR)) {
    return buildMissingMarkerPrompt();
  }
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

const MAX_MESSAGE_FILES = 50;

function buildGitMessagePrompt({ taskTitle, files = [], push = false } = {}) {
  const list = (Array.isArray(files) ? files : []).filter(Boolean);
  const shown = list.slice(0, MAX_MESSAGE_FILES);
  const omitted = list.length - shown.length;
  const lines = [
    '【流水线 · Git 提交阶段（生成提交信息）】',
    '测试已通过。看板已根据「你本次编辑过的文件」自动挑好要提交的改动，git 提交由看板执行，',
    '你无需运行 git status/diff/add/commit，也无需挑选文件。',
    '',
    '本次将提交以下文件：',
    ...shown.map((file) => `- ${file}`),
  ];
  if (omitted > 0) {
    lines.push(`- …（另有 ${omitted} 个文件）`);
  }
  if (taskTitle) {
    lines.push('', `任务标题（供参考）：${taskTitle}`);
  }
  lines.push(
    '',
    '请为本次提交写一条简洁准确的中文提交信息（单行，概括本次任务改动，不要换行、不要解释）。',
    '提交类型必须遵循项目约定：新增功能使用「feat: 改动描述」；迭代修改、Bug 修复、异常处理或兼容性调整使用「fix: 改动描述」。',
    '只能使用 feat: 或 fix:，冒号后保留一个空格。',
    '严格按以下格式在回复末尾输出：',
    '[GIT:MSG]',
    '<一行提交信息>',
    '[GIT:END]',
  );
  if (push) {
    lines.push('', '（提交成功后看板会自动执行 git push，不使用 --force）');
  }
  return lines.join('\n');
}

function parseGitMessage(summary) {
  const text = String(summary || '');
  const block = text.match(/\[GIT:MSG\]([\s\S]*?)(?=\[GIT:END\]|$)/i);
  const messageLines = block
    ? block[1].split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
  const message = (messageLines[0] || '').replace(/^[-*]\s*/, '').trim();
  return { message: message || null };
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

function buildRetryRepairPrompt(error, { taskTitle, taskPrompt, workdirs } = {}) {
  const lines = [
    '【任务异常 · 修复阶段】',
    '任务上次执行失败。请先修复导致失败的问题，系统随后会自动进入测试阶段继续流水线。',
  ];
  if (taskTitle) {
    lines.push(`任务：${taskTitle}`);
  }
  const dirs = Array.isArray(workdirs) ? workdirs.filter((entry) => entry?.path) : [];
  if (dirs.length > 1) {
    lines.push('涉及工作目录：');
    dirs.forEach((entry) => {
      const label = String(entry.label || '').trim() || entry.path;
      lines.push(`- ${label}：${entry.path}`);
    });
  }
  lines.push(
    '失败原因：',
    '---',
    truncateMiddle(error || '未提供错误信息'),
    '---',
  );
  const promptText = String(taskPrompt || '').trim();
  if (promptText) {
    lines.push('原任务需求（供修复参考）：', '---', promptText, '---');
  }
  lines.push(
    '请分析并修复导致上述失败的问题。',
    '要求：',
    '- 优先解决与失败原因直接相关的代码/配置/环境问题',
    '- 修复后不要运行部署',
    '- 不要输出 [TEST:PASS] / [TEST:FAIL]（测试阶段会再次执行）',
    '- 简要说明修复内容',
  );
  return lines.join('\n');
}

const TASK_TITLE_MAX_LEN = 48;

function parseTaskTitleMarker(text) {
  const match = String(text || '').match(/\[TITLE:([^\]\n]+)\]/i);
  if (!match) return null;
  const title = match[1].trim();
  if (!title) return null;
  return title.length > TASK_TITLE_MAX_LEN
    ? `${title.slice(0, TASK_TITLE_MAX_LEN)}…`
    : title;
}

function buildTitlePromptSuffix() {
  return [
    '',
    '【任务标题】',
    '请在回复末尾单独一行输出本任务的简短标题（不超过20字），格式：[TITLE:你的标题]',
    '标题应概括任务目标，不要用整段需求原文。',
  ].join('\n');
}

function buildDevPromptSuffix(workdirs) {
  const dirs = Array.isArray(workdirs) ? workdirs.filter((entry) => entry?.path) : [];
  const lines = [
    '',
    '【流水线说明】',
    '- 当前为开发阶段：完成实现即可',
    '- 不要运行部署命令',
    '- 不要输出 [TEST:PASS] / [TEST:FAIL]',
  ];
  if (dirs.length > 1) {
    lines.splice(2, 0, '- 可在以上多个工作目录范围内同步修改（如前后端联动）');
  }
  lines.push(buildTitlePromptSuffix());
  return lines.join('\n');
}

function appendDevSuffix(prompt, workdirs) {
  return `${String(prompt || '').trim()}\n${buildDevPromptSuffix(workdirs)}`;
}

function appendTitleSuffix(prompt) {
  return `${String(prompt || '').trim()}\n${buildTitlePromptSuffix()}`;
}

function statusForPhase(phase) {
  return PHASE_STATUS[phase] || phase;
}

function isPipelineRunningStatus(status) {
  return ['developing', 'testing', 'committing', 'deploying', 'pending_deploy'].includes(status);
}

function isActiveTaskStatus(status) {
  return ['planning', 'running', 'developing', 'testing', 'committing', 'deploying'].includes(status);
}

function buildSteerPrompt(message) {
  return [
    '【用户补充说明】',
    String(message || '').trim(),
    '',
    '请根据以上反馈调整当前任务方向，并继续执行。',
    '若用户要求跳过测试或某步骤，按用户指示处理。',
  ].join('\n');
}

function shouldSkipTestFromMessage(message) {
  const text = String(message || '').trim();
  if (!text) return false;
  return /跳过\s*测试|不要\s*(运行|跑|执行)\s*测试|skip\s*(the\s*)?test/i.test(text);
}

module.exports = {
  MAX_TEST_RETRIES,
  MAX_MARKER_RETRIES,
  MISSING_MARKER_ERROR,
  TASK_TITLE_MAX_LEN,
  PHASE_STATUS,
  truncateMiddle,
  parseTestResult,
  parseTaskTitleMarker,
  inferTestOutcomeFromOutput,
  buildTestPrompt,
  buildMissingMarkerPrompt,
  buildFixPrompt,
  buildGitMessagePrompt,
  parseGitMessage,
  buildDeployPrompt,
  buildDeployRepairPrompt,
  buildRetryRepairPrompt,
  buildTitlePromptSuffix,
  appendDevSuffix,
  appendTitleSuffix,
  statusForPhase,
  isPipelineRunningStatus,
  isActiveTaskStatus,
  buildSteerPrompt,
  shouldSkipTestFromMessage,
};
