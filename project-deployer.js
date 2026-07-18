const { spawn } = require('child_process');
const { buildDeployRepairPrompt } = require('./pipeline');
const WorkdirLock = require('./workdir-lock');

function projectWorkdirPaths(project) {
  const entries = Array.isArray(project?.workdirs) && project.workdirs.length
    ? project.workdirs.map((entry) => entry?.path)
    : [];
  return WorkdirLock.normalizePaths([project?.workdir, ...entries]);
}

/**
 * Project-level batch deployment with optional Agent-assisted repair.
 * @author Amadeus
 */
class ProjectDeployer {
  constructor({
    projects,
    repo,
    runner,
    broadcast,
    executeCommand = runCommand,
    workdirLock,
  }) {
    this.projects = projects;
    this.repo = repo;
    this.runner = runner;
    this.broadcast = broadcast || (() => {});
    this.executeCommand = executeCommand;
    this.activeProjects = new Set();
    this.workdirLock = workdirLock || new WorkdirLock();
  }

  async deployProject(projectId) {
    if (this.activeProjects.has(projectId)) throw new Error('项目正在部署中');
    const project = this.requireDeployableProject(projectId);
    const tasks = this.repo.listProjectPendingDeployTasks(projectId);
    this.activeProjects.add(projectId);
    const lockOwner = `deploy:${projectId}`;
    await this.workdirLock.acquire(lockOwner, projectWorkdirPaths(project));
    try {
      return await this.executeDeployment(project, tasks);
    } finally {
      this.workdirLock.release(lockOwner);
      this.activeProjects.delete(projectId);
    }
  }

  async approveRepair(projectId, approved) {
    if (!approved) {
      const project = this.projects.updateDeployState(projectId, {
        deploy_status: 'failed',
      });
      this.broadcast('project:deploy', project);
      return { status: 'failed', project };
    }
    if (this.activeProjects.has(projectId)) throw new Error('项目正在部署中');
    const project = this.requireDeployableProject(projectId);
    if (project.deploy_status !== 'awaiting_fix') throw new Error('项目当前没有等待修复的部署');
    const tasks = this.repo.listProjectPendingDeployTasks(projectId);
    if (!this.runner) throw new Error('Agent Runner 未配置');

    this.activeProjects.add(projectId);
    const lockOwner = `deploy:${projectId}`;
    await this.workdirLock.acquire(lockOwner, projectWorkdirPaths(project));
    try {
      this.projects.updateDeployState(projectId, {
        deploy_status: 'fixing',
        deploy_started_at: new Date().toISOString(),
      });
      this.broadcast('project:deploy', this.projects.getProject(projectId));
      const owner = tasks[tasks.length - 1] || null;
      const errorOutput = project.deploy_error || '未知部署错误';
      await this.runner.runTask({
        taskId: `deploy-repair-${projectId}`,
        workdir: project.workdir,
        prompt: buildDeployRepairPrompt(project.deploy_command, errorOutput),
        mode: 'agent',
        modelId: owner?.model_id,
        onEvent: (type, payload) => {
          if (!owner) return;
          if (type === 'log') {
            this.repo.addEvent(owner.id, 'deploy_repair_log', payload);
            this.broadcast('task:log', { id: owner.id, ...payload });
          }
          if (type === 'permission') {
            this.repo.addEvent(owner.id, 'permission', payload);
            this.broadcast('task:permission', { id: owner.id, ...payload });
          }
        },
      });
      return await this.executeDeployment(project, tasks, 'failed');
    } catch (error) {
      if (this.projects.getProject(projectId).deploy_status === 'fixing') {
        return this.handleFailure(project, tasks, error, 'failed');
      }
      throw error;
    } finally {
      this.workdirLock.release(lockOwner);
      this.activeProjects.delete(projectId);
    }
  }

  requireDeployableProject(projectId) {
    const project = this.projects.getProject(projectId);
    if (!project) throw new Error('项目不存在');
    if (project.type === 'machine') throw new Error('本机项目不支持部署');
    if (!String(project.deploy_command || '').trim()) throw new Error('项目未配置部署命令');
    return project;
  }

  async executeDeployment(project, tasks, failureStatus = 'awaiting_fix') {
    const ids = tasks.map((task) => task.id);
    this.repo.markDeploying(ids);
    const startedAt = new Date().toISOString();
    this.projects.updateDeployState(project.id, {
      deploy_status: 'deploying',
      deploy_error: null,
      deploy_started_at: startedAt,
      deploy_finished_at: null,
    });
    this.broadcastProjectAndTasks(project.id, tasks);
    try {
      const output = await this.executeCommand(project.deploy_command, {
        cwd: project.workdir,
      });
      this.repo.markDeployCompleted(ids);
      for (const task of tasks) {
        this.repo.addEvent(task.id, 'project_deploy', {
          command: project.deploy_command,
          stdout: output.stdout || '',
          stderr: output.stderr || '',
          status: 'success',
        });
        this.repo.addEvent(task.id, 'status_change', {
          status: 'done',
          reason: 'project_deploy',
        });
      }
      const updated = this.projects.updateDeployState(project.id, {
        deploy_status: 'success',
        deploy_error: null,
        deploy_finished_at: new Date().toISOString(),
      });
      this.broadcastProjectAndTasks(project.id, tasks);
      return { status: 'success', project: updated, taskIds: ids, output };
    } catch (error) {
      return this.handleFailure(project, tasks, error, failureStatus);
    }
  }

  handleFailure(project, tasks, error, deployStatus) {
    const ids = tasks.map((task) => task.id);
    const message = formatCommandError(error);
    this.repo.markDeployPending(ids, message);
    for (const task of tasks) {
      this.repo.addEvent(task.id, 'project_deploy', {
        command: project.deploy_command,
        status: 'failed',
        error: message,
      });
      this.repo.addEvent(task.id, 'status_change', {
        status: 'pending_deploy',
        reason: 'project_deploy_failed',
      });
    }
    const updated = this.projects.updateDeployState(project.id, {
      deploy_status: deployStatus,
      deploy_error: message,
      deploy_finished_at: new Date().toISOString(),
    });
    this.broadcastProjectAndTasks(project.id, tasks);
    return { status: deployStatus, project: updated, taskIds: ids, error: message };
  }

  broadcastProjectAndTasks(projectId, tasks) {
    this.broadcast('project:deploy', this.projects.getProject(projectId));
    for (const task of tasks) {
      this.broadcast('task:status', this.repo.getTask(task.id));
    }
  }
}

function runCommand(command, { cwd, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const append = (current, chunk) => (current + chunk.toString()).slice(-1024 * 1024);
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error(`部署命令超时（${timeoutMs}ms）`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }
      const error = new Error(`部署命令退出，code=${code}`);
      error.stdout = stdout;
      error.stderr = stderr;
      error.code = code;
      reject(error);
    });
  });
}

function formatCommandError(error) {
  return [
    String(error?.message || error || '部署失败'),
    error?.stdout ? `stdout:\n${error.stdout}` : '',
    error?.stderr ? `stderr:\n${error.stderr}` : '',
  ].filter(Boolean).join('\n').slice(0, 8000);
}

module.exports = ProjectDeployer;
module.exports.runCommand = runCommand;
module.exports.formatCommandError = formatCommandError;
