const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const { ensureSchema, createProjectRepo, createTaskRepo } = require('../db');
const ProjectDeployer = require('../project-deployer');

function createRepos() {
  const db = new Database(':memory:');
  ensureSchema(db);
  return {
    db,
    projects: createProjectRepo(db),
    tasks: createTaskRepo(db),
  };
}

function createProject(projects, overrides = {}) {
  return projects.createProject({
    id: 'board',
    name: 'Board',
    type: 'normal',
    workdir: process.cwd(),
    deploy_command: 'npm run deploy',
    created_at: new Date().toISOString(),
    ...overrides,
  });
}

function createPendingTask(tasks, id) {
  return tasks.createTask({
    id,
    project_id: 'board',
    title: id,
    template: 'general',
    variables: {},
    attachments: [],
    workdir: process.cwd(),
    status: 'pending_deploy',
    is_complex: false,
    pipeline_mode: true,
    model_id: 'model',
    prompt_rendered: id,
    created_at: new Date().toISOString(),
  });
}

test('项目保存部署命令，本机项目始终没有部署能力', () => {
  const { db, projects } = createRepos();
  const machine = projects.ensureMachineProject();
  const project = createProject(projects);

  assert.equal(project.deploy_command, 'npm run deploy');
  assert.equal(machine.deploy_command, null);
  assert.throws(
    () => projects.updateDeployCommand(machine.id, 'echo bad'),
    /本机项目不支持部署/,
  );
  db.close();
});

test('无待部署任务时仍可执行项目部署命令', async () => {
  const { db, projects, tasks } = createRepos();
  createProject(projects);
  let invoked = false;
  const deployer = new ProjectDeployer({
    projects,
    repo: tasks,
    broadcast() {},
    executeCommand: async () => {
      invoked = true;
      return { stdout: 'redeployed', stderr: '' };
    },
  });

  const result = await deployer.deployProject('board');

  assert.equal(invoked, true);
  assert.equal(result.status, 'success');
  assert.equal(projects.getProject('board').deploy_status, 'success');
  db.close();
});

test('部署成功后一次性完成项目全部待部署任务', async () => {
  const { db, projects, tasks } = createRepos();
  createProject(projects);
  createPendingTask(tasks, 'one');
  createPendingTask(tasks, 'two');
  const deployer = new ProjectDeployer({
    projects,
    repo: tasks,
    broadcast() {},
    executeCommand: async () => ({ stdout: 'deployed', stderr: '' }),
  });

  const result = await deployer.deployProject('board');

  assert.equal(result.status, 'success');
  assert.equal(tasks.getTask('one').status, 'done');
  assert.equal(tasks.getTask('two').status, 'done');
  assert.equal(tasks.getTask('one').deploy_completed, true);
  assert.equal(projects.getProject('board').deploy_status, 'success');
  db.close();
});

test('部署失败时任务保持待部署并等待批准 Agent 修复', async () => {
  const { db, projects, tasks } = createRepos();
  createProject(projects);
  createPendingTask(tasks, 'one');
  const deployer = new ProjectDeployer({
    projects,
    repo: tasks,
    broadcast() {},
    executeCommand: async () => {
      const error = new Error('exit 1');
      error.stdout = '';
      error.stderr = 'boom';
      throw error;
    },
  });

  const result = await deployer.deployProject('board');

  assert.equal(result.status, 'awaiting_fix');
  assert.equal(tasks.getTask('one').status, 'pending_deploy');
  assert.match(projects.getProject('board').deploy_error, /boom/);
  db.close();
});

test('批准修复后 Agent 修复并自动重试一次部署', async () => {
  const { db, projects, tasks } = createRepos();
  createProject(projects);
  createPendingTask(tasks, 'one');
  let commandAttempts = 0;
  let repairPrompt = '';
  const runner = {
    async runTask(options) {
      repairPrompt = options.prompt;
      return { resultSummary: 'fixed' };
    },
  };
  const deployer = new ProjectDeployer({
    projects,
    repo: tasks,
    runner,
    broadcast() {},
    executeCommand: async () => {
      commandAttempts += 1;
      if (commandAttempts === 1) {
        const error = new Error('exit 1');
        error.stderr = 'boom';
        throw error;
      }
      return { stdout: 'ok', stderr: '' };
    },
  });

  await deployer.deployProject('board');
  const result = await deployer.approveRepair('board', true);

  assert.equal(result.status, 'success');
  assert.equal(commandAttempts, 2);
  assert.match(repairPrompt, /boom/);
  assert.match(repairPrompt, /npm run deploy/);
  assert.equal(tasks.getTask('one').status, 'done');
  db.close();
});

test('Agent 修复后重试仍失败则停止自动修复并保留待部署', async () => {
  const { db, projects, tasks } = createRepos();
  createProject(projects);
  createPendingTask(tasks, 'one');
  const runner = {
    async runTask() {
      return { resultSummary: 'fixed' };
    },
  };
  const deployer = new ProjectDeployer({
    projects,
    repo: tasks,
    runner,
    broadcast() {},
    executeCommand: async () => {
      const error = new Error('still broken');
      error.stderr = 'retry failed';
      throw error;
    },
  });

  await deployer.deployProject('board');
  const result = await deployer.approveRepair('board', true);

  assert.equal(result.status, 'failed');
  assert.equal(tasks.getTask('one').status, 'pending_deploy');
  assert.equal(projects.getProject('board').deploy_status, 'failed');
  db.close();
});
