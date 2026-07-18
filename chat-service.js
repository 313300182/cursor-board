const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const AcpRunner = require('./acp-runner');
const { resolveTaskModel } = require('./model-config');
const { ROOT } = require('./src/config');

const MAX_ATTACHMENT_DATA_LENGTH = 3 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_DATA_LENGTH = 8 * 1024 * 1024;

function normalizeAttachments(items) {
  if (!Array.isArray(items)) return [];
  const result = [];
  let totalLength = 0;
  for (const item of items) {
    if (!item?.mimeType?.startsWith('image/') || !item?.data) continue;
    const data = String(item.data);
    if (data.length > MAX_ATTACHMENT_DATA_LENGTH) throw new Error('单个图片附件过大');
    if (totalLength + data.length > MAX_TOTAL_ATTACHMENT_DATA_LENGTH) {
      throw new Error('图片附件总大小过大');
    }
    totalLength += data.length;
    result.push({ mimeType: String(item.mimeType), data });
    if (result.length >= 5) break;
  }
  return result;
}

function deriveSessionTitle(message) {
  const line = String(message || '').replace(/\r\n/g, '\n').split('\n').map((entry) => entry.trim()).find(Boolean) || '';
  if (!line) return '新对话';
  return line.length > 48 ? `${line.slice(0, 48)}…` : line;
}

/**
 * Pure ask-mode chat sessions, separate from kanban tasks.
 * @author Amadeus
 */
class ChatService {
  constructor({ chatRepo, projects, config, broadcast, runner }) {
    this.chatRepo = chatRepo;
    this.projects = projects;
    this.config = config;
    this.broadcast = broadcast;
    this.runner = runner || new AcpRunner(config);
    this.runningSessions = new Set();
  }

  isWorkdirAllowed(workdir) {
    const normalized = workdir.replace(/\//g, '\\');
    const allowlist = this.config.security?.workdirAllowlist || [];
    return allowlist.some((prefix) => {
      const p = prefix.replace(/\//g, '\\');
      return normalized.toLowerCase().startsWith(p.toLowerCase());
    });
  }

  validateWorkdir(workdir) {
    const dir = String(workdir || '').trim();
    if (!dir) throw new Error('工作目录不能为空');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`工作目录不存在或不是文件夹: ${dir}`);
    }
    if (!this.isWorkdirAllowed(dir)) {
      throw new Error(`工作目录不在白名单内: ${dir}`);
    }
    return dir;
  }

  resolveWorkdir(projectId) {
    if (!projectId) return this.validateWorkdir(ROOT);
    const project = this.projects.getProject(projectId);
    if (!project) throw new Error('项目不存在');
    if (project.type === 'machine') return this.validateWorkdir(ROOT);
    const workdirs = project.workdirs || [];
    const primary = workdirs[0]?.path || project.workdir;
    if (!primary) throw new Error('项目未配置工作目录');
    return this.validateWorkdir(primary);
  }

  listSessions(projectId) {
    if (projectId === undefined) {
      return this.chatRepo.listSessions(null);
    }
    const normalized = projectId === '' ? null : String(projectId || '').trim() || null;
    if (normalized) {
      const project = this.projects.getProject(normalized);
      if (!project) throw new Error('项目不存在');
    }
    return this.chatRepo.listSessions(normalized);
  }

  getSession(id) {
    const session = this.chatRepo.getSession(id);
    if (!session) throw new Error('对话不存在');
    return session;
  }

  getSessionDetail(id) {
    const session = this.getSession(id);
    return {
      ...session,
      messages: this.chatRepo.listMessages(id),
    };
  }

  listMessages(sessionId) {
    this.getSession(sessionId);
    return this.chatRepo.listMessages(sessionId);
  }

  createSession(input = {}) {
    const projectId = input.projectId ? String(input.projectId).trim() : null;
    if (projectId) {
      const project = this.projects.getProject(projectId);
      if (!project) throw new Error('项目不存在');
    }
    const workdir = this.resolveWorkdir(projectId);
    const modelId = resolveTaskModel(this.config, false, input.modelId);
    const now = new Date().toISOString();
    const session = this.chatRepo.createSession({
      id: uuidv4(),
      project_id: projectId,
      title: String(input.title || '').trim() || '新对话',
      workdir,
      model_id: modelId,
      status: 'idle',
      created_at: now,
      updated_at: now,
    });
    this.broadcast('chat:created', session);
    return session;
  }

  startMessage(sessionId, input = {}) {
    const session = this.getSession(sessionId);
    if (this.runningSessions.has(sessionId)) {
      throw new Error('当前对话正在回复中');
    }
    if (session.status === 'awaiting_input') {
      throw new Error('请先回答 Agent 的问题');
    }
    const message = String(input.message || '').trim();
    if (!message) throw new Error('消息不能为空');
    const attachments = normalizeAttachments(input.attachments);
    const now = new Date().toISOString();
    const userMessage = this.chatRepo.addMessage(sessionId, {
      role: 'user',
      content: message,
      created_at: now,
    });
    let updated = session;
    if (session.title === '新对话') {
      updated = this.chatRepo.updateSession(sessionId, {
        title: deriveSessionTitle(message),
        updated_at: now,
      });
    } else {
      updated = this.chatRepo.updateSession(sessionId, { updated_at: now });
    }
    updated = this.chatRepo.updateSession(sessionId, {
      status: 'running',
      error_message: null,
      interaction: null,
      updated_at: now,
    });
    this.runningSessions.add(sessionId);
    this.broadcast('chat:message', { sessionId, message: userMessage });
    this.broadcast('chat:status', updated);
    this.runTurn(sessionId, message, attachments).catch(() => {});
    return updated;
  }

  async runTurn(sessionId, prompt, attachments) {
    const session = this.getSession(sessionId);
    let assistantChunks = [];
    const onEvent = (type, payload) => {
      if (type === 'log') {
        if (payload.stream === 'message') {
          assistantChunks.push(payload.chunk || '');
        }
        this.broadcast('chat:log', { sessionId, ...payload });
      }
      if (type === 'interaction') {
        const updated = this.chatRepo.updateSession(sessionId, {
          status: 'awaiting_input',
          interaction: payload,
          updated_at: new Date().toISOString(),
        });
        this.broadcast('chat:interaction', { sessionId, ...payload });
        this.broadcast('chat:status', updated);
      }
    };

    try {
      const result = await this.runner.runChatTurn({
        chatSessionId: sessionId,
        workdir: session.workdir,
        prompt,
        attachments,
        modelId: session.model_id,
        resumeSessionId: session.agent_session_id,
        onEvent,
      });
      const content = String(result.resultSummary || assistantChunks.join('') || '').trim() || '(无文本输出)';
      const now = new Date().toISOString();
      const assistantMessage = this.chatRepo.addMessage(sessionId, {
        role: 'assistant',
        content,
        stream: 'message',
        created_at: now,
      });
      const updated = this.chatRepo.updateSession(sessionId, {
        status: 'idle',
        agent_session_id: result.sessionId,
        interaction: null,
        error_message: null,
        updated_at: now,
      });
      this.broadcast('chat:message', { sessionId, message: assistantMessage });
      this.broadcast('chat:status', updated);
      this.broadcast('chat:done', { sessionId, message: assistantMessage });
      return updated;
    } catch (err) {
      const now = new Date().toISOString();
      const updated = this.chatRepo.updateSession(sessionId, {
        status: 'failed',
        error_message: String(err.message || err),
        interaction: null,
        updated_at: now,
      });
      this.broadcast('chat:status', updated);
      throw err;
    } finally {
      this.runningSessions.delete(sessionId);
    }
  }

  async submitInteraction(sessionId, input = {}) {
    const session = this.getSession(sessionId);
    if (session.status !== 'awaiting_input' || !session.interaction) {
      throw new Error('当前没有待回答的交互');
    }
    if (session.interaction.type === 'question') {
      await this.runner.submitInteraction(sessionId, input);
    } else {
      throw new Error('当前对话不支持此交互类型');
    }
    const updated = this.chatRepo.updateSession(sessionId, {
      status: 'running',
      interaction: null,
      updated_at: new Date().toISOString(),
    });
    this.broadcast('chat:status', updated);
    return updated;
  }

  cancelTurn(sessionId) {
    const session = this.getSession(sessionId);
    if (!this.runner.isTaskRunning(sessionId)) {
      if (session.status === 'running') {
        return this.chatRepo.updateSession(sessionId, {
          status: 'idle',
          error_message: null,
          updated_at: new Date().toISOString(),
        });
      }
      throw new Error('当前没有进行中的回复');
    }
    this.runner.cancelTask(sessionId, '用户终止回复');
    const updated = this.chatRepo.updateSession(sessionId, {
      status: 'idle',
      error_message: '用户终止回复',
      interaction: null,
      updated_at: new Date().toISOString(),
    });
    this.runningSessions.delete(sessionId);
    this.broadcast('chat:status', updated);
    return updated;
  }
}

module.exports = ChatService;
