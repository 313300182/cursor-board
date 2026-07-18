const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Safe self-restart helpers for Cursor Board deployment.
 * Schedule restart in a detached worker so the current ACP/server session can finish.
 * @author Amadeus
 */

function buildRestartPlan({ root, port, delayMs = 2500, nodeBin = process.execPath }) {
  return {
    root,
    port: Number(port),
    delayMs: Number(delayMs),
    nodeBin,
    serverEntry: path.join(root, 'server.js'),
    workerEntry: path.join(root, 'scripts', 'restart-board-worker.js'),
    immediateKill: false,
  };
}

function scheduleBoardRestart({
  root,
  port,
  delayMs = 2500,
  nodeBin = process.execPath,
  spawnFn = spawn,
}) {
  const plan = buildRestartPlan({ root, port, delayMs, nodeBin });
  const child = spawnFn(plan.nodeBin, [
    plan.workerEntry,
    `--root=${plan.root}`,
    `--port=${plan.port}`,
    `--delay=${plan.delayMs}`,
  ], {
    cwd: plan.root,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (typeof child.unref === 'function') child.unref();
  return {
    scheduled: true,
    delayMs: plan.delayMs,
    port: plan.port,
    workerPid: child.pid || null,
  };
}

function writePidFile(pidPath, pid) {
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, String(pid), 'utf8');
}

function readPidFile(pidPath) {
  try {
    if (!fs.existsSync(pidPath)) return null;
    const value = Number(String(fs.readFileSync(pidPath, 'utf8')).trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function clearPidFile(pidPath) {
  try {
    if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
  } catch {
    // ignore
  }
}

function parseArgs(argv) {
  const result = {};
  for (const item of argv) {
    const match = String(item).match(/^--([^=]+)=(.*)$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

module.exports = {
  buildRestartPlan,
  scheduleBoardRestart,
  writePidFile,
  readPidFile,
  clearPidFile,
  parseArgs,
};
