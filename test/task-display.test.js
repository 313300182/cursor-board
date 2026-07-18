const assert = require('node:assert/strict');
const test = require('node:test');

const {
  statusGroup,
  sortTasksForGroup,
  normalizeLogStream,
  parseTaskLogEvents,
  appendLogChunk,
  appendPermissionChunk,
  summaryPlaceholder,
  resolveTaskSummary,
  formatMarkdown,
  mergeLogChunksForDisplay,
  LOG_LAZY_CHAR_THRESHOLD,
  LOG_LAZY_TAIL_CHARS,
  planLogLazyDisplay,
  renderLogStreamHtml,
  renderLogChunksHtml,
  DONE_VISIBLE_DEFAULT,
  limitDoneTasksForDisplay,
  isTerminalTaskStatus,
  isIterableTaskStatus,
  isCompletedRoundStatus,
  parseTaskDisplayRounds,
  renderTaskRoundsHtml,
} = require('../public/task-display');

function task(id, patch = {}) {
  return {
    id,
    status: 'pending',
    created_at: '2026-01-01T00:00:00.000Z',
    started_at: null,
    finished_at: null,
    ...patch,
  };
}

test('statusGroup 映射流水线阶段到看板列', () => {
  assert.equal(statusGroup('developing'), 'developing');
  assert.equal(statusGroup('testing'), 'developing');
  assert.equal(statusGroup('committing'), 'developing');
  assert.equal(statusGroup('planning'), 'developing');
  assert.equal(statusGroup('running'), 'developing');
  assert.equal(statusGroup('pending_deploy'), 'deploy');
  assert.equal(statusGroup('deploying'), 'deploy');
  assert.equal(statusGroup('awaiting_input'), 'waiting');
  assert.equal(statusGroup('failed'), 'problem');
});

test('待执行列按创建时间倒序展示（栈顶为最新）', () => {
  const sorted = sortTasksForGroup([
    task('old', { created_at: '2026-01-01T00:00:00.000Z' }),
    task('new', { created_at: '2026-01-03T00:00:00.000Z' }),
    task('mid', { created_at: '2026-01-02T00:00:00.000Z' }),
  ], 'pending');
  assert.deepEqual(sorted.map((item) => item.id), ['new', 'mid', 'old']);
});

test('已完成列按完成时间倒序展示', () => {
  const sorted = sortTasksForGroup([
    task('a', { status: 'done', finished_at: '2026-01-01T10:00:00.000Z' }),
    task('b', { status: 'done', finished_at: '2026-01-03T10:00:00.000Z' }),
    task('c', { status: 'done', finished_at: '2026-01-02T10:00:00.000Z' }),
  ], 'done');
  assert.deepEqual(sorted.map((item) => item.id), ['b', 'c', 'a']);
});

test('进行中列按开始时间倒序展示', () => {
  const sorted = sortTasksForGroup([
    task('a', { status: 'developing', started_at: '2026-01-01T10:00:00.000Z' }),
    task('b', { status: 'developing', started_at: '2026-01-03T10:00:00.000Z' }),
  ], 'developing');
  assert.deepEqual(sorted.map((item) => item.id), ['b', 'a']);
});

test('异常列按结束时间倒序展示', () => {
  const sorted = sortTasksForGroup([
    task('a', { status: 'failed', finished_at: '2026-01-01T10:00:00.000Z' }),
    task('b', { status: 'failed', finished_at: '2026-01-03T10:00:00.000Z' }),
  ], 'problem');
  assert.deepEqual(sorted.map((item) => item.id), ['b', 'a']);
});

test('parseTaskLogEvents 区分 message / thinking / permission', () => {
  const chunks = parseTaskLogEvents([
    { type: 'log_chunk', payload: { chunk: 'hello', stream: 'message' } },
    { type: 'log_chunk', payload: { chunk: 'think', stream: 'thinking' } },
    { type: 'log_chunk', payload: { chunk: 'legacy' } },
    { type: 'permission', payload: { tool: 'Shell', action: 'auto' } },
  ]);
  assert.deepEqual(chunks, [
    { stream: 'message', text: 'hello' },
    { stream: 'thinking', text: 'think' },
    { stream: 'message', text: 'legacy' },
    { stream: 'system', text: '[审批] Shell → auto\n' },
  ]);
});

test('appendLogChunk 追加实时 chunk', () => {
  const chunks = appendLogChunk(
    [{ stream: 'message', text: 'a' }],
    { chunk: 'b', stream: 'thinking' },
  );
  assert.deepEqual(chunks, [
    { stream: 'message', text: 'a' },
    { stream: 'thinking', text: 'b' },
  ]);
});

test('isTerminalTaskStatus 识别已结束任务', () => {
  assert.equal(isTerminalTaskStatus('done'), true);
  assert.equal(isTerminalTaskStatus('failed'), true);
  assert.equal(isTerminalTaskStatus('needs_human'), true);
  assert.equal(isTerminalTaskStatus('running'), false);
  assert.equal(isTerminalTaskStatus('pending'), false);
});

test('resolveTaskSummary 优先使用 result_summary', () => {
  assert.equal(resolveTaskSummary({
    status: 'done',
    result_summary: '修改了 index.html',
  }), '修改了 index.html');
  assert.match(resolveTaskSummary({ status: 'running' }), /执行中/);
  assert.match(resolveTaskSummary({ status: 'done' }), /暂无结果摘要/);
});

test('normalizeLogStream 兼容未知类型', () => {
  assert.equal(normalizeLogStream('thinking'), 'thinking');
  assert.equal(normalizeLogStream(undefined), 'message');
});

test('formatMarkdown 支持标题、列表与粗体', () => {
  const html = formatMarkdown('**结论**\n\n变更已生效。\n- 修改 index.html\n- 修改 task-display.js');
  assert.match(html, /<strong>结论<\/strong>/);
  assert.match(html, /<p>变更已生效。<\/p>/);
  assert.match(html, /<li>修改 index.html<\/li>/);
});

test('mergeLogChunksForDisplay 合并同类型流式片段', () => {
  const merged = mergeLogChunksForDisplay([
    { stream: 'message', text: '**结论' },
    { stream: 'message', text: '**\n变更已生效。' },
    { stream: 'thinking', text: '分析中' },
    { stream: 'thinking', text: '…' },
    { stream: 'system', text: '[stderr] warn' },
  ]);
  assert.deepEqual(merged, [
    { stream: 'message', text: '**结论**\n变更已生效。' },
    { stream: 'thinking', text: '分析中…' },
    { stream: 'system', text: '[stderr] warn' },
  ]);
});

test('renderLogChunksHtml 对 message 流渲染 Markdown', () => {
  const html = renderLogChunksHtml([
    { stream: 'message', text: '**结论**\n变更已生效。' },
  ]);
  assert.match(html, /log-chunk-message/);
  assert.match(html, /<strong>结论<\/strong>/);
  assert.doesNotMatch(html, /\*\*结论/);
});

test('isIterableTaskStatus 识别可迭代任务', () => {
  assert.equal(isIterableTaskStatus('done'), true);
  assert.equal(isIterableTaskStatus('pending_deploy'), true);
  assert.equal(isIterableTaskStatus('developing'), false);
});

test('isCompletedRoundStatus 包含待部署', () => {
  assert.equal(isCompletedRoundStatus('pending_deploy'), true);
  assert.equal(isCompletedRoundStatus('developing'), false);
});

test('parseTaskDisplayRounds 按迭代轮次拆分输出与摘要', () => {
  const events = [
    { type: 'log_chunk', payload: { chunk: '第一轮输出', stream: 'message' } },
    { type: 'iteration_round', payload: { round: 1, summary: '第一轮摘要' } },
    { type: 'iteration_start', payload: { round: 2, requirement: '继续优化' } },
    { type: 'log_chunk', payload: { chunk: '第二轮输出', stream: 'message' } },
  ];
  const task = { status: 'pending_deploy', result_summary: '第二轮摘要' };
  const rounds = parseTaskDisplayRounds(events, task);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].label, '初始任务');
  assert.equal(rounds[0].summary, '第一轮摘要');
  assert.match(rounds[0].chunks[0].text, /第一轮输出/);
  assert.equal(rounds[1].label, '迭代 2');
  assert.equal(rounds[1].summary, '第二轮摘要');
  assert.match(rounds[1].chunks[0].text, /第二轮输出/);
});

test('renderTaskRoundsHtml 渲染多轮区块', () => {
  const html = renderTaskRoundsHtml([
    {
      round: 1,
      label: '初始任务',
      chunks: [{ stream: 'message', text: 'hello' }],
      summary: '完成',
      complete: true,
    },
    {
      round: 2,
      label: '迭代 2',
      chunks: [{ stream: 'message', text: 'world' }],
      summary: '',
      complete: false,
    },
  ], { status: 'developing' });
  assert.match(html, /iteration-round/);
  assert.match(html, /初始任务/);
  assert.match(html, /迭代 2/);
  assert.match(html, /hello/);
  assert.match(html, /world/);
});

test('planLogLazyDisplay 短内容全量展示，长内容默认只展示尾部', () => {
  const shortChunks = [{ stream: 'message', text: '短输出' }];
  const shortPlan = planLogLazyDisplay(shortChunks);
  assert.equal(shortPlan.mode, 'full');
  assert.equal(shortPlan.hasHidden, false);

  const longText = 'x'.repeat(LOG_LAZY_CHAR_THRESHOLD + 500);
  const longChunks = [{ stream: 'message', text: longText }];
  const lazyPlan = planLogLazyDisplay(longChunks);
  assert.equal(lazyPlan.mode, 'lazy');
  assert.equal(lazyPlan.hasHidden, true);
  assert.ok(lazyPlan.visibleChars <= LOG_LAZY_TAIL_CHARS);
});

test('renderLogStreamHtml 长日志渲染懒加载触发器', () => {
  const longText = `EARLY_MARKER${'x'.repeat(LOG_LAZY_CHAR_THRESHOLD + 1000)}LATE_MARKER`;
  const html = renderLogStreamHtml([{ stream: 'message', text: longText }]);
  assert.match(html, /log-lazy-trigger/);
  assert.doesNotMatch(html, /EARLY_MARKER/);
  assert.match(html, /LATE_MARKER/);
});

test('已完成列默认只展示 7 条', () => {
  assert.equal(DONE_VISIBLE_DEFAULT, 7);
  const tasks = Array.from({ length: 10 }, (_, index) => task(`t${index}`, {
    status: 'done',
    finished_at: `2026-01-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
  }));
  const limited = limitDoneTasksForDisplay(tasks, false);
  assert.equal(limited.visible.length, 7);
  assert.equal(limited.hiddenCount, 3);
  assert.equal(limited.total, 10);
  const expanded = limitDoneTasksForDisplay(tasks, true);
  assert.equal(expanded.visible.length, 10);
  assert.equal(expanded.hiddenCount, 0);
});
