const { execFileSync, spawn } = require('child_process');
const readline = require('readline');
const { buildQuestionResponse, buildPlanResponse } = require('./interactions');
const { assertAgentResultSucceeded, isAgentAbortSummary, isTransientConnectionError } = require('./agent-errors');
const {
  MAX_TEST_RETRIES,
  MAX_MARKER_RETRIES,
  parseTestResult,
  parseTaskTitleMarker,
  buildTestPrompt,
  buildFixPrompt,
  buildMissingMarkerPrompt,
  appendDevSuffix,
  appendTitleSuffix,
  buildSteerPrompt,
  shouldSkipTestFromMessage,
  buildGitMessagePrompt,
  parseGitMessage,
  buildRetryRepairPrompt,
} = require('./pipeline');
const {
  captureBaselineDirty,
  collectTaskUnits,
  commitSelectedUnits,
  buildCommitMessage,
} = require('./git-runner');
const { createAcpLogger } = require('./acp-logger');

const MAX_PROMPT_RETRIES = 2;
const PROMPT_RETRY_DELAY_MS = 1500;
const MAX_SESSION_LOG_CHARS = 2 * 1024 * 1024;
const MAX_TURN_LOG_CHARS = 512 * 1024;
const MAX_PERMISSION_EVENTS = 1000;
const MAX_EDITED_PATHS = 10000;
const MAX_ATTACHMENT_DATA_LENGTH = 3 * 1024 * 1024;

function buildAgentSpawn(agentBin, workdir) {
  if (process.platform !== 'win32') {
    return {
      command: agentBin,
      args: ['acp'],
      options: {
        cwd: workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      },
    };
  }

  let resolved = agentBin;
  try {
    resolved = execFileSync('where.exe', [agentBin], {
      encoding: 'utf8',
      windowsHide: true,
    }).split(/\r?\n/).find(Boolean) || agentBin;
  } catch {
    // Let cmd.exe report the normal executable-not-found error.
  }

  if (!/\.cmd$/i.test(resolved)) {
    return {
      command: resolved,
      args: ['acp'],
      options: {
        cwd: workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      },
    };
  }

  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${resolved}" acp`],
    options: {
      cwd: workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      // 参数已按 cmd.exe 规则手动加引号，禁止 Node 二次转义，
      // 否则会被转成 \"...\" 导致 cmd 把带引号整串当命令名而报“不是内部或外部命令”。
      windowsVerbatimArguments: true,
    },
  };
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      // Best effort; the child may already have exited.
    }
    return;
  }
  try {
    child.kill();
  } catch {
    // Best effort; the child may already have exited.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertTurnSucceeded(runner, taskId, summary) {
  const activeRun = runner.activeRuns.get(taskId);
  assertAgentResultSucceeded(summary, {
    cancelled: Boolean(activeRun?.aborted),
  });
}

/**
 * Run tasks through Cursor Agent ACP with auto-approval.
 * @author Amadeus
 */
class AcpRunner {
  constructor(config) {
    this.config = config;
    this.agentBin = config.cursor?.bin || 'agent';
    this.timeoutMs = config.cursor?.taskTimeoutMs || 1800000;
    this.security = config.security || {};
    this.pendingInteractions = new Map();
    this.activeRuns = new Map();
    this.git = config.gitRunner || {
      captureBaselineDirty,
      collectTaskUnits,
      commitSelectedUnits,
    };
    this.acpLog = config.acpLogger || createAcpLogger({ enabled: config.acpLog !== false });
  }

  isTaskRunning(taskId) {
    return this.activeRuns.has(taskId);
  }

  cancelTask(taskId, reason = '用户终止任务') {
    const run = this.activeRuns.get(taskId);
    if (!run) throw new Error('任务未在运行中');
    run.aborted = true;
    run.cancelReason = reason;
    this.pendingInteractions.delete(taskId);
    if (run.interrupt) run.interrupt();
    killProcessTree(run.child);
    if (!run.finished) {
      run.finish(new Error(reason));
    }
  }

  steerTask(taskId, message, options = {}) {
    const run = this.activeRuns.get(taskId);
    if (!run) throw new Error('任务未在运行中');
    const text = String(message || '').trim();
    const attachments = normalizeSteerAttachments(options.attachments);
    const skipTest = Boolean(options.skipTest || shouldSkipTestFromMessage(text));
    if (!text && !skipTest && !attachments.length) throw new Error('消息不能为空');
    if (skipTest) run.flags.skipTest = true;
    if (text || attachments.length) {
      run.messageQueue.push({ text, attachments });
      run.emit('log', {
        chunk: `[用户说明] ${text || '(含图片附件)'}\n`,
        stream: 'system',
      });
    }
    if (skipTest && !text) {
      run.emit('log', {
        chunk: '[system] 用户要求跳过测试阶段\n',
        stream: 'system',
      });
    }
    if (run.interrupt) run.interrupt();
    return { queued: Boolean(text || attachments.length), skipTest };
  }

  shouldDenyPermission(params) {
    const text = JSON.stringify(params || {});
    const patterns = this.security.denyPatterns || [];
    return patterns.some((pattern) => new RegExp(pattern, 'i').test(text));
  }

  async submitInteraction(taskId, input) {
    const pending = this.pendingInteractions.get(taskId);
    if (!pending) throw new Error('任务当前没有等待中的交互');
    if (pending.type === 'question') {
      pending.respond(pending.requestId, buildQuestionResponse(input));
    } else if (pending.type === 'plan') {
      if (input.accepted) {
        pending.context.planAccepted = true;
        await pending.send('session/set_mode', {
          sessionId: pending.sessionId,
          modeId: 'agent',
        });
      }
      if (!input.accepted) {
        pending.context.planRejectedReason = input.reason || '用户要求重新规划';
      }
      pending.respond(pending.requestId, buildPlanResponse(input));
    } else if (pending.type === 'deploy') {
      pending.resolveDeploy(input);
      this.pendingInteractions.delete(taskId);
      return;
    }
    this.pendingInteractions.delete(taskId);
  }

  runTask(options) {
    if (options.mode === 'pipeline') {
      return this.runPipelineTask(options);
    }
    return this.runSingleTask(options);
  }

  runSingleTask({ taskId, workdir, workdirs, prompt, attachments = [], mode = 'agent', modelId, resumeSessionId, retryError, taskTitle = '', onEvent, acquireExecuteLock }) {
    return this.withSession({
      taskId,
      workdir,
      modelId,
      mode: retryError ? 'agent' : mode,
      resumeSessionId,
      onEvent,
      run: async (session) => {
        if (retryError) {
          if (mode !== 'plan') {
            await acquireExecuteLock?.();
          }
          await session.prompt(buildRetryRepairPrompt(retryError, {
            taskTitle,
            taskPrompt: prompt,
            workdirs,
          }));
        } else if (mode !== 'plan') {
          await acquireExecuteLock?.();
          await session.prompt(appendTitleSuffix(prompt), attachments);
        } else {
          await session.prompt(appendTitleSuffix(prompt), attachments);
        }
        if (!retryError && mode === 'plan' && session.context.planAccepted) {
          await acquireExecuteLock?.();
          await session.prompt(
            '计划已经批准。现在切换到执行模式，严格按照已批准的计划完成任务，并在完成后汇报结果。',
          );
        }
        const summary = session.getTurnSummary() || session.getSummary();
        assertTurnSucceeded(this, taskId, summary);
        return {
          permissionEvents: session.permissionEvents,
          suggestedTitle: parseTaskTitleMarker(summary),
        };
      },
    });
  }

  runChatTurn({
    chatSessionId,
    workdir,
    prompt,
    attachments = [],
    modelId,
    resumeSessionId,
    onEvent,
  }) {
    return this.withSession({
      taskId: chatSessionId,
      workdir,
      modelId,
      mode: 'ask',
      resumeSessionId,
      onEvent,
      run: async (session) => {
        await session.prompt(prompt, attachments);
        const summary = session.getTurnSummary() || session.getSummary();
        assertTurnSucceeded(this, chatSessionId, summary);
        return {
          resultSummary: summary,
        };
      },
    });
  }

  runPipelineTask({
    taskId,
    workdir,
    workdirs = [],
    prompt,
    attachments = [],
    modelId,
    testCommand,
    gitCommit = false,
    gitPush = false,
    taskTitle = '',
    planMode = false,
    resumeSessionId,
    retryError,
    onEvent,
    acquireExecuteLock,
  }) {
    return this.withSession({
      taskId,
      workdir,
      modelId,
      mode: retryError ? 'agent' : (planMode ? 'plan' : 'agent'),
      resumeSessionId,
      onEvent,
      run: async (session) => {
        const emit = (type, payload) => {
          this.activeRuns.get(taskId)?.emit(type, payload);
        };
        const emitPhase = (phase, extra = {}) => {
          if (onEvent) onEvent('phase', { phase, ...extra });
        };

        let baseline = [];
        if (retryError) {
          await acquireExecuteLock?.();
          if (gitCommit) baseline = await this.git.captureBaselineDirty({ workdirs, workdir });
          emitPhase('dev', { reason: 'retry_repair' });
          await session.prompt(buildRetryRepairPrompt(retryError, {
            taskTitle,
            taskPrompt: prompt,
            workdirs,
          }));
        } else if (planMode) {
          await session.prompt(appendTitleSuffix(prompt), attachments);
          if (!session.context.planAccepted) {
            throw new Error('Plan 模式未生成可批准的计划');
          }
          await acquireExecuteLock?.();
          if (gitCommit) baseline = await this.git.captureBaselineDirty({ workdirs, workdir });
          emitPhase('dev');
          await session.prompt([
            '计划已经批准。现在切换到执行模式，严格按照已批准的计划完成开发，并在完成后汇报结果。',
            appendDevSuffix('', workdirs).trim(),
          ].join('\n'));
        } else {
          await acquireExecuteLock?.();
          if (gitCommit) baseline = await this.git.captureBaselineDirty({ workdirs, workdir });
          emitPhase('dev');
          await session.prompt(appendDevSuffix(prompt, workdirs), attachments);
        }
        const devSummary = session.getTurnSummary();
        const suggestedTitle = parseTaskTitleMarker(devSummary);
        if (suggestedTitle) {
          emit('title', { title: suggestedTitle });
        }

        let fixAttempts = 0;
        let markerRetries = 0;
        while (true) {
          const activeRun = this.activeRuns.get(taskId);
          if (activeRun?.flags?.skipTest) {
            emit('log', {
              chunk: '[system] 用户要求跳过测试阶段\n',
              stream: 'system',
            });
            break;
          }

          emitPhase('test', { attempt: fixAttempts + markerRetries + 1 });
          await session.prompt(buildTestPrompt(testCommand, workdirs));
          if (this.activeRuns.get(taskId)?.flags?.skipTest) {
            emit('log', {
              chunk: '[system] 用户要求跳过测试阶段\n',
              stream: 'system',
            });
            break;
          }
          const testSummary = session.getTurnSummary();
          assertTurnSucceeded(this, taskId, testSummary);
          const testResult = parseTestResult(testSummary);
          if (testResult.passed) {
            if (testResult.reason === 'inferred_pass') {
              emit('log', {
                chunk: '[system] 测试输出显示通过，但未输出 [TEST:PASS]，已自动判定为通过\n',
                stream: 'system',
              });
            }
            break;
          }

          if (testResult.reason === 'missing_marker') {
            markerRetries += 1;
            if (markerRetries <= MAX_MARKER_RETRIES) {
              emit('log', {
                chunk: `[system] 测试回复缺少结果标记，请求补输出（${markerRetries}/${MAX_MARKER_RETRIES}）\n`,
                stream: 'system',
              });
              emitPhase('test', { reason: 'missing_marker', attempt: markerRetries });
              await session.prompt(buildMissingMarkerPrompt());
              continue;
            }
            testResult.reason = 'fail';
            testResult.error = `测试阶段多次未输出 [TEST:PASS] 或 [TEST:FAIL] 标记（已重试 ${MAX_MARKER_RETRIES} 次）`;
          }

          fixAttempts += 1;
          if (fixAttempts >= MAX_TEST_RETRIES) {
            throw new Error(`测试失败（已重试 ${MAX_TEST_RETRIES} 次）: ${testResult.error}`);
          }

          emitPhase('dev', { reason: 'test_failed', error: testResult.error, attempt: fixAttempts });
          await session.prompt(buildFixPrompt(testResult.error));
        }

        if (gitCommit) {
          emitPhase('commit');
          const editedPaths = Array.from(new Set(session.context.editedPaths || []));
          const { units, dirState, diagnostics } = await this.git.collectTaskUnits({
            workdirs,
            workdir,
            baseline,
            editedPaths,
          });
          const failedRepo = dirState.find((item) => item.error);
          if (failedRepo) {
            throw new Error(`Git 提交失败: ${failedRepo.path}: ${failedRepo.error}`);
          }
          if (diagnostics?.skipped?.length) {
            emit('log', {
              chunk: `[system] 以下文件在任务开始前已有未提交改动、且本任务未编辑，未纳入提交：${diagnostics.skipped.join('、')}\n`,
              stream: 'system',
            });
          }
          if (diagnostics?.folded?.length) {
            emit('log', {
              chunk: `[system] 以下文件任务开始前已有改动，但本任务也编辑过，将整文件一并提交：${diagnostics.folded.join('、')}\n`,
              stream: 'system',
            });
          }
          if (!units.length) {
            emit('log', { chunk: '[system] 无本任务相关变更，已跳过 Git 提交\n', stream: 'system' });
          } else {
            emit('log', {
              chunk: `[system] 已确定本任务改动 ${units.length} 个文件，正在由 AI 生成提交信息…\n`,
              stream: 'system',
            });
            await session.prompt(buildGitMessagePrompt({
              taskTitle,
              files: units.map((unit) => unit.path),
              push: gitPush,
            }));
            const msgSummary = session.getTurnSummary();
            assertTurnSucceeded(this, taskId, msgSummary);
            const message = parseGitMessage(msgSummary).message || buildCommitMessage(taskTitle);
            const commitResult = await this.git.commitSelectedUnits({
              units,
              selectedIds: units.map((unit) => unit.id),
              message,
              push: gitPush,
            });
            if (!commitResult.ok) {
              throw new Error(`Git 提交失败: ${commitResult.error}`);
            }
            if (commitResult.committed) {
              emit('log', {
                chunk: `[system] Git 提交完成：${message}${commitResult.pushed ? '（已 push）' : ''}\n`,
                stream: 'system',
              });
            } else {
              emit('log', { chunk: '[system] 无匹配改动，已跳过 Git 提交\n', stream: 'system' });
            }
          }
        }

        emitPhase('pending_deploy');
        return {
          permissionEvents: session.permissionEvents,
          awaitingDeploy: true,
          resultSummary: session.getSummary(),
          suggestedTitle,
        };
      },
    });
  }

  withSession({ taskId, workdir, modelId, mode, onEvent, run, resumeSessionId }) {
    return new Promise((resolve, reject) => {
      let msgId = 1;
      const pending = new Map();
      const logChunks = [];
      const permissionEvents = [];
      const context = { planAccepted: false, planRejectedReason: null, editedPaths: [] };
      let finished = false;
      let sessionId = null;
      let turnChunks = [];
      let sessionLogChars = 0;
      let turnLogChars = 0;
      let lastTurnSummary = '';
      let inputReader = null;

      const emit = (type, payload) => {
        if (onEvent) onEvent(type, payload);
      };

      const startedAt = Date.now();
      let stderrTail = '';

      const agentSpawn = buildAgentSpawn(this.agentBin, workdir);
      const child = spawn(agentSpawn.command, agentSpawn.args, agentSpawn.options);

      this.acpLog.write('spawn', { taskId, mode, workdir, pid: child.pid });

      const activeRun = {
        aborted: false,
        cancelReason: null,
        finished: false,
        messageQueue: [],
        flags: { skipTest: false },
        child,
        emit,
        interrupt: null,
        finish: null,
      };

      let timer = null;
      const finish = (err, result) => {
        if (finished) return;
        finished = true;
        activeRun.finished = true;
        if (timer) clearTimeout(timer);
        this.pendingInteractions.delete(taskId);
        this.activeRuns.delete(taskId);
        if (inputReader) inputReader.close();
        const pendingError = err || new Error('ACP 会话已结束');
        for (const waiter of pending.values()) {
          waiter.reject(pendingError);
        }
        pending.clear();
        try {
          child.stdin.destroy();
        } catch {
          // ignore
        }
        killProcessTree(child);
        this.acpLog.write('finish', {
          taskId,
          ok: !err,
          durationMs: Date.now() - startedAt,
          error: err ? String(err.message || err) : null,
          stderrTail: stderrTail ? stderrTail.slice(-2000) : null,
        });
        if (err) reject(err);
        else resolve(result);
      };
      activeRun.finish = finish;
      this.activeRuns.set(taskId, activeRun);

      timer = setTimeout(() => {
        finish(new Error(`任务超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);

      const send = (method, params = {}) => {
        const id = msgId++;
        const msg = { jsonrpc: '2.0', id, method, params };
        return new Promise((res, rej) => {
          if (finished || child.stdin.destroyed || child.stdin.writableEnded) {
            rej(new Error('ACP 会话已结束'));
            return;
          }
          pending.set(id, { resolve: res, reject: rej });
          try {
            child.stdin.write(`${JSON.stringify(msg)}\n`, (err) => {
              if (!err || finished) return;
              const waiter = pending.get(id);
              if (!waiter) return;
              pending.delete(id);
              waiter.reject(err);
            });
          } catch (err) {
            pending.delete(id);
            rej(err);
          }
        });
      };

      const respond = (id, result) => {
        if (finished || child.stdin.destroyed || child.stdin.writableEnded) return;
        try {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
        } catch {
          // The agent may have exited while handling an interaction.
        }
      };

      const doSinglePrompt = async (text, attachments = []) => {
        if (activeRun.aborted) {
          throw new Error(activeRun.cancelReason || '用户终止任务');
        }

        for (let attempt = 0; attempt <= MAX_PROMPT_RETRIES; attempt++) {
          turnChunks = [];
          turnLogChars = 0;
          const promptBlocks = [{ type: 'text', text }];
          for (const item of attachments) {
            if (!item?.mimeType?.startsWith('image/') || !item?.data) continue;
            promptBlocks.push({
              type: 'image',
              mimeType: item.mimeType,
              data: item.data,
            });
          }
          const promptPromise = send('session/prompt', { sessionId, prompt: promptBlocks });
          activeRun.interrupt = () => {
            send('session/cancel', { sessionId }).catch(() => {});
          };
          try {
            await promptPromise;
          } catch (err) {
            if (activeRun.aborted) {
              throw new Error(activeRun.cancelReason || '用户终止任务');
            }
            if (attempt < MAX_PROMPT_RETRIES && isTransientConnectionError(err)) {
              emit('log', {
                chunk: `[system] Agent 连接中断，正在重试（${attempt + 1}/${MAX_PROMPT_RETRIES}）…\n`,
                stream: 'system',
              });
              await delay(PROMPT_RETRY_DELAY_MS);
              continue;
            }
            if (!activeRun.messageQueue.length) throw err;
          } finally {
            activeRun.interrupt = null;
          }

          while (mode === 'plan' && !context.planAccepted && context.planRejectedReason) {
            const reason = context.planRejectedReason;
            context.planRejectedReason = null;
            await send('session/prompt', {
              sessionId,
              prompt: [{
                type: 'text',
                text: `上一个计划被拒绝。请根据以下反馈重新制定计划，并再次提交确认：${reason}`,
              }],
            });
          }

          lastTurnSummary = turnChunks.join('').trim() || '(无文本输出)';

          if (activeRun.aborted && isAgentAbortSummary(lastTurnSummary)) {
            throw new Error(activeRun.cancelReason || '用户终止任务');
          }

          if (attempt < MAX_PROMPT_RETRIES && isTransientConnectionError(lastTurnSummary)) {
            emit('log', {
              chunk: `[system] Agent 连接中断，正在重试（${attempt + 1}/${MAX_PROMPT_RETRIES}）…\n`,
              stream: 'system',
            });
            await delay(PROMPT_RETRY_DELAY_MS);
            continue;
          }

          break;
        }

        return lastTurnSummary;
      };

      const flushSteerMessages = async () => {
        while (activeRun.messageQueue.length && !activeRun.aborted) {
          const item = activeRun.messageQueue.shift();
          const text = typeof item === 'string' ? item : String(item?.text || '').trim();
          const steerAttachments = typeof item === 'string'
            ? []
            : normalizeSteerAttachments(item?.attachments);
          emit('log', {
            chunk: '[system] 已注入用户说明，继续执行\n',
            stream: 'system',
          });
          await doSinglePrompt(buildSteerPrompt(text), steerAttachments);
        }
      };

      const session = {
        context,
        permissionEvents,
        getSummary: () => logChunks.join('').trim() || '(无文本输出)',
        getTurnSummary: () => turnChunks.join('').trim() || '(无文本输出)',
        prompt: async (text, attachments = []) => {
          try {
            await doSinglePrompt(text, attachments);
          } catch (err) {
            if (activeRun.aborted) throw err;
            if (!activeRun.messageQueue.length) throw err;
          }
          await flushSteerMessages();
          return lastTurnSummary;
        },
        send,
      };

      child.stderr.on('data', (buf) => {
        const text = buf.toString().trim();
        if (text) {
          stderrTail = `${stderrTail}${text}\n`.slice(-8000);
          emit('log', { chunk: `[stderr] ${text}`, stream: 'system' });
        }
      });

      child.stdin.on('error', (err) => {
        if (finished) return;
        this.acpLog.write('stdin_error', {
          taskId,
          error: String(err?.message || err),
        });
        finish(err);
      });

      child.on('error', (err) => {
        this.acpLog.write('process_error', { taskId, error: String(err?.message || err) });
        finish(err);
      });

      child.on('exit', (code) => {
        this.acpLog.write('exit', { taskId, code, durationMs: Date.now() - startedAt });
        if (!finished && code && code !== 0) {
          finish(new Error(`Agent 进程退出，code=${code}`));
        }
      });

      inputReader = readline.createInterface({ input: child.stdout });
      inputReader.on('line', (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }

        if (msg.id && (msg.result || msg.error)) {
          const waiter = pending.get(msg.id);
          if (waiter) {
            pending.delete(msg.id);
            if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
            else waiter.resolve(msg.result);
          }
          return;
        }

        if (msg.method === 'session/update') {
          const update = msg.params?.update;
          if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.text) {
            const text = String(update.content.text);
            sessionLogChars = appendBounded(logChunks, text, MAX_SESSION_LOG_CHARS, sessionLogChars);
            turnLogChars = appendBounded(turnChunks, text, MAX_TURN_LOG_CHARS, turnLogChars);
            emit('log', { chunk: update.content.text, stream: 'message' });
          } else if (update?.sessionUpdate === 'agent_thought_chunk' && update.content?.text) {
            emit('log', { chunk: update.content.text, stream: 'thinking' });
          } else if (
            (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update')
            && update.kind === 'edit'
            && Array.isArray(update.locations)
          ) {
            for (const location of update.locations) {
              if (location?.path && context.editedPaths.length < MAX_EDITED_PATHS) {
                context.editedPaths.push(location.path);
              }
            }
          }
          return;
        }

        if (msg.method === 'session/request_permission') {
          const tool =
            msg.params?.toolCall?.title ||
            msg.params?.toolCall?.kind ||
            'unknown';
          appendBounded(permissionEvents, { tool, action: 'requested' }, MAX_PERMISSION_EVENTS);
          emit('permission', { tool, action: 'requested' });

          if (!this.security.autoApprove) {
            emit('permission', { tool, action: 'denied', reason: 'autoApprove disabled' });
            respond(msg.id, {
              outcome: { outcome: 'selected', optionId: 'reject-once' },
            });
            finish(new Error('需要人工审批：autoApprove 已关闭'));
            return;
          }

          if (this.shouldDenyPermission(msg.params)) {
            emit('permission', { tool, action: 'denied', reason: 'deny pattern matched' });
            respond(msg.id, {
              outcome: { outcome: 'selected', optionId: 'reject-once' },
            });
            finish(new Error('命中安全拒绝规则，任务转人工'));
            return;
          }

          appendBounded(permissionEvents, { tool, action: 'auto' }, MAX_PERMISSION_EVENTS);
          emit('permission', { tool, action: 'auto' });
          const allowOption = (msg.params?.options || []).find(
            (option) => option.kind === 'allow_once' || option.optionId === 'allow-once',
          );
          respond(msg.id, {
            outcome: { outcome: 'selected', optionId: allowOption?.optionId || 'allow-once' },
          });
          return;
        }

        if (msg.method === 'cursor/ask_question') {
          const interaction = {
            type: 'question',
            title: msg.params?.title || 'Agent 需要补充信息',
            questions: msg.params?.questions || [],
          };
          this.pendingInteractions.set(taskId, {
            type: 'question',
            requestId: msg.id,
            respond,
            send,
            sessionId,
            context,
          });
          emit('interaction', interaction);
          return;
        }

        if (msg.method === 'cursor/create_plan') {
          if (mode !== 'plan' && this.security.autoAcceptPlan) {
            respond(msg.id, { outcome: { outcome: 'accepted' } });
            return;
          }
          const interaction = {
            type: 'plan',
            name: msg.params?.name || '执行计划',
            overview: msg.params?.overview || '',
            plan: msg.params?.plan || '',
            todos: msg.params?.todos || [],
            phases: msg.params?.phases || [],
          };
          this.pendingInteractions.set(taskId, {
            type: 'plan',
            requestId: msg.id,
            respond,
            send,
            sessionId,
            context,
          });
          emit('interaction', interaction);
        }
      });

      (async () => {
        try {
          await send('initialize', {
            protocolVersion: 1,
            clientCapabilities: {
              promptCapabilities: { image: true },
            },
          });
          await send('authenticate', { methodId: 'cursor_login' });
          if (resumeSessionId) {
            try {
              await send('session/load', {
                sessionId: resumeSessionId,
                cwd: workdir,
                mcpServers: [],
              });
              sessionId = resumeSessionId;
              emit('log', { chunk: '[system] 已恢复上一轮对话会话\n', stream: 'system' });
            } catch (loadErr) {
              emit('log', {
                chunk: `[system] 会话恢复失败（${String(loadErr.message || loadErr)}），将开启新会话\n`,
                stream: 'system',
              });
              const sessionResult = await send('session/new', { cwd: workdir, mcpServers: [] });
              sessionId = sessionResult.sessionId;
            }
          } else {
            const sessionResult = await send('session/new', { cwd: workdir, mcpServers: [] });
            sessionId = sessionResult.sessionId;
          }
          if (modelId) {
            await send('session/set_config_option', {
              sessionId,
              configId: 'model',
              value: modelId,
            });
          }
          if (mode === 'plan') {
            await send('session/set_mode', { sessionId, modeId: 'plan' });
          } else if (mode === 'ask') {
            await send('session/set_mode', { sessionId, modeId: 'ask' });
          }
          const result = await run(session);
          if (result && typeof result === 'object') {
            result.resultSummary = String(
              result.resultSummary || lastTurnSummary || session.getSummary(),
            ).slice(0, 4000);
            result.sessionId = sessionId;
          }
          finish(null, result);
        } catch (err) {
          finish(err);
        }
      })();
    });
  }
}

function appendBounded(items, value, limit, currentChars = null) {
  if (currentChars === null) {
    items.push(value);
    if (items.length > limit) items.splice(0, items.length - limit);
    return;
  }
  const text = String(value);
  items.push(text);
  let total = currentChars + text.length;
  while (items.length > 1 && total > limit) {
    total -= items.shift().length;
  }
  if (total > limit) {
    items[0] = items[0].slice(-limit);
    total = items[0].length;
  }
  return total;
}

function normalizeSteerAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => ({
      mimeType: String(item?.mimeType || '').trim(),
      data: String(item?.data || '').trim(),
    }))
    .filter((item) => (
      item.mimeType.startsWith('image/')
      && item.data
      && item.data.length <= MAX_ATTACHMENT_DATA_LENGTH
    ))
    .slice(0, 5);
}

module.exports = AcpRunner;
