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
  renderLogChunksHtml,
  DONE_VISIBLE_DEFAULT,
  limitDoneTasksForDisplay,
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
  assert.equal(statusGroup('testing'), 'testing');
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
