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

test('环境信息展示检测到的 Node.js 和 npm 版本', () => {
  const result = getPlatformCompatibility({}, 'win32', {
    nodeVersion: 'v22.14.0',
    npmVersion: '10.9.2',
    npmAvailable: true,
  });

  assert.deepEqual(result.runtime, {
    nodeVersion: 'v22.14.0',
    npmVersion: '10.9.2',
    npmAvailable: true,
  });
  assert.equal(result.items.find((item) => item.id === 'node').detail, 'Node.js v22.14.0 · npm 10.9.2');
});
