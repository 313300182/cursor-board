const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { openDb, createProjectRepo, createTaskRepo, ensureDataDir, DATA_DIR, normalizeWorkdirs } = require('./db');
const { loadTemplates } = require('./templates');
const { scanProjectRulesForWorkdirs } = require('./project-rules');
const TaskQueue = require('./queue');
const { getModelSettings } = require('./model-config');
const { writePidFile, clearPidFile } = require('./deploy-restart');
const ProjectDeployer = require('./project-deployer');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const TOKEN_PATH = path.join(DATA_DIR, '.token');
const PID_PATH = path.join(DATA_DIR, 'server.pid');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function loadOrCreateToken() {
  ensureDataDir();
  if (fs.existsSync(TOKEN_PATH)) {
    return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_PATH, token, { encoding: 'utf8', mode: 0o600 });
  return token;
}

function validateProjectWorkdirs(workdirs, queue) {
  const normalized = normalizeWorkdirs(workdirs);
  if (!normalized.length) throw new Error('至少需要一个工作目录');
  for (const entry of normalized) {
    if (!queue.isWorkdirAllowed(entry.path)) {
      throw new Error(`工作目录不在白名单内: ${entry.path}`);
    }
    if (!fs.existsSync(entry.path) || !fs.statSync(entry.path).isDirectory()) {
      throw new Error(`工作目录不存在或不是文件夹: ${entry.path}`);
    }
  }
  return normalized;
}

function parseCreateProjectWorkdirs(body) {
  if (Array.isArray(body.workdirs) && body.workdirs.length) {
    return body.workdirs;
  }
  const workdir = String(body.workdir || '').trim();
  if (workdir) return [{ path: workdir }];
  return [];
}

function createBroadcaster() {
  const clients = new Set();
  return {
    add(res) {
      clients.add(res);
    },
    remove(res) {
      clients.delete(res);
    },
    send(event, data) {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const client of clients) {
        client.write(payload);
      }
    },
  };
}

function extractToken(req, expectedToken) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    return header.slice(7);
  }
  if (req.query && req.query.token) {
    return String(req.query.token);
  }
  return '';
}

function authMiddleware(token) {
  return (req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (req.path === '/api/health' || req.path === '/api/bootstrap') return next();
    if (extractToken(req, token) !== token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

function main() {
  const config = loadConfig();
  const host = config.server?.host || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('安全限制：server.host 必须为 127.0.0.1 或 localhost');
  }
  const port = config.server?.port || 3920;
  const token = loadOrCreateToken();

  const db = openDb();
  const repo = createTaskRepo(db);
  const projects = createProjectRepo(db);
  const machineProject = projects.ensureMachineProject();
  repo.assignUnscopedTasks(machineProject.id);
  projects.ensureDeployCommandForWorkdir(ROOT, 'npm run deploy');
  const recovered = repo.recoverStaleRunning();
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
  });

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use(authMiddleware(token));
  app.use(express.static(path.join(ROOT, 'public')));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      runningTaskId: queue.currentTaskId,
      runningTaskIds: queue.runningTaskIds,
      queueBusy: queue.running,
      maxConcurrent: config.queue?.maxConcurrent || 3,
    });
  });

  app.get('/api/bootstrap', (_req, res) => {
    res.json({
      token,
      workdirDefault: ROOT,
      workdirAllowlist: config.security?.workdirAllowlist || [],
      models: getModelSettings(config),
    });
  });

  app.get('/api/templates', (_req, res) => {
    res.json(loadTemplates());
  });

  app.get('/api/projects', (_req, res) => {
    const result = projects.listProjects().map((project) => ({
      ...project,
      counts: repo.countByProject(project.id),
    }));
    res.json(result);
  });

  app.post('/api/projects', (req, res) => {
    try {
      const name = String(req.body.name || '').trim();
      const deployCommand = String(req.body.deployCommand || '').trim();
      const workdirs = validateProjectWorkdirs(parseCreateProjectWorkdirs(req.body), queue);
      if (!name) throw new Error('项目名称不能为空');
      const project = projects.createProject({
        id: crypto.randomUUID(),
        name,
        type: 'normal',
        workdirs,
        deploy_command: deployCommand || null,
        created_at: new Date().toISOString(),
      });
      broadcaster.send('project:created', project);
      res.status(201).json(project);
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });

  app.get('/api/projects/:id', (req, res) => {
    const project = projects.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: '项目不存在' });
    res.json({ ...project, counts: repo.countByProject(project.id) });
  });

  app.patch('/api/projects/:id/workdirs', (req, res) => {
    try {
      const workdirs = validateProjectWorkdirs(req.body.workdirs, queue);
      const project = projects.updateProjectWorkdirs(req.params.id, workdirs);
      broadcaster.send('project:updated', project);
      res.json({ ...project, counts: repo.countByProject(project.id) });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });

  app.patch('/api/projects/:id/deploy-command', (req, res) => {
    try {
      const project = projects.updateDeployCommand(
        req.params.id,
        req.body.deployCommand,
      );
      broadcaster.send('project:updated', project);
      res.json({ ...project, counts: repo.countByProject(project.id) });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });

  app.post('/api/projects/:id/deploy', async (req, res) => {
    try {
      const result = await projectDeployer.deployProject(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });

  app.post('/api/projects/:id/deploy/repair', async (req, res) => {
    try {
      const result = await projectDeployer.approveRepair(
        req.params.id,
        Boolean(req.body.approved),
      );
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });

  app.delete('/api/projects/:id', (req, res) => {
    try {
      projects.deleteProject(req.params.id);
      res.status(204).end();
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });

  app.get('/api/projects/:id/rules', async (req, res) => {
    try {
      const project = projects.getProject(req.params.id);
      if (!project) return res.status(404).json({ error: '项目不存在' });
      res.json(await scanProjectRulesForWorkdirs(project.workdirs));
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.get('/api/tasks', (req, res) => {
    const status = req.query.status;
    const projectId = req.query.projectId;
    const options = {};
    const archived = req.query.archived;
    if (archived === '1' || archived === 'true') {
      options.archived = true;
    } else if (archived === 'all') {
      options.archived = 'all';
    }
    res.json(repo.listTasks(
      status ? String(status) : undefined,
      projectId ? String(projectId) : undefined,
      options,
    ));
  });

  app.get('/api/tasks/:id', (req, res) => {
    const task = repo.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    res.json(task);
  });

  app.get('/api/tasks/:id/events', (req, res) => {
    const task = repo.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    res.json(repo.listEvents(req.params.id));
  });

  app.post('/api/tasks', (req, res) => {
    try {
      const task = queue.createTask({
        title: req.body.title,
        template: req.body.template,
        projectId: req.body.projectId,
        workdir: req.body.workdir,
        isComplex: Boolean(req.body.isComplex),
        pipelineMode: req.body.pipelineMode,
        modelId: req.body.modelId || undefined,
        variables: req.body.variables || {},
        attachments: req.body.attachments || [],
      });
      res.status(201).json(task);
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });

  app.post('/api/tasks/:id/retry', (req, res) => {
    try {
      const task = queue.retryTask(req.params.id);
      res.json(task);
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });

  app.post('/api/tasks/:id/iterate', (req, res) => {
    try {
      const task = queue.iterateTask(req.params.id, {
        requirement: req.body.requirement,
        attachments: req.body.attachments || [],
      });
      res.status(201).json(task);
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });

  app.post('/api/tasks/archive', (req, res) => {
    try {
      const projectId = String(req.body.projectId || '').trim();
      const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
      if (!projectId) throw new Error('缺少 projectId');
      if (!ids.length) throw new Error('请选择要归档的任务');
      const archived = repo.archiveTasks(ids, projectId);
      for (const task of archived) {
        broadcaster.send('task:archived', task);
      }
      res.json({ archived, count: archived.length });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });

  app.post('/api/tasks/:id/interaction', async (req, res) => {
    try {
      const task = await queue.submitInteraction(req.params.id, req.body || {});
      res.json(task);
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });

  app.get('/api/events', (req, res) => {
    if (extractToken(req, token) !== token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    broadcaster.add(res);

    const heartbeat = setInterval(() => {
      broadcaster.send('heartbeat', { ts: Date.now() });
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      broadcaster.remove(res);
    });
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
    console.log(`  Token: ${token}`);
    console.log(`  恢复中断任务: ${recovered}`);
    console.log('========================================');
    console.log('');
    queue.kick();
  });
}

main();
