#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { scheduleBoardRestart } = require('../deploy-restart');

/**
 * Schedule a safe board restart and exit immediately.
 * Suitable for pipeline self-deploy: does not kill the current server inline.
 * @author Amadeus
 */
function main() {
  const root = path.join(__dirname, '..');
  const configPath = path.join(root, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const port = config.server?.port || 3920;
  const delayMs = Number(process.env.BOARD_DEPLOY_DELAY_MS || 3000);

  const result = scheduleBoardRestart({ root, port, delayMs });
  console.log('[DEPLOY] 已预约看板重启（安全自部署）');
  console.log(`[DEPLOY] ${delayMs}ms 后将释放端口 ${port} 并启动新服务`);
  console.log(`[DEPLOY] workerPid=${result.workerPid || 'n/a'}`);
  console.log('[DEPLOY] 当前任务可先正常结束，无需立刻 kill 本进程');
  process.exit(0);
}

main();
