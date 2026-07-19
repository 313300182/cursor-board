const crypto = require('crypto');
const express = require('express');
const { validateVariables } = require('../../templates');
const { asyncHandler, HttpError } = require('../middleware/error');

function createSchedulesRouter(deps) {
  const {
    projects, scheduleRepo, templateService, scheduleScheduler, broadcaster,
  } = deps;
  const router = express.Router();

  const requireProject = (id) => {
    const project = projects.getProject(id);
    if (!project) throw new HttpError(404, '项目不存在');
    return project;
  };

  const buildPayload = (projectId, body, { partial = false } = {}) => {
    const payload = {};
    const has = (key) => Object.prototype.hasOwnProperty.call(body, key);

    if (!partial || has('name')) {
      const name = String(body.name || '').trim();
      if (!name) throw new HttpError(400, '常驻任务名称不能为空');
      payload.name = name;
    }

    if (!partial || has('template_id') || has('templateId')) {
      const templateId = String(body.template_id || body.templateId || '').trim();
      if (!templateId) throw new HttpError(400, '请选择任务类型');
      const template = templateService.resolveTemplate(projectId, templateId);
      if (!template) throw new HttpError(400, `任务类型不存在: ${templateId}`);
      payload.template_id = templateId;
      payload.__template = template;
    }

    if (!partial || has('variables')) {
      payload.variables = body.variables && typeof body.variables === 'object' ? body.variables : {};
    }

    if (!partial || has('workdirs')) {
      const raw = Array.isArray(body.workdirs) ? body.workdirs : [];
      payload.workdirs = raw
        .map((item) => (typeof item === 'string' ? item : item?.path))
        .map((value) => String(value || '').trim())
        .filter(Boolean);
    }

    if (!partial || has('trigger')) {
      payload.trigger = body.trigger === 'cron' ? 'cron' : 'manual';
    }

    if (!partial || has('cron_expr') || has('cronExpr')) {
      payload.cron_expr = String(body.cron_expr || body.cronExpr || '').trim() || null;
    }

    if (!partial || has('enabled')) {
      payload.enabled = body.enabled === false ? false : Boolean(body.enabled ?? true);
    }

    return payload;
  };

  const normalizePath = (value) => String(value || '').replace(/\//g, '\\').toLowerCase();

  const validateWorkdirs = (project, payload, previous) => {
    const projectWorkdirs = project.workdirs || [];
    const selected = payload.workdirs !== undefined ? payload.workdirs : (previous?.workdirs || []);
    const selectedPaths = (selected || [])
      .map((item) => (typeof item === 'string' ? item : item?.path))
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    // 单目录（或未配置）项目触发时会自动落到唯一目录，无需选择
    if (projectWorkdirs.length <= 1) return;
    if (!selectedPaths.length) {
      throw new HttpError(400, '该项目有多个工作目录，请至少选择一个');
    }
    for (const chosen of selectedPaths) {
      const belongs = projectWorkdirs.some((entry) => normalizePath(entry.path) === normalizePath(chosen));
      if (!belongs) throw new HttpError(400, `所选工作目录不属于当前项目: ${chosen}`);
    }
  };

  const validatePayload = (projectId, payload, previous) => {
    const project = requireProject(projectId);
    validateWorkdirs(project, payload, previous);
    const trigger = payload.trigger ?? previous?.trigger ?? 'manual';
    const cronExpr = payload.cron_expr !== undefined ? payload.cron_expr : previous?.cron_expr;
    if (trigger === 'cron') {
      if (!cronExpr) throw new HttpError(400, '定时触发需要填写 cron 表达式');
      if (!scheduleScheduler.isValidCron(cronExpr)) {
        throw new HttpError(400, `cron 表达式无效: ${cronExpr}`);
      }
    }
    const templateId = payload.template_id ?? previous?.template_id;
    const template = payload.__template
      || templateService.resolveTemplate(projectId, templateId);
    if (!template) throw new HttpError(400, '任务类型不存在');
    const variables = payload.variables ?? previous?.variables ?? {};
    const missing = validateVariables(template, variables);
    if (missing.length) {
      throw new HttpError(400, `缺少必填变量: ${missing.join(', ')}`);
    }
  };

  const stripInternal = (payload) => {
    const { __template, ...rest } = payload;
    return rest;
  };

  router.post('/schedules/preview', asyncHandler(async (req, res) => {
    const expr = String(req.body.cron || req.body.cron_expr || '').trim();
    if (!expr) throw new HttpError(400, 'cron 表达式不能为空');
    const nextRun = scheduleScheduler.computeNextRun(expr);
    if (!nextRun) throw new HttpError(400, `cron 表达式无效: ${expr}`);
    res.json({ nextRun });
  }));

  router.get('/projects/:id/schedules', asyncHandler(async (req, res) => {
    requireProject(req.params.id);
    res.json(scheduleRepo.list(req.params.id));
  }));

  router.post('/projects/:id/schedules', asyncHandler(async (req, res) => {
    requireProject(req.params.id);
    const payload = buildPayload(req.params.id, req.body, { partial: false });
    validatePayload(req.params.id, payload);
    const created = scheduleRepo.create({
      id: crypto.randomUUID(),
      project_id: req.params.id,
      ...stripInternal(payload),
    });
    const schedule = scheduleScheduler.reconcileById(created.id) || created;
    broadcaster.send('schedule:created', schedule);
    res.status(201).json(schedule);
  }));

  router.patch('/schedules/:sid', asyncHandler(async (req, res) => {
    const existing = scheduleRepo.get(req.params.sid);
    if (!existing) throw new HttpError(404, '常驻任务不存在');
    const payload = buildPayload(existing.project_id, req.body, { partial: true });
    validatePayload(existing.project_id, payload, existing);
    scheduleRepo.update(req.params.sid, stripInternal(payload));
    const schedule = scheduleScheduler.reconcileById(req.params.sid) || scheduleRepo.get(req.params.sid);
    broadcaster.send('schedule:updated', schedule);
    res.json(schedule);
  }));

  router.delete('/schedules/:sid', asyncHandler(async (req, res) => {
    const existing = scheduleRepo.get(req.params.sid);
    if (!existing) throw new HttpError(404, '常驻任务不存在');
    scheduleScheduler.unregister(req.params.sid);
    scheduleRepo.delete(req.params.sid);
    broadcaster.send('schedule:deleted', { id: req.params.sid, project_id: existing.project_id });
    res.status(204).end();
  }));

  router.post('/schedules/:sid/trigger', asyncHandler(async (req, res) => {
    const existing = scheduleRepo.get(req.params.sid);
    if (!existing) throw new HttpError(404, '常驻任务不存在');
    const result = scheduleScheduler.triggerNow(req.params.sid);
    if (result?.error) throw new HttpError(400, `触发失败: ${result.error}`);
    res.status(201).json({ schedule: result?.schedule || existing, task: result?.task || null });
  }));

  return router;
}

module.exports = { createSchedulesRouter };
