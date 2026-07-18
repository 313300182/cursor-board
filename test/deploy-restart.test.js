const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const {
  buildRestartPlan,
  scheduleBoardRestart,
  writePidFile,
  readPidFile,
  clearPidFile,
} = require('../deploy-restart');

test('buildRestartPlan 生成延迟重启计划且不立即杀进程', () => {
  const plan = buildRestartPlan({
    root: 'D:\\board',
    port: 3920,
    delayMs: 2500,
    nodeBin: 'node.exe',
  });

  assert.equal(plan.delayMs, 2500);
  assert.equal(plan.port, 3920);
  assert.equal(plan.serverEntry, path.join('D:\\board', 'server.js'));
  assert.equal(plan.workerEntry, path.join('D:\\board', 'scripts', 'restart-board-worker.js'));
  assert.equal(plan.immediateKill, false);
});

test('scheduleBoardRestart 以 detached 方式预约重启并立即返回', () => {
  const calls = [];
  const result = scheduleBoardRestart({
    root: 'D:\\board',
    port: 3920,
    delayMs: 3000,
    nodeBin: 'node.exe',
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      return { unref() { this.unrefed = true; }, unrefed: false, pid: 12345 };
    },
  });

  assert.equal(result.scheduled, true);
  assert.equal(result.delayMs, 3000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'node.exe');
  assert.equal(calls[0].args[0], path.join('D:\\board', 'scripts', 'restart-board-worker.js'));
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(calls[0].options.windowsHide, true);
  assert.match(calls[0].args.join(' '), /--delay=3000/);
  assert.match(calls[0].args.join(' '), /--port=3920/);
});

test('pid 文件读写与清理', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-pid-'));
  const pidPath = path.join(dir, 'server.pid');
  writePidFile(pidPath, 4242);
  assert.equal(readPidFile(pidPath), 4242);
  clearPidFile(pidPath);
  assert.equal(readPidFile(pidPath), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
