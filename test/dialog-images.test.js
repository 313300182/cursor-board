const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('迭代弹窗支持粘贴图片', () => {
  assert.match(html, /id="iteratePasteImageBtn"/);
  assert.match(html, /id="iterateImageInput"/);
  assert.match(html, /data-image-list="iterateRequirement"/);
  assert.match(html, /setupImageField\('iterateRequirement'/);
  assert.match(html, /readClipboardImageFiles/);
  assert.match(html, /extractImageFilesFromClipboardData/);
  assert.match(html, /if\(event\.defaultPrevented\)return;/);
});

test('任务卡片执行中对话支持粘贴图片', () => {
  assert.match(html, /id="steerPasteImageBtn"/);
  assert.match(html, /id="steerImageInput"/);
  assert.match(html, /data-image-list="steerMessage"/);
  assert.match(html, /setupImageField\('steerMessage'/);
  assert.match(html, /steerDraft/);
});
