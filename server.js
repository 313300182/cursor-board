const { openDb, createProjectRepo, createTaskRepo, createChatRepo } = require('./db');
const TaskQueue = require('./queue');
const ChatService = require('./chat-service');
const { writePidFile, clearPidFile } = require('./deploy-restart');
const ProjectDeployer = require('./project-deployer');
const {
  ROOT,
  PID_PATH,
  TOKEN_PATH,
  PASSWORD_PATH,
  loadConfig,
  assertSafeHost,
  getPort,
} = require('./src/config');
const { createAuthService } = require('./src/auth-service');
const { createBroadcaster } = require('./src/sse/broadcaster');
const { createApp } = require('./src/app');

function main() {
  const config = loadConfig();
  const host = assertSafeHost(config);
  const port = getPort(config);
  const authService = createAuthService({
    passwordPath: PASSWORD_PATH,
    tokenPath: TOKEN_PATH,
    initialPassword: '123456',
  });

  const db = openDb();
  const repo = createTaskRepo(db);
  const chatRepo = createChatRepo(db);
  const projects = createProjectRepo(db);
  const machineProject = projects.ensureMachineProject();
  repo.assignUnscopedTasks(machineProject.id);
  projects.ensureDeployCommandForWorkdir(ROOT, 'npm run deploy');
  const recovered = repo.recoverStaleRunning();
  const recoveredChats = chatRepo.recoverStaleRunning();
  const broadcaster = createBroadcaster();
  const queue = new TaskQueue({
    repo,
    projects,
    config,
    broadcast: (event, data) => broadcaster.send(event, data),
  });
  const projectDeployer = new ProjectDeployer({
    projects,
    repo,
    runner: queue.runner,
    broadcast: (event, data) => broadcaster.send(event, data),
    workdirLock: queue.workdirLock,
  });
  const chatService = new ChatService({
    chatRepo,
    projects,
    config,
    broadcast: (event, data) => broadcaster.send(event, data),
    runner: queue.runner,
  });

  const app = createApp({
    config,
    authService,
    repo,
    projects,
    queue,
    projectDeployer,
    chatService,
    broadcaster,
    root: ROOT,
  });

  app.listen(port, host, () => {
    writePidFile(PID_PATH, process.pid);
    const cleanupPid = () => clearPidFile(PID_PATH);
    process.once('exit', cleanupPid);
    process.once('SIGINT', () => {
      cleanupPid();
      process.exit(0);
    });
    process.once('SIGTERM', () => {
      cleanupPid();
      process.exit(0);
    });
    console.log('');
    console.log('========================================');
    console.log('  Cursor Board MVP 已启动');
    console.log(`  地址: http://${host}:${port}`);
    console.log('  访问保护: 已启用密码登录');
    console.log(`  恢复中断任务: ${recovered}`);
    console.log(`  恢复中断对话: ${recoveredChats}`);
    console.log('========================================');
    console.log('');
    queue.kick();
  });
}

main();
