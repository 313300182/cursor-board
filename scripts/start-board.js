#!/usr/bin/env node
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const configPath = path.join(root, 'config.json');
const logPath = path.join(root, 'data', 'server.log');

/**
 * 在后台启动 Cursor Board，避免重复占用服务端口。
 * @author Amadeus
 */
function loadPort() {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return Number(config.server && config.server.port) || 3920;
  } catch {
    return 3920;
  }
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function main() {
  const port = loadPort();
  if (await isPortOpen(port)) {
    console.log(`Cursor Board 已在端口 ${port} 运行，无需重复启动。`);
    return;
  }

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(log);

  console.log(`Cursor Board 已后台启动，PID: ${child.pid || '未知'}`);
  console.log(`日志: ${logPath}`);
}

main().catch((error) => {
  console.error(`启动失败: ${error.message}`);
  process.exitCode = 1;
});
