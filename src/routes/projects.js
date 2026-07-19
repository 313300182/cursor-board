const crypto = require('crypto');
const express = require('express');
const { normalizeWorkdirs } = require('../../db');
const { scanProjectRulesForWorkdirs } = require('../../project-rules');
const { scanProjectSkillsForWorkdirs } = require('../../project-skills');
const { getModelSettings } = require('../../model-config');
const { getTemplate } = require('../../templates');
const { asyncHandler, HttpError } = require('../middleware/error');
const { validateWorkdirs } = require('../shared/validation');

const BUILTIN_TEMPLATE_KEYS = new Set(['workdir', 'workdirs', 'workdirs_detail']);

function extractPlaceholders(prompt) {
  const found = new Set();
  const regex = /\{\{\s*([\w]+)\s*\}\}/g;
  let match = regex.exec(String(prompt || ''));
  while (match) {
    found.add(match[1]);
    match = regex.exec(String(prompt || ''));
  }
  return [...found];
}

function normalizeTemplateVariables(rawVariables) {
  if (!Array.isArray(rawVariables)) return [];
  return rawVariables
    .map((item) => {
      const name = String(item?.name || '').trim();
      if (!name) return null;
      return {
        name,
        label: String(item?.label || name).trim(),
        input: item?.input === 'input' ? 'input' : 'textarea',
        required: Boolean(item?.required),
        images: Boolean(item?.images),
        rows: Number.isFinite(item?.rows) ? Number(item.rows) : undefined,
        placeholder: item?.placeholder ? String(item.placeholder) : undefined,
      };
    })
    .filter(Boolean);
}

function buildPrivateTemplatePayload(body) {
  const name = String(body?.name || '').trim();
  if (!name) throw new HttpError(400, '任务类型名称不能为空');
  const prompt = String(body?.prompt || '').trim();
  if (!prompt) throw new HttpError(400, '提示词不能为空');
  const variables = normalizeTemplateVariables(body?.variables);
  const defaultsInput = body?.defaults && typeof body.defaults === 'object' ? body.defaults : {};
  const defaults = {
    pipeline: Boolean(defaultsInput.pipeline),
    git: Boolean(defaultsInput.git),
    complex: Boolean(defaultsInput.complex),
  };
  const definedNames = new Set(variables.map((item) => item.name));
  const warnings = [];
  for (const placeholder of extractPlaceholders(prompt)) {
    if (BUILTIN_TEMPLATE_KEYS.has(placeholder)) continue;
    if (!definedNames.has(placeholder)) {
      warnings.push(`提示词中的占位符 {{${placeholder}}} 未在变量中定义`);
    }
  }
  return {
    payload: {
      name,
      category: String(body?.category || '').trim() || '项目',
      description: String(body?.description || '').trim(),
      prompt,
      variables,
      defaults,
      order: Number.isFinite(body?.order) ? Number(body.order) : null,
    },
    warnings,
  };
}

function validateProjectWorkdirs(workdirs, queue) {
  const normalized = normalizeWorkdirs(workdirs);
  if (!normalized.length) throw new HttpError(400, '至少需要一个工作目录');
  try {
    validateWorkdirs({
      workdirs: normalized,
      isAllowed: (workdir) => queue.isWorkdirAllowed(workdir),
      allowedFirst: true,
    });
  } catch (err) {
    throw new HttpError(400, err.message);
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

function validateProjectDefaults(body, config, templateExists) {
  const models = getModelSettings(config);
  const modelIds = new Set(models.options.map((option) => option.id));
  const simpleModel = String(body.simpleModel || '').trim();
  const complexModel = String(body.complexModel || '').trim();
  const defaultTemplate = String(body.defaultTemplate || '').trim();
  if (simpleModel && !modelIds.has(simpleModel)) {
    throw new HttpError(400, `简单模式模型不可用: ${simpleModel}`);
  }
  if (complexModel && !modelIds.has(complexModel)) {
    throw new HttpError(400, `复杂模式模型不可用: ${complexModel}`);
  }
  const exists = typeof templateExists === 'function'
    ? templateExists(defaultTemplate)
    : Boolean(getTemplate(defaultTemplate));
  if (defaultTemplate && !exists) {
    throw new HttpError(400, `默认任务类型不存在: ${defaultTemplate}`);
  }
  return { simpleModel: simpleModel || null, complexModel: complexModel || null, defaultTemplate: defaultTemplate || null };
}

function createProjectsRouter(deps) {
  const {
    repo, projects, queue, projectDeployer, broadcaster, config,
    projectTemplates, templateService,
  } = deps;
  const router = express.Router();

  const requireProject = (id) => {
    const project = projects.getProject(id);
    if (!project) throw new HttpError(404, '项目不存在');
    return project;
  };

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
    const defaults = validateProjectDefaults(req.body, config);
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
      ...defaults,
      created_at: new Date().toISOString(),
    });
    broadcaster.send('project:created', project);
    res.status(201).json(project);
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const project = projects.getProject(req.params.id);
    if (!project) throw new HttpError(404, '项目不存在');
    res.json({
      ...project,
      counts: repo.countByProject(project.id),
      archivedCount: repo.countArchivedByProject(project.id),
    });
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

  router.patch('/:id/defaults', asyncHandler(async (req, res) => {
    requireProject(req.params.id);
    const templateExists = templateService
      ? (templateId) => Boolean(templateService.resolveTemplate(req.params.id, templateId))
      : undefined;
    const defaults = validateProjectDefaults(req.body, config, templateExists);
    const project = projects.updateProjectDefaults(req.params.id, defaults);
    broadcaster.send('project:updated', project);
    res.json({ ...project, counts: repo.countByProject(project.id) });
  }));

  router.get('/:id/task-types', asyncHandler(async (req, res) => {
    const project = requireProject(req.params.id);
    res.json(templateService.listEffectiveTemplates(project));
  }));

  router.patch('/:id/enabled-templates', asyncHandler(async (req, res) => {
    requireProject(req.params.id);
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map((id) => String(id)) : [];
    if (!ids.includes('general')) ids.push('general');
    const project = projects.updateEnabledTemplates(req.params.id, ids);
    broadcaster.send('project:updated', project);
    res.json({ ...project, counts: repo.countByProject(project.id) });
  }));

  router.post('/:id/templates', asyncHandler(async (req, res) => {
    requireProject(req.params.id);
    const { payload, warnings } = buildPrivateTemplatePayload(req.body);
    const template = projectTemplates.create({
      id: crypto.randomUUID(),
      project_id: req.params.id,
      ...payload,
    });
    broadcaster.send('project:updated', projects.getProject(req.params.id));
    res.status(201).json({ template, warnings });
  }));

  router.patch('/:id/templates/:templateId', asyncHandler(async (req, res) => {
    requireProject(req.params.id);
    const existing = projectTemplates.getForProject(req.params.id, req.params.templateId);
    if (!existing) throw new HttpError(404, '项目任务类型不存在');
    const { payload, warnings } = buildPrivateTemplatePayload(req.body);
    const template = projectTemplates.update(req.params.templateId, payload);
    broadcaster.send('project:updated', projects.getProject(req.params.id));
    res.json({ template, warnings });
  }));

  router.delete('/:id/templates/:templateId', asyncHandler(async (req, res) => {
    requireProject(req.params.id);
    const existing = projectTemplates.getForProject(req.params.id, req.params.templateId);
    if (!existing) throw new HttpError(404, '项目任务类型不存在');
    projectTemplates.delete(req.params.templateId);
    broadcaster.send('project:updated', projects.getProject(req.params.id));
    res.status(204).end();
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
  validateProjectDefaults,
};
