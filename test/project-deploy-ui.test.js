const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'),
  'utf8',
);

test('项目页使用部署按钮并展示待部署看板列', () => {
  assert.match(html, /id="deployProjectBtn"/);
  assert.match(html, /id="deployCommandInput"/);
  assert.match(html, /id="projectConfigModal"/);
  assert.match(html, /data-group="deploy"/);
  assert.match(html, /待部署/);
  assert.match(html, /grid-template-columns:repeat\(5,/);
  assert.match(html, /id="boardProblems"/);
});

test('本机项目会隐藏项目部署区域', () => {
  assert.match(html, /project\.type==='machine'/);
  assert.match(html, /projectActionsBar/);
});

test('部署按钮在无待部署任务时仍可点击', () => {
  assert.match(html, /deployProjectBtn'\)\.disabled=!state\.project\.deploy_command/);
  assert.doesNotMatch(html, /deployProjectBtn'\)\.disabled=!pending/);
});

test('项目页提供 Cursor Rules 弹窗入口', () => {
  assert.match(html, /id="rulesBtn"/);
  assert.match(html, /id="rulesModal"/);
  assert.match(html, /openRulesModal/);
  assert.doesNotMatch(html, /id="rulesPanel"/);
});

test('项目页提供 Cursor Skills 弹窗入口', () => {
  assert.match(html, /id="skillsBtn"/);
  assert.match(html, /id="skillsModal"/);
  assert.match(html, /openSkillsModal/);
  assert.doesNotMatch(html, /id="skillsPanel"/);
});
