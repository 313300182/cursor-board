const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REBUILD_LOCK_PATH = path.resolve(
  __dirname,
  '..',
  'node_modules',
  '.better-sqlite3-rebuild.lock',
);
const REBUILD_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const REBUILD_LOCK_WAIT_MS = 100;
const REBUILD_TIMEOUT_MS = 10 * 60 * 1000;

function isBetterSqlite3AbiError(error) {
  return error?.code === 'ERR_DLOPEN_FAILED'
    && /NODE_MODULE_VERSION/i.test(String(error.message || ''));
}

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function waitForRebuildLock() {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  const startedAt = Date.now();

  while (true) {
    try {
      fs.mkdirSync(REBUILD_LOCK_PATH);
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const age = Date.now() - fs.statSync(REBUILD_LOCK_PATH).mtimeMs;
        if (age > REBUILD_LOCK_TIMEOUT_MS) {
          fs.rmSync(REBUILD_LOCK_PATH, { recursive: true, force: true });
          continue;
        }
      } catch {
        // 锁目录可能正在被其他进程创建或释放，继续等待即可。
      }
      if (Date.now() - startedAt > REBUILD_LOCK_TIMEOUT_MS) {
        throw new Error('better-sqlite3 自动重编译等待超时，可能存在未退出的重编译进程');
      }
      Atomics.wait(waitBuffer, 0, 0, REBUILD_LOCK_WAIT_MS);
    }
  }
}

function releaseRebuildLock() {
  try {
    fs.rmSync(REBUILD_LOCK_PATH, { recursive: true, force: true });
  } catch {
    // 退出路径尽力释放锁，不覆盖重编译结果。
  }
}

function rebuildBetterSqlite3() {
  waitForRebuildLock();
  try {
    // 获锁后其他进程可能已经完成了重编译，避免重复执行 npm。
    try {
      const Database = require('better-sqlite3');
      const probe = new Database(':memory:');
      probe.close();
      return;
    } catch (error) {
      if (!isBetterSqlite3AbiError(error)) throw error;
    }

    const result = spawnSync(
      getNpmCommand(),
      ['rebuild', 'better-sqlite3', '--no-audit', '--no-fund'],
      {
        cwd: path.resolve(__dirname, '..'),
        stdio: 'inherit',
        shell: process.platform === 'win32',
        windowsHide: false,
        timeout: REBUILD_TIMEOUT_MS,
        env: {
          ...process.env,
          // 当前环境无法稳定访问预编译包下载地址，直接使用本机编译工具链。
          npm_config_build_from_source: 'true',
        },
      },
    );
    if (result.error) throw result.error;
    if (result.signal) {
      throw new Error(`better-sqlite3 自动重编译超时（${REBUILD_TIMEOUT_MS / 1000} 秒）`);
    }
    if (result.status !== 0) {
      throw new Error(`better-sqlite3 自动重编译失败，npm 退出码：${result.status}`);
    }
  } finally {
    releaseRebuildLock();
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
