const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'),
  'utf8',
);

test('项目页使用部署按钮且不再展示部署列', () => {
  assert.match(html, /id="deployProjectBtn"/);
  assert.match(html, /id="deployCommandInput"/);
  assert.doesNotMatch(html, /data-group="deploy"/);
});

test('本机项目会隐藏项目部署区域', () => {
  assert.match(html, /project\.type==='machine'/);
  assert.match(html, /projectDeployBar/);
});

test('部署失败提供批准 Agent 修复按钮', () => {
  assert.match(html, /id="approveDeployFixBtn"/);
  assert.match(html, /respondDeployRepair\(true\)/);
});
