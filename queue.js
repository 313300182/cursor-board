const { v4: uuidv4 } = require('uuid');
const AcpRunner = require('./acp-runner');
const ProjectScheduler = require('./scheduler');
const { taskWorkdirPaths } = ProjectScheduler;
const WorkdirLock = require('./workdir-lock');
const { normalizeWorkdirs } = require('./db');
const {
  renderTemplate,
  validateVariables,
  deriveTaskTitle,
  buildWorkdirTemplateContext,
} = require('./templates');
const { createTemplateService } = require('./template-service');
const { resolveTaskModel } = require('./model-config');
const { statusForPhase } = require('./pipeline');
const {
  isWorkdirAllowed,
  normalizePathForComparison,
  validateWorkdirs,
  normalizeAttachments,
} = require('./src/shared/validation');

const MAX_LOG_CHUNK_CHARS = 64 * 1024;

function buildIterationContextFallback(parentTask) {
  const parts = [
    '【上下文说明】此前已完成一轮任务，会话未能恢复，以下摘要供参考：',
    `原任务：${parentTask.title}`,
  ];
  if (parentTask.result_summary) {
    parts.push(`结果摘要：${parentTask.result_summary}`);
  }
  parts.push('---');
  return parts.join('\n');
}

function isIterableStatus(status) {
  return ['done', 'pending_deploy'].includes(status);
}

/**
 * Serial task queue for cursor-board MVP.
 * @author Amadeus
 */
class TaskQueue {
  constructor({ repo, projects, config, broadcast, templateService, projectTemplates }) {
    this.repo = repo;
    this.projects = projects;
    this.config = config;
    this.broadcast = broadcast;
    this.templateService = templateService
      || createTemplateService({ projectTemplates });
    this.runner = new AcpRunner(config);
    this.workdirLock = new WorkdirLock();
    this.scheduler = new ProjectScheduler({
      repo,
      maxConcurrent: config.queue?.maxConcurrent || 1,
      runTask: (task) => this.runTask(task),
      workdirLock: this.workdirLock,
      minFreeMemMB: config.queue?.minFreeMemMB || 0,
      memoryRetryMs: config.queue?.memoryRetryMs,
      onMemoryDefer: ({ freeMem, minFreeMemBytes }) => {
        console.warn(
          `[queue] 空闲内存不足，暂缓并发新任务（free=${Math.round(freeMem / 1048576)}MB < ${Math.round(minFreeMemBytes / 1048576)}MB）`,
        );
      },
    });
  }

  get running() {
    return this.scheduler.runningCount > 0;
  }

  get currentTaskId() {
    return this.scheduler.getRunningTaskIds()[0] || null;
  }

  get runningTaskIds() {
    return this.scheduler.getRunningTaskIds();
  }

  isWorkdirAllowed(workdir) {
    return isWorkdirAllowed(workdir, this.config.security?.workdirAllowlist);
  }

  resolveTaskWorkdirs(project, input = {}) {
    if (project.type === 'machine') {
      const fromArray = normalizeWorkdirs(input.workdirs || []);
      if (fromArray.length) return fromArray;
      const single = String(input.workdir || '').trim();
      return single ? [{ label: '', path: single }] : [];
    }

    const projectWorkdirs = project.workdirs || [];
    if (!projectWorkdirs.length) {
      const fallback = project.workdir;
      return fallback ? [{ label: '', path: fallback }] : [];
    }
    if (projectWorkdirs.length === 1) {
      return projectWorkdirs;
    }

    const selectedPaths = [];
    if (Array.isArray(input.workdirs) && input.workdirs.length) {
      for (const item of input.workdirs) {
        const dir = typeof item === 'string'
          ? item.trim()
          : String(item?.path || '').trim();
        if (dir) selectedPaths.push(dir);
      }
    } else if (input.workdir) {
      selectedPaths.push(String(input.workdir).trim());
    }
    if (!selectedPaths.length) {
      throw new Error('请至少选择一个工作目录');
    }

    const result = [];
    for (const selected of selectedPaths) {
      const match = projectWorkdirs.find(
        (entry) => normalizePathForComparison(entry.path)
          === normalizePathForComparison(selected),
      );
      if (!match) throw new Error(`所选工作目录不属于当前项目: ${selected}`);
      const key = normalizePathForComparison(match.path);
      if (!result.some((entry) => normalizePathForComparison(entry.path) === key)) {
        result.push(match);
      }
    }
    return result;
  }

  validateTaskWorkdirs(workdirs) {
    validateWorkdirs({
      workdirs,
      allowed: this.config.security?.workdirAllowlist,
    });
  }

  createTask(input) {
    const project = this.projects.getProject(input.projectId);
    if (!project) throw new Error('项目不存在');
    const workdirs = this.resolveTaskWorkdirs(project, input);
    if (!workdirs.length) {
      throw new Error(project.type === 'machine' ? '本机任务必须设置工作目录' : '项目未配置工作目录');
    }
    this.validateTaskWorkdirs(workdirs);
    const workdir = workdirs[0].path;
    const templateId = input.template || project.default_template || 'general';
    const template = this.templateService.resolveTemplate(project.id, templateId);
    if (!template) {
      throw new Error(`模板不存在: ${templateId}`);
    }

    const variables = input.variables || {};
    const missing = validateVariables(template, variables);
    if (missing.length > 0) {
      throw new Error(`缺少必填变量: ${missing.join(', ')}`);
    }

    const isComplex = Boolean(input.isComplex);
    const title = deriveTaskTitle(template, variables, input.title);
    if (isComplex && !String(input.title || '').trim() && title === (template?.name || '未命名任务')) {
      throw new Error('Plan 模式请填写标题，或补充任务描述');
    }

    let promptRendered = renderTemplate(template, {
      ...buildWorkdirTemplateContext(workdirs),
      ...variables,
    });
    const requirementText = String(variables.__requirement || '').trim();
    if (requirementText && !String(template.prompt || '').includes('{{__requirement}}')) {
      promptRendered = `${promptRendered}\n\n补充需求：\n${requirementText}`;
    }
    const attachments = normalizeAttachments(input.attachments, { includeField: true });
    const templateDefaults = template.defaults || {};
    const pipelineMode = Boolean(
      input.pipelineMode ?? templateDefaults.pipeline,
    );
    const gitCommitRequested = input.gitCommit ?? (templateDefaults.git !== false);
    const gitCommit = Boolean(
      pipelineMode && project.git_enabled && gitCommitRequested,
    );
    const modelId = resolveTaskModel(
      this.config,
      Boolean(input.isComplex),
      input.modelId || (
        input.isComplex ? project.complex_model : project.simple_model
      ),
    );

    const now = new Date().toISOString();
    const task = this.repo.createTask({
      id: uuidv4(),
      project_id: project.id,
      title,
      template: templateId,
      variables,
      attachments,
      workdir,
      workdirs,
      status: 'pending',
      is_complex: Boolean(input.isComplex),
      pipeline_mode: pipelineMode,
      git_commit: gitCommit,
      model_id: modelId,
      prompt_rendered: promptRendered,
      parent_task_id: input.parentTaskId || null,
      source_schedule_id: input.sourceScheduleId || null,
      created_at: now,
    });

    this.repo.addEvent(task.id, 'status_change', { status: 'pending', pipeline_mode: pipelineMode });
    this.broadcast('task:created', task);
    this.kick();
    return task;
  }

  iterateTask(id, input = {}) {
    const source = this.repo.getTask(id);
    if (!source) throw new Error('任务不存在');
    if (!isIterableStatus(source.status)) {
      throw new Error('仅已完成或待部署任务可发起迭代');
    }

    const attachments = normalizeAttachments(input.attachments, { includeField: true });
    const requirement = String(input.requirement || '').trim();
    if (!requirement && !attachments.length) throw new Error('请填写优化需求');

    const iterationTemplate = this.templateService.resolveTemplate(source.project_id, 'iteration');
    if (!iterationTemplate) throw new Error('迭代模板不存在');

    const project = this.projects.getProject(source.project_id);
    const pipelineMode = Boolean(source.pipeline_mode);
    const hasGitCommit = typeof input.gitCommit === 'boolean';
    const gitCommit = hasGitCommit
      ? Boolean(input.gitCommit && project?.git_enabled && pipelineMode)
      : Boolean(project?.git_enabled && pipelineMode);
    const hasGitPush = typeof input.gitPush === 'boolean';
    const gitPush = hasGitPush
      ? Boolean(input.gitPush && gitCommit)
      : gitCommit;

    const events = this.repo.listEvents(id);
    const closedRound = events.filter((event) => event.type === 'iteration_round').length + 1;
    const nextRound = closedRound + 1;
    const variables = { ...source.variables, requirement };
    if (gitCommit && hasGitPush) {
      variables.__git_push = gitPush;
    } else {
      delete variables.__git_push;
    }
    const promptRendered = renderTemplate(iterationTemplate, {
      ...buildWorkdirTemplateContext(source.workdirs),
      ...variables,
    });

    this.repo.addEvent(id, 'iteration_round', {
      round: closedRound,
      summary: source.result_summary || '',
    });
    this.repo.addEvent(id, 'iteration_start', {
      round: nextRound,
      requirement,
      attachments,
    });
    this.repo.setInteraction(id, null);

    const updated = this.repo.updateForIteration(id, {
      status: 'pending',
      result_summary: null,
      error_message: null,
      started_at: null,
      finished_at: null,
      pipeline_phase: null,
      deploy_completed: source.pipeline_mode ? 0 : source.deploy_completed,
      prompt_rendered: promptRendered,
      git_commit: gitCommit,
      variables,
      attachments,
    });
    this.repo.appendPendingQueuePosition(id);
    const queued = this.repo.getTask(id);
    this.repo.addEvent(id, 'status_change', { status: 'pending', reason: 'iterate' });
    this.broadcast('task:status', queued);
    this.kick();
    return queued;
  }

  retryTask(id) {
    const task = this.repo.getTask(id);
    if (!task) throw new Error('任务不存在');
    if (!['failed', 'needs_human'].includes(task.status)) {
      throw new Error('仅 failed / needs_human 状态可重试');
    }
    const variables = { ...(task.variables || {}) };
    const parked = Boolean(variables.__parked_awaiting);
    let retryError = '';
    if (parked) {
      // 因等待人工超时转异常的任务：续跑之前的会话上下文，不做“修复”提示
      delete variables.__parked_awaiting;
      delete variables.__retry_error;
      variables.__resume_after_park = true;
    } else {
      retryError = String(task.error_message || '').trim();
      if (retryError) {
        variables.__retry_error = retryError;
      } else {
        delete variables.__retry_error;
      }
    }
    const updated = this.repo.updateForIteration(id, {
      status: 'pending',
      error_message: null,
      result_summary: null,
      started_at: null,
      finished_at: null,
      pipeline_phase: null,
      // 注意：session_id 不在 updateForIteration 白名单中，会被保留，从而续跑上下文
      variables,
    });
    this.repo.appendPendingQueuePosition(id);
    const queued = this.repo.getTask(id);
    this.repo.addEvent(id, 'status_change', {
      status: 'pending',
      reason: parked ? 'resume_after_park' : 'retry',
      retryError: retryError || null,
    });
    this.broadcast('task:status', queued);
    this.kick();
    return queued;
  }

  reorderPendingTasks(projectId, orderedIds) {
    const project = this.projects.getProject(projectId);
    if (!project) throw new Error('项目不存在');
    const ids = Array.isArray(orderedIds) ? orderedIds.map(String) : [];
    if (!ids.length) throw new Error('请选择要排序的任务');
    const tasks = this.repo.reorderPendingTasks(projectId, ids);
    this.repo.addEvent(ids[0], 'queue_reorder', {
      project_id: projectId,
      ordered_ids: ids,
    });
    this.broadcast('queue:reordered', { project_id: projectId, tasks });
    this.kick();
    return tasks;
  }

  cancelTask(id) {
    const task = this.repo.getTask(id);
    if (!task) throw new Error('任务不存在');
    if (!this.runner.isTaskRunning(id)) {
      throw new Error('任务未在运行中');
    }
    this.runner.cancelTask(id);
    this.repo.addEvent(id, 'user_cancel', { reason: '用户终止' });
    return this.repo.getTask(id);
  }

  sendTaskMessage(id, input = {}) {
    const task = this.repo.getTask(id);
    if (!task) throw new Error('任务不存在');
    if (!this.runner.isTaskRunning(id)) {
      throw new Error('任务未在运行中，无法发送说明');
    }
    const message = String(input.message || '').trim();
    const skipTest = Boolean(input.skipTest);
    const attachments = normalizeAttachments(input.attachments, { includeField: true });
    if (!message && !skipTest && !attachments.length) throw new Error('消息不能为空');
    const result = this.runner.steerTask(id, message, { skipTest, attachments });
    this.repo.addEvent(id, 'user_message', {
      message,
      skipTest,
      attachments,
      attachmentCount: attachments.length,
    });
    this.broadcast('task:steer', { id, message, skipTest, ...result });
    return this.repo.getTask(id);
  }

  kick() {
    const before = this.scheduler.runningCount;
    this.scheduler.kick();
    if (before === 0 && this.scheduler.runningCount === 0) {
      this.broadcast('queue:idle', {});
    }
  }

  updatePipelinePhase(taskId, phase, extra = {}) {
    const status = statusForPhase(phase);
    const updated = this.repo.updateStatus(taskId, {
      status,
      pipeline_phase: phase,
    });
    this.repo.addEvent(taskId, 'pipeline_phase', { phase, status, ...extra });
    this.repo.addEvent(taskId, 'status_change', { status, phase, ...extra });
    this.broadcast('task:status', updated);
    return updated;
  }

  applySuggestedTitle(task, suggestedTitle) {
    const title = String(suggestedTitle || '').trim();
    if (!title || title === task.title) return task;
    const updated = this.repo.updateTitle(task.id, title);
    this.repo.addEvent(task.id, 'title_update', { title });
    this.broadcast('task:status', updated);
    return updated;
  }

  async runTask(task) {
    const startedAt = new Date().toISOString();
    const initialStatus = task.pipeline_mode
      ? (task.is_complex ? 'planning' : 'developing')
      : (task.is_complex ? 'planning' : 'running');
    let current = this.repo.updateStatus(task.id, {
      status: initialStatus,
      pipeline_phase: task.pipeline_mode && !task.is_complex ? 'dev' : null,
      started_at: startedAt,
      error_message: null,
    });
    this.repo.addEvent(task.id, 'status_change', { status: initialStatus });
    this.broadcast('task:status', current);

    const onEvent = (type, payload) => {
      if (type === 'log') {
        const chunk = String(payload?.chunk || '');
        const safePayload = {
          ...payload,
          chunk: chunk.length > MAX_LOG_CHUNK_CHARS
            ? chunk.slice(-MAX_LOG_CHUNK_CHARS)
            : chunk,
        };
        this.repo.addEvent(task.id, 'log_chunk', safePayload);
        this.broadcast('task:log', { id: task.id, ...safePayload });
      }
      if (type === 'permission') {
        this.repo.addEvent(task.id, 'permission', payload);
        this.broadcast('task:permission', { id: task.id, ...payload });
      }
      if (type === 'phase') {
        current = this.updatePipelinePhase(task.id, payload.phase, payload);
      }
      if (type === 'interaction') {
        const status = payload.type === 'question'
          ? 'awaiting_input'
          : (payload.type === 'deploy' ? 'pending_deploy' : 'pending_approval');
        const interactionPayload = { ...payload, resumeStatus: current.status };
        this.repo.setInteraction(task.id, interactionPayload);
        if (payload.type === 'plan') this.repo.setPlan(task.id, payload.plan);
        const updated = this.repo.updateStatus(task.id, {
          status,
          pipeline_phase: payload.type === 'deploy' ? 'pending_deploy' : task.pipeline_phase,
        });
        this.repo.addEvent(task.id, 'interaction', interactionPayload);
        this.repo.addEvent(task.id, 'status_change', { status });
        this.broadcast('task:interaction', { id: task.id, ...interactionPayload });
        this.broadcast('task:status', updated);
        current = updated;
      }
      if (type === 'title') {
        current = this.applySuggestedTitle(current, payload.title);
      }
    };

    try {
      const parentTask = task.parent_task_id ? this.repo.getTask(task.parent_task_id) : null;
      let prompt = task.prompt_rendered;
      const resumeSessionId = task.parent_task_id ? null : (task.session_id || null);
      if (parentTask && !resumeSessionId) {
        prompt = `${buildIterationContextFallback(parentTask)}\n\n${prompt}`;
      }

      const retryError = takeRetryError(task);
      if (retryError) {
        current = this.repo.updateForIteration(task.id, { variables: retryError.variables });
        task = { ...current, variables: retryError.variables };
      }

      // 因等待人工超时转异常后重新入队：恢复会话上下文，只发一句续跑说明而非重跑整段原始提示词
      if (task.variables?.__resume_after_park && resumeSessionId) {
        const variables = { ...(task.variables || {}) };
        delete variables.__resume_after_park;
        current = this.repo.updateForIteration(task.id, { variables });
        task = { ...current, variables };
        prompt = buildResumeAfterParkPrompt();
      }

      const executeLockPaths = taskWorkdirPaths(task);
      const runnerOptions = {
        taskId: task.id,
        workdir: task.workdir,
        workdirs: task.workdirs || [{ label: '', path: task.workdir }],
        prompt,
        attachments: task.attachments || [],
        modelId: task.model_id,
        resumeSessionId,
        retryError: retryError?.message || null,
        taskTitle: task.title,
        onEvent,
        acquireExecuteLock: () => this.workdirLock.acquire(task.id, executeLockPaths),
      };
      const project = this.projects.getProject(task.project_id);
      const gitCommit = Boolean(project?.git_enabled && task.git_commit);
      const gitPush = Boolean(
        gitCommit && (
          Object.prototype.hasOwnProperty.call(task.variables || {}, '__git_push')
            ? task.variables.__git_push
            : project?.git_push
        ),
      );
      const result = task.pipeline_mode
        ? await this.runner.runTask({
          ...runnerOptions,
          mode: 'pipeline',
          planMode: Boolean(task.is_complex),
          testCommand: task.variables?.test_command,
          gitCommit,
          gitPush,
          taskTitle: task.title,
        })
        : await this.runner.runTask({
          ...runnerOptions,
          mode: task.is_complex ? 'plan' : 'agent',
        });
      if (result.awaitingInputTimeout) {
        const parkedVariables = { ...(task.variables || {}), __parked_awaiting: true };
        delete parkedVariables.__retry_error;
        delete parkedVariables.__resume_after_park;
        current = this.repo.updateStatus(task.id, {
          status: 'needs_human',
          error_message: '等待人工回复超时，已转异常；可重新入队继续回答（已保留上下文）。',
          finished_at: new Date().toISOString(),
          session_id: result.sessionId || task.session_id || null,
        });
        this.repo.updateForIteration(task.id, { variables: parkedVariables });
        this.repo.addEvent(task.id, 'status_change', { status: 'needs_human', reason: 'human_wait_timeout' });
        current = this.repo.getTask(task.id);
        this.broadcast('task:status', current);
        return;
      }
      const awaitingDeploy = Boolean(task.pipeline_mode && result.awaitingDeploy);
      const completedStatus = awaitingDeploy ? 'pending_deploy' : 'done';
      if (result.suggestedTitle) {
        current = this.applySuggestedTitle(current, result.suggestedTitle);
      }
      current = this.repo.updateStatus(task.id, {
        status: completedStatus,
        pipeline_phase: awaitingDeploy ? 'pending_deploy' : 'done',
        result_summary: result.resultSummary,
        finished_at: awaitingDeploy ? null : new Date().toISOString(),
        deploy_completed: awaitingDeploy ? 0 : (task.pipeline_mode ? 1 : 0),
        session_id: result.sessionId || null,
      });
      this.repo.addEvent(task.id, 'status_change', { status: completedStatus });
      this.broadcast('task:status', current);
    } catch (err) {
      const message = String(err.message || err);
      const status = message.includes('人工') ? 'needs_human' : 'failed';
      current = this.repo.updateStatus(task.id, {
        status,
        error_message: message,
        finished_at: new Date().toISOString(),
      });
      this.repo.addEvent(task.id, 'status_change', { status, error: message });
      this.broadcast('task:status', current);
    } finally {
      this.repo.setInteraction(task.id, null);
    }
  }

  async submitInteraction(id, input) {
    const task = this.repo.getTask(id);
    if (!task) throw new Error('任务不存在');
    const deployWaiting = task.status === 'pending_deploy' && task.interaction?.type === 'deploy';
    if (!['awaiting_input', 'pending_approval'].includes(task.status) && !deployWaiting) {
      throw new Error('任务当前不等待交互');
    }

    if (deployWaiting) {
      await this.runner.submitInteraction(id, {
        confirmed: Boolean(input.confirmed),
      });
      this.repo.setInteraction(id, null);
      this.repo.addEvent(id, 'interaction_response', input);
      if (input.confirmed) {
        const updated = this.repo.updateStatus(id, {
          status: 'deploying',
          pipeline_phase: 'deploy',
        });
        this.repo.addEvent(id, 'status_change', { status: 'deploying' });
        this.broadcast('task:status', updated);
        return updated;
      }
      return this.repo.getTask(id);
    }

    if (task.interaction?.type === 'permission') {
      const resumeStatus = task.interaction.resumeStatus;
      await this.runner.submitInteraction(id, { allowed: Boolean(input.allowed) });
      this.repo.setInteraction(id, null);
      const status = resumeStatus
        || (task.pipeline_mode && task.pipeline_phase
          ? statusForPhase(task.pipeline_phase)
          : 'running');
      const updated = this.repo.updateStatus(id, { status });
      this.repo.addEvent(id, 'interaction_response', input);
      this.repo.addEvent(id, 'status_change', { status, reason: 'permission_response' });
      this.broadcast('task:status', updated);
      return updated;
    }

    await this.runner.submitInteraction(id, input);
    const approved = task.status === 'pending_approval' && input.accepted;
    const status = approved
      ? (task.pipeline_mode ? 'developing' : 'running')
      : 'planning';
    this.repo.setInteraction(id, null);
    const updated = this.repo.updateStatus(id, {
      status,
      pipeline_phase: approved && task.pipeline_mode ? 'dev' : task.pipeline_phase,
    });
    this.repo.addEvent(id, 'interaction_response', input);
    this.repo.addEvent(id, 'status_change', { status });
    this.broadcast('task:status', updated);
    return updated;
  }
}

module.exports = TaskQueue;
module.exports.isIterableStatus = isIterableStatus;

function takeRetryError(task) {
  const message = String(task.variables?.__retry_error || '').trim();
  if (!message) return null;
  const variables = { ...(task.variables || {}) };
  delete variables.__retry_error;
  return { message, variables };
}

function buildResumeAfterParkPrompt() {
  return [
    '（已恢复上一轮会话，保留了之前的完整上下文）',
    '此前你在等待我的确认/回答，但我当时未及时回复，任务被暂时挂起。',
    '现在请继续之前尚未完成的工作；如果你仍需要我确认或补充信息，请再次向我提问。',
  ].join('\n');
}
