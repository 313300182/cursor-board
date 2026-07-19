const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const registry = require('../agent-registry');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-reg-'));
}

test('recordPid/removePid 维护账本', () => {
  const root = tempRoot();
  registry.recordPid(root, { pid: 111, taskId: 't1' });
  registry.recordPid(root, { pid: 222, taskId: 't2' });
  let ledger = registry.readLedger(root);
  assert.deepEqual(Object.keys(ledger).sort(), ['111', '222']);
  assert.equal(ledger['111'].taskId, 't1');

  registry.removePid(root, 111);
  ledger = registry.readLedger(root);
  assert.deepEqual(Object.keys(ledger), ['222']);
});

test('sweep 只杀命令行确认是我们 agent 的进程，规避 pid 复用', () => {
  const root = tempRoot();
  registry.recordPid(root, { pid: 111, taskId: 't1' }); // 仍是我们的 agent
  registry.recordPid(root, { pid: 222, taskId: 't2' }); // pid 已被复用为无关进程
  registry.recordPid(root, { pid: 333, taskId: 't3' }); // 进程已不存在

  const killed = [];
  const result = registry.sweep(root, {
    queryFn: () => new Map([
      [111, 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "C:\\...\\agent.cmd" acp'],
      [222, 'C:\\WINDOWS\\notepad.exe'],
    ]),
    killFn: (pid) => killed.push(pid),
  });

  assert.deepEqual(killed, [111]);
  assert.equal(result.killed, 1);
  assert.equal(result.total, 3);
  // 清扫后账本清空
  assert.deepEqual(registry.readLedger(root), {});
});

test('isOurAgent 判定命令行', () => {
  assert.equal(registry.isOurAgent('cmd /c "agent.cmd" acp'), true);
  assert.equal(registry.isOurAgent('C:\\some\\cursor-agent acp'), true);
  assert.equal(registry.isOurAgent('notepad.exe'), false);
  assert.equal(registry.isOurAgent(''), false);
  assert.equal(registry.isOurAgent(null), false);
});
