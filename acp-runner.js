const { spawn } = require('child_process');
const readline = require('readline');
const { buildQuestionResponse, buildPlanResponse } = require('./interactions');
const { assertAgentResultSucceeded } = require('./agent-errors');
const {
  MAX_TEST_RETRIES,
  MAX_MARKER_RETRIES,
  parseTestResult,
  buildTestPrompt,
  buildFixPrompt,
  buildMissingMarkerPrompt,
  appendDevSuffix,
  buildSteerPrompt,
  shouldSkipTestFromMessage,
  buildGitCommitPrompt,
  parseGitCommitResult,
} = require('./pipeline');

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
    try {
      run.child.kill();
    } catch {
      // ignore
    }
    if (!run.finished) {
      run.finish(new Error(reason));
    }
  }

  steerTask(taskId, message, options = {}) {
    const run = this.activeRuns.get(taskId);
    if (!run) throw new Error('任务未在运行中');
    const text = String(message || '').trim();
    const skipTest = Boolean(options.skipTest || shouldSkipTestFromMessage(text));
    if (!text && !skipTest) throw new Error('消息不能为空');
    if (skipTest) run.flags.skipTest = true;
    if (text) {
      run.messageQueue.push(text);
      run.emit('log', {
        chunk: `[用户说明] ${text}\n`,
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
    return { queued: Boolean(text), skipTest };
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

  runSingleTask({ taskId, workdir, workdirs, prompt, attachments = [], mode = 'agent', modelId, resumeSessionId, onEvent }) {
    return this.withSession({
      taskId,
      workdir,
      modelId,
      mode,
      resumeSessionId,
      onEvent,
      run: async (session) => {
        await session.prompt(prompt, attachments);
        if (mode === 'plan' && session.context.planAccepted) {
          await session.prompt(
            '计划已经批准。现在切换到执行模式，严格按照已批准的计划完成任务，并在完成后汇报结果。',
          );
        }
        const summary = session.getTurnSummary() || session.getSummary();
        assertAgentResultSucceeded(summary);
        return {
          permissionEvents: session.permissionEvents,
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
    resumeSessionId,
    onEvent,
  }) {
    return this.withSession({
      taskId,
      workdir,
      modelId,
      mode: 'agent',
      resumeSessionId,
      onEvent,
      run: async (session) => {
        const emit = (type, payload) => {
          this.activeRuns.get(taskId)?.emit(type, payload);
        };
        const emitPhase = (phase, extra = {}) => {
          if (onEvent) onEvent('phase', { phase, ...extra });
        };

        emitPhase('dev');
        await session.prompt(appendDevSuffix(prompt, workdirs), attachments);

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
          assertAgentResultSucceeded(testSummary);
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
          await session.prompt(buildGitCommitPrompt({ taskTitle, workdirs, push: gitPush }));
          const commitSummary = session.getTurnSummary();
          assertAgentResultSucceeded(commitSummary);
          const commitResult = parseGitCommitResult(commitSummary);
          if (!commitResult.ok) {
            throw new Error(`Git 提交失败: ${commitResult.error}`);
          }
          if (commitResult.committed) {
            emit('log', {
              chunk: '[system] Git 提交完成\n',
              stream: 'system',
            });
          } else if (commitResult.skipped) {
            emit('log', {
              chunk: '[system] 无变更，已跳过 Git 提交\n',
              stream: 'system',
            });
          }
        }

        emitPhase('pending_deploy');
        return {
          permissionEvents: session.permissionEvents,
          awaitingDeploy: true,
          resultSummary: session.getSummary(),
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
      const context = { planAccepted: false, planRejectedReason: null };
      let finished = false;
      let sessionId = null;
      let turnChunks = [];
      let lastTurnSummary = '';

      const emit = (type, payload) => {
        if (onEvent) onEvent(type, payload);
      };

      const child = spawn(this.agentBin, ['acp'], {
        cwd: workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: true,
      });

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

      const finish = (err, result) => {
        if (finished) return;
        finished = true;
        activeRun.finished = true;
        clearTimeout(timer);
        this.pendingInteractions.delete(taskId);
        this.activeRuns.delete(taskId);
        try {
          child.kill();
        } catch {
          // ignore
        }
        if (err) reject(err);
        else resolve(result);
      };
      activeRun.finish = finish;
      this.activeRuns.set(taskId, activeRun);

      const timer = setTimeout(() => {
        finish(new Error(`任务超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);

      const send = (method, params = {}) => {
        const id = msgId++;
        const msg = { jsonrpc: '2.0', id, method, params };
        child.stdin.write(JSON.stringify(msg) + '\n');
        return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
      };

      const respond = (id, result) => {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
      };

      const doSinglePrompt = async (text, attachments = []) => {
        if (activeRun.aborted) {
          throw new Error(activeRun.cancelReason || '用户终止任务');
        }
        turnChunks = [];
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
        return lastTurnSummary;
      };

      const flushSteerMessages = async () => {
        while (activeRun.messageQueue.length && !activeRun.aborted) {
          const message = activeRun.messageQueue.shift();
          emit('log', {
            chunk: '[system] 已注入用户说明，继续执行\n',
            stream: 'system',
          });
          await doSinglePrompt(buildSteerPrompt(message));
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
          emit('log', { chunk: `[stderr] ${text}`, stream: 'system' });
        }
      });

      child.on('error', (err) => finish(err));

      child.on('exit', (code) => {
        if (!finished && code && code !== 0) {
          finish(new Error(`Agent 进程退出，code=${code}`));
        }
      });

      readline.createInterface({ input: child.stdout }).on('line', (line) => {
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
            logChunks.push(update.content.text);
            turnChunks.push(update.content.text);
            emit('log', { chunk: update.content.text, stream: 'message' });
          } else if (update?.sessionUpdate === 'agent_thought_chunk' && update.content?.text) {
            emit('log', { chunk: update.content.text, stream: 'thinking' });
          }
          return;
        }

        if (msg.method === 'session/request_permission') {
          const tool =
            msg.params?.toolCall?.title ||
            msg.params?.toolCall?.kind ||
            'unknown';
          permissionEvents.push({ tool, action: 'requested' });
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

          permissionEvents.push({ tool, action: 'auto' });
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

module.exports = AcpRunner;
