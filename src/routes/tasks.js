const express = require('express');
const { asyncHandler, HttpError } = require('../middleware/error');

function createTasksRouter(deps) {
  const { repo, queue, broadcaster } = deps;
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
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
  }));

  router.post('/archive', asyncHandler(async (req, res) => {
    const projectId = String(req.body.projectId || '').trim();
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
    if (!projectId) throw new HttpError(400, '缺少 projectId');
    if (!ids.length) throw new HttpError(400, '请选择要归档的任务');
    const archived = repo.archiveTasks(ids, projectId);
    for (const task of archived) {
      broadcaster.send('task:archived', task);
    }
    res.json({ archived, count: archived.length });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const task = repo.getTask(req.params.id);
    if (!task) throw new HttpError(404, '任务不存在');
    res.json(task);
  }));

  router.get('/:id/events', asyncHandler(async (req, res) => {
    const task = repo.getTask(req.params.id);
    if (!task) throw new HttpError(404, '任务不存在');
    res.json(repo.listEvents(req.params.id));
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const task = queue.createTask({
      title: req.body.title,
      template: req.body.template,
      projectId: req.body.projectId,
      workdir: req.body.workdir,
      workdirs: req.body.workdirs,
      isComplex: Boolean(req.body.isComplex),
      pipelineMode: req.body.pipelineMode,
      gitCommit: Boolean(req.body.gitCommit),
      modelId: req.body.modelId || undefined,
      variables: req.body.variables || {},
      attachments: req.body.attachments || [],
    });
    res.status(201).json(task);
  }));

  router.post('/:id/retry', asyncHandler(async (req, res) => {
    const task = queue.retryTask(req.params.id);
    res.json(task);
  }));

  router.post('/:id/cancel', asyncHandler(async (req, res) => {
    const task = queue.cancelTask(req.params.id);
    res.json(task);
  }));

  router.post('/:id/message', asyncHandler(async (req, res) => {
    const task = queue.sendTaskMessage(req.params.id, req.body || {});
    res.json(task);
  }));

  router.post('/:id/iterate', asyncHandler(async (req, res) => {
    const task = queue.iterateTask(req.params.id, {
      requirement: req.body.requirement,
      attachments: req.body.attachments || [],
      gitCommit: req.body.gitCommit,
      gitPush: req.body.gitPush,
    });
    res.json(task);
  }));

  router.post('/:id/interaction', asyncHandler(async (req, res) => {
    const task = await queue.submitInteraction(req.params.id, req.body || {});
    res.json(task);
  }));

  return router;
}

module.exports = {
  createTasksRouter,
};
