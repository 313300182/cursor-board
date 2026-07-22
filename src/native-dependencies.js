const { spawnSync } = require('node:child_process');
const path = require('node:path');

function isBetterSqlite3AbiError(error) {
  return error?.code === 'ERR_DLOPEN_FAILED'
    && /NODE_MODULE_VERSION/i.test(String(error.message || ''));
}

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function rebuildBetterSqlite3() {
  const result = spawnSync(
    getNpmCommand(),
    ['rebuild', 'better-sqlite3', '--no-audit', '--no-fund'],
    {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      shell: process.platform === 'win32',
      windowsHide: false,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`better-sqlite3 自动重编译失败，npm 退出码：${result.status}`);
  }
}

function loadBetterSqlite3() {
  try {
    const Database = require('better-sqlite3');
    const probe = new Database(':memory:');
    probe.close();
    return Database;
  } catch (error) {
    if (!isBetterSqlite3AbiError(error)) throw error;

    console.warn(
      `[native-deps] 检测到 better-sqlite3 与当前 Node.js ABI (${process.versions.modules}) 不匹配，正在自动重编译...`,
    );
    rebuildBetterSqlite3();

    try {
      const Database = require('better-sqlite3');
      const probe = new Database(':memory:');
      probe.close();
      return Database;
    } catch (retryError) {
      retryError.message = `${retryError.message}\n请确认使用当前 Node.js 执行 npm install，或手动运行 npm rebuild better-sqlite3。`;
      throw retryError;
    }
  }
}

module.exports = {
  isBetterSqlite3AbiError,
  loadBetterSqlite3,
};
