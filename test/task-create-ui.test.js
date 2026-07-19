const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('新建任务区只保留 Plan 模式与 Git 开关', () => {
  assert.match(html, /id="planInput"/);
  assert.match(html, /id="gitCommitInput"/);
  assert.doesNotMatch(html, /id="pipelineInput"/);
  assert.doesNotMatch(html, /id="complexInput"/);
  assert.match(html, /<strong>Plan 模式<\/strong>/);
  assert.match(html, /<strong>Git<\/strong>/);
  assert.doesNotMatch(html, /<strong>流水线<\/strong>/);
  assert.doesNotMatch(html, /<strong>复杂任务<\/strong>/);
  assert.doesNotMatch(html, /<strong>提交 Git<\/strong>/);
});

test('Git 开关默认开启且由模板决定是否显示', () => {
  assert.match(html, /id="gitCommitInput"[^>]*checked/);
  assert.match(html, /function selectedPipelineMode\(\)/);
  assert.match(html, /gitCommit:pipelineMode&&state\.project\?\.git_enabled/);
});

test('Plan 模式不再与流水线互斥', () => {
  assert.doesNotMatch(html, /pipelineInput\.checked=false/);
  assert.doesNotMatch(html, /complexInput\.disabled/);
  assert.match(html, /isComplex:\$\('planInput'\)\.checked/);
});

test('新建任务入口位于看板工具栏并使用弹窗承载表单', () => {
  assert.match(html, /id="openCreateTaskBtn"[^>]*class="primary"/);
  assert.match(html, /id="createTaskModal" class="modal-backdrop hidden"/);
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="createTaskTitle"/);
  assert.match(html, /id="createTaskCloseBtn"/);
  assert.match(html, /id="createTaskCancelBtn"/);
  assert.match(html, /function openCreateTaskModal\(\)/);
  assert.match(html, /function closeCreateTaskModal\(\)/);
});
