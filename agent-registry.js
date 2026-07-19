const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * 记录本进程 spawn 出的 agent 根进程 pid，用于跨重启回收孤儿进程。
 *
 * 看板重新部署/崩溃时旧 Node 进程被杀，但它 spawn 的 agent 进程树（Windows 上
 * 为 cmd.exe -> agent）不会被连带杀死。新看板启动时读取本账本，核对命令行确实
 * 是我们的 agent 后再 killProcessTree，避免 Windows pid 复用误杀无关进程。
 * @author Amadeus
 */

function ledgerPath(root) {
  return path.join(root, 'data', 'agent-pids.json');
}

function readLedger(root) {
  try {
    const data = JSON.parse(fs.readFileSync(ledgerPath(root), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeLedger(root, ledger) {
  try {
    const target = ledgerPath(root);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(ledger), 'utf8');
  } catch {
    // best effort，账本丢失不影响主流程
  }
}

function recordPid(root, entry) {
  if (!entry || !entry.pid) return;
  const ledger = readLedger(root);
  ledger[String(entry.pid)] = {
    taskId: entry.taskId || null,
    spawnAt: entry.spawnAt || Date.now(),
  };
  writeLedger(root, ledger);
}

function removePid(root, pid) {
  if (!pid) return;
  const ledger = readLedger(root);
  if (ledger[String(pid)]) {
    delete ledger[String(pid)];
    writeLedger(root, ledger);
  }
}

function queryCommandLines(pids) {
  const result = new Map();
  if (!pids.length) return result;
  try {
    if (process.platform === 'win32') {
      const filter = pids.map((pid) => `ProcessId=${Number(pid)}`).join(' or ');
      const script = `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { [Console]::WriteLine((\"{0}|{1}\" -f $_.ProcessId, $_.CommandLine)) }`;
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', script,
      ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      for (const line of String(out || '').split(/\r?\n/)) {
        const idx = line.indexOf('|');
        if (idx <= 0) continue;
        const pid = Number(line.slice(0, idx).trim());
        if (Number.isFinite(pid)) result.set(pid, line.slice(idx + 1).trim());
      }
    } else {
      const out = execFileSync('ps', [
        '-p', pids.join(','), '-o', 'pid=,command=',
      ], { encoding: 'utf8', timeout: 10000 });
      for (const line of String(out || '').split(/\r?\n/)) {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        if (match) result.set(Number(match[1]), match[2]);
      }
    }
  } catch {
    // 查询失败时返回已收集到的部分（可能为空），调用方按“不确定就不杀”处理
  }
  return result;
}

function isOurAgent(commandLine) {
  const cmd = String(commandLine || '').toLowerCase();
  return Boolean(cmd) && cmd.includes('agent') && cmd.includes('acp');
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5000,
      });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // ignore：进程可能已退出
  }
}

/**
 * 启动清扫：杀掉上一代看板遗留、且命令行确认仍是我们 agent 的孤儿进程。
 * @returns {{total:number, killed:number, pids:number[]}}
 */
function sweep(root, { log, queryFn = queryCommandLines, killFn = killTree } = {}) {
  const ledger = readLedger(root);
  const pids = Object.keys(ledger)
    .map((value) => Number(value))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
  const killed = [];
  if (pids.length) {
    const cmdLines = queryFn(pids);
    for (const pid of pids) {
      if (!cmdLines.has(pid)) continue; // 进程已不存在
      if (!isOurAgent(cmdLines.get(pid))) continue; // pid 已被复用为无关进程，跳过
      killFn(pid);
      killed.push(pid);
      if (typeof log === 'function') {
        log(`[reclaim] 清理上一代残留 agent 进程 pid=${pid} task=${ledger[String(pid)]?.taskId || 'n/a'}`);
      }
    }
  }
  writeLedger(root, {});
  return { total: pids.length, killed: killed.length, pids: killed };
}

module.exports = {
  ledgerPath,
  readLedger,
  writeLedger,
  recordPid,
  removePid,
  queryCommandLines,
  isOurAgent,
  killTree,
  sweep,
};
