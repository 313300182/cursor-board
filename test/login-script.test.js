const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('index.html 内联脚本语法有效且无 renderInteraction 重复声明', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const start = html.lastIndexOf('<script>');
  const end = html.indexOf('</script>', start);
  const script = html.slice(start + '<script>'.length, end);
  assert.doesNotThrow(() => {
    new vm.Script(script, { filename: 'index-inline.js' });
  });
  assert.match(script, /renderInteraction:\s*renderChatInteraction/);
  assert.match(script, /loginForm'\)\.onsubmit=submitLogin/);
});
