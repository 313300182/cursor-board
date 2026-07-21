const assert = require('node:assert/strict');
const test = require('node:test');

const { getPlatformCompatibility } = require('../src/platform-compatibility');

test('macOS 兼容性清单识别 Unix 工作目录配置', () => {
  const result = getPlatformCompatibility({
    security: { workdirAllowlist: ['/Users/amadeus/code'] },
  }, 'darwin');

  assert.equal(result.current, 'darwin');
  assert.equal(result.label, 'macOS');
  assert.equal(result.items.find((item) => item.id === 'workspace').available, true);
  assert.equal(result.items.find((item) => item.id === 'background').available, false);
});

test('Windows 盘符白名单会提示 Mac 工作目录尚未配置', () => {
  const result = getPlatformCompatibility({
    security: { workdirAllowlist: ['C:\\', 'D:\\'] },
  }, 'win32');

  assert.equal(result.items.find((item) => item.id === 'workspace').available, false);
  assert.match(
    result.items.find((item) => item.id === 'workspace').detail,
    /\/Users/,
  );
});
