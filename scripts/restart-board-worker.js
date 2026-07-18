#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const {
  parseArgs,
  readPidFile,
  clearPidFile,
  writePidFile,
} = require('../deploy-restart');

/**
 * Detached worker: wait, stop old listener, start new board server.
 * @author Amadeus
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  const root = process.env.BOARD_ROOT || path.join(__dirname, '..');
  const logPath = path.join(root, 'data', 'deploy.log');
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line, 'utf8');
  } catch {
    // ignore
  }
  process.stdout.write(line);
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopPid(pid) {
  if (!pid || !isPidAlive(pid)) return false;
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

function findListenerPidWindows(port) {
  try {
    const { execSync } = require('child_process');
    const output = execSync('netstat -ano', { encoding: 'utf8' });
    const lines = output.split(/\r?\n/);
    const needle = `:${port}`;
    for (const line of lines) {
      if (!line.includes('LISTENING')) continue;
      if (!line.includes(needle)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  } catch {
    // ignore
  }
  return null;
}

async function waitPortFree(port, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const free = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true));
      });
    });
    if (free) return true;
    await sleep(300);
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root || path.join(__dirname, '..');
  process.env.BOARD_ROOT = root;
  const port = Number(args.port || 3920);
  const delayMs = Number(args.delay || 3000);
  const pidPath = path.join(root, 'data', 'server.pid');

  log(`restart worker started delay=${delayMs}ms port=${port}`);
  await sleep(delayMs);

  const pidFromFile = readPidFile(pidPath);
  const pidFromPort = process.platform === 'win32'
    ? findListenerPidWindows(port)
    : null;
  const targetPid = pidFromFile || pidFromPort;

  if (targetPid && targetPid !== process.pid) {
    log(`stopping old server pid=${targetPid}`);
    stopPid(targetPid);
    await sleep(500);
    if (isPidAlive(targetPid)) {
      try {
        process.kill(targetPid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  } else {
    log('no old server pid found, continue start');
  }

  clearPidFile(pidPath);
  const free = await waitPortFree(port);
  if (!free) {
    log(`port ${port} still busy, abort start`);
    process.exit(1);
  }

  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  if (child.pid) writePidFile(pidPath, child.pid);
  log(`new server started pid=${child.pid || 'n/a'}`);
  process.exit(0);
}

main().catch((error) => {
  log(`restart failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
