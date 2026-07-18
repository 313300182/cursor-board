const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { normalizeWorkdirs } = require('../../db');
const { scanProjectRulesForWorkdirs } = require('../../project-rules');
const { scanProjectSkillsForWorkdirs } = require('../../project-skills');
const { asyncHandler, HttpError } = require('../middleware/error');

function validateProjectWorkdirs(workdirs, queue) {
  const normalized = normalizeWorkdirs(workdirs);
  if (!normalized.length) throw new HttpError(400, '至少需要一个工作目录');
  for (const entry of normalized) {
    if (!queue.isWorkdirAllowed(entry.path)) {
      throw new HttpError(400, `工作目录不在白名单内: ${entry.path}`);
    }
    if (!fs.existsSync(entry.path) || !fs.statSync(entry.path).isDirectory()) {
      throw new HttpError(400, `工作目录不存在或不是文件夹: ${entry.path}`);
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

function createProjectsRouter(deps) {
  const { repo, projects, queue, projectDeployer, broadcaster } = deps;
  const router = express.Router();

  router.get('/', asyncHandler(async (_req, res) => {
    const result = projects.listProjects().map((project) => ({
      ...project,
      counts: repo.countByProject(project.id),
    }));
    res.json(result);
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const deployCommand = String(req.body.deployCommand || '').trim();
    const gitEnabled = Boolean(req.body.gitEnabled);
    const gitPush = Boolean(req.body.gitPush);
    const workdirs = validateProjectWorkdirs(parseCreateProjectWorkdirs(req.body), queue);
    if (!name) throw new HttpError(400, '项目名称不能为空');
    const project = projects.createProject({
      id: crypto.randomUUID(),
      name,
      type: 'normal',
      workdirs,
      deploy_command: deployCommand || null,
      git_enabled: gitEnabled,
      git_push: gitEnabled && gitPush,
      created_at: new Date().toISOString(),
    });
    broadcaster.send('project:created', project);
    res.status(201).json(project);
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const project = projects.getProject(req.params.id);
    if (!project) throw new HttpError(404, '项目不存在');
    res.json({ ...project, counts: repo.countByProject(project.id) });
  }));

  router.patch('/:id/workdirs', asyncHandler(async (req, res) => {
    const workdirs = validateProjectWorkdirs(req.body.workdirs, queue);
    const project = projects.updateProjectWorkdirs(req.params.id, workdirs);
    broadcaster.send('project:updated', project);
    res.json({ ...project, counts: repo.countByProject(project.id) });
  }));

  router.patch('/:id/deploy-command', asyncHandler(async (req, res) => {
    const project = projects.updateDeployCommand(
      req.params.id,
      req.body.deployCommand,
    );
    broadcaster.send('project:updated', project);
    res.json({ ...project, counts: repo.countByProject(project.id) });
  }));

  router.patch('/:id/git', asyncHandler(async (req, res) => {
    const project = projects.updateProjectGit(req.params.id, {
      gitEnabled: req.body.gitEnabled,
      gitPush: req.body.gitPush,
    });
    broadcaster.send('project:updated', project);
    res.json({ ...project, counts: repo.countByProject(project.id) });
  }));

  router.post('/:id/deploy', asyncHandler(async (req, res) => {
    const result = await projectDeployer.deployProject(req.params.id);
    res.json(result);
  }));

  router.post('/:id/deploy/repair', asyncHandler(async (req, res) => {
    const result = await projectDeployer.approveRepair(
      req.params.id,
      Boolean(req.body.approved),
    );
    res.json(result);
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    projects.deleteProject(req.params.id);
    res.status(204).end();
  }));

  router.get('/:id/rules', asyncHandler(async (req, res) => {
    const project = projects.getProject(req.params.id);
    if (!project) throw new HttpError(404, '项目不存在');
    try {
      res.json(await scanProjectRulesForWorkdirs(project.workdirs));
    } catch (err) {
      throw new HttpError(500, String(err.message || err));
    }
  }));

  router.get('/:id/skills', asyncHandler(async (req, res) => {
    const project = projects.getProject(req.params.id);
    if (!project) throw new HttpError(404, '项目不存在');
    try {
      res.json(await scanProjectSkillsForWorkdirs(project.workdirs));
    } catch (err) {
      throw new HttpError(500, String(err.message || err));
    }
  }));

  return router;
}

module.exports = {
  createProjectsRouter,
  validateProjectWorkdirs,
  parseCreateProjectWorkdirs,
};
