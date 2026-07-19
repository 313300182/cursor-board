const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
const MAX_LOG_EVENTS_PER_TASK = 2000;
const MAX_LOG_EVENT_BYTES_PER_TASK = 8 * 1024 * 1024;
const LOG_EVENT_PRUNE_INTERVAL = 256;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function ensureColumn(db, table, name, definition) {
  const columns = db.pragma(`table_info(${table})`);
  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function backfillPendingQueuePositions(db) {
  const projects = db.prepare(`
    SELECT DISTINCT project_id AS project_id
    FROM tasks
    WHERE status = 'pending'
      AND archived = 0
      AND queue_position IS NULL
      AND project_id IS NOT NULL
  `).all();
  if (!projects.length) return;
  const listPending = db.prepare(`
    SELECT id FROM tasks
    WHERE project_id = ?
      AND status = 'pending'
      AND archived = 0
    ORDER BY created_at ASC, id ASC
  `);
  const updatePosition = db.prepare('UPDATE tasks SET queue_position = ? WHERE id = ?');
  for (const { project_id: projectId } of projects) {
    const rows = listPending.all(projectId);
    rows.forEach((row, index) => updatePosition.run(index + 1, row.id));
  }
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'normal',
      workdir TEXT,
      deploy_command TEXT,
      deploy_status TEXT,
      deploy_error TEXT,
      deploy_started_at TEXT,
      deploy_finished_at TEXT,
      simple_model TEXT,
      complex_model TEXT,
      default_template TEXT,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      template TEXT NOT NULL,
      variables TEXT NOT NULL DEFAULT '{}',
      workdir TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      is_complex INTEGER NOT NULL DEFAULT 0,
      model_id TEXT,
      prompt_rendered TEXT,
      plan_text TEXT,
      interaction_json TEXT,
      result_summary TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id);
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL DEFAULT '新对话',
      workdir TEXT NOT NULL,
      agent_session_id TEXT,
      model_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      interaction_json TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      stream TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_project_id ON chat_sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);
    CREATE TABLE IF NOT EXISTS project_templates (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT,
      description TEXT,
      defaults_json TEXT,
      variables_json TEXT,
      prompt TEXT NOT NULL DEFAULT '',
      sort_order INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_project_templates_project_id ON project_templates(project_id);
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      name TEXT NOT NULL,
      variables_json TEXT,
      trigger TEXT NOT NULL DEFAULT 'manual',
      cron_expr TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      last_task_id TEXT,
      last_status TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_schedules_project_id ON schedules(project_id);
  `);
  ensureColumn(db, 'schedules', 'workdirs_json', 'TEXT');
  ensureColumn(db, 'tasks', 'project_id', 'TEXT');
  ensureColumn(db, 'tasks', 'is_complex', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'tasks', 'plan_text', 'TEXT');
  ensureColumn(db, 'tasks', 'interaction_json', 'TEXT');
  ensureColumn(db, 'tasks', 'model_id', 'TEXT');
  ensureColumn(db, 'tasks', 'attachments_json', 'TEXT');
  ensureColumn(db, 'tasks', 'pipeline_mode', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'tasks', 'pipeline_phase', 'TEXT');
  ensureColumn(db, 'tasks', 'deploy_completed', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'tasks', 'archived', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'tasks', 'archived_at', 'TEXT');
  ensureColumn(db, 'tasks', 'session_id', 'TEXT');
  ensureColumn(db, 'tasks', 'parent_task_id', 'TEXT');
  ensureColumn(db, 'projects', 'deploy_command', 'TEXT');
  ensureColumn(db, 'projects', 'deploy_status', 'TEXT');
  ensureColumn(db, 'projects', 'deploy_error', 'TEXT');
  ensureColumn(db, 'projects', 'deploy_started_at', 'TEXT');
  ensureColumn(db, 'projects', 'deploy_finished_at', 'TEXT');
  ensureColumn(db, 'projects', 'workdirs_json', 'TEXT');
  ensureColumn(db, 'projects', 'git_enabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'projects', 'git_push', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'projects', 'simple_model', 'TEXT');
  ensureColumn(db, 'projects', 'complex_model', 'TEXT');
  ensureColumn(db, 'projects', 'default_template', 'TEXT');
  ensureColumn(db, 'projects', 'enabled_templates', 'TEXT');
  ensureColumn(db, 'tasks', 'workdirs_json', 'TEXT');
  ensureColumn(db, 'tasks', 'git_commit', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'tasks', 'queue_position', 'INTEGER');
  ensureColumn(db, 'tasks', 'source_schedule_id', 'TEXT');
  backfillPendingQueuePositions(db);
  db.exec(`
    UPDATE projects
    SET workdirs_json = json_array(json_object('path', workdir))
    WHERE workdirs_json IS NULL
      AND workdir IS NOT NULL
      AND trim(workdir) != ''
  `);
  db.exec(`
    UPDATE tasks
    SET workdirs_json = json_array(json_object('path', workdir))
    WHERE workdirs_json IS NULL
      AND workdir IS NOT NULL
      AND trim(workdir) != ''
  `);
  db.exec("UPDATE tasks SET deploy_completed = 1 WHERE status = 'done' AND deploy_completed = 0");
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived)');
}

function normalizeWorkdirEntry(entry) {
  if (typeof entry === 'string') {
    const dir = entry.trim();
    return dir ? { label: '', path: dir } : null;
  }
  if (entry && typeof entry === 'object') {
    const dir = String(entry.path || '').trim();
    if (!dir) return null;
    return {
      label: String(entry.label || '').trim(),
      path: dir,
    };
  }
  return null;
}

function normalizeWorkdirs(workdirs) {
  if (!Array.isArray(workdirs)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of workdirs) {
    const normalized = normalizeWorkdirEntry(entry);
    if (!normalized) continue;
    const key = normalized.path.replace(/\//g, '\\').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function parseWorkdirsJson(workdirsJson, fallbackWorkdir) {
  if (workdirsJson) {
    try {
      const parsed = normalizeWorkdirs(JSON.parse(workdirsJson));
      if (parsed.length) return parsed;
    } catch (_) {
      // ignore invalid json and fall back to legacy workdir
    }
  }
  if (fallbackWorkdir) {
    return [{ label: '', path: fallbackWorkdir }];
  }
  return [];
}

function parseProjectWorkdirs(row) {
  if (!row) return [];
  return parseWorkdirsJson(row.workdirs_json, row.workdir);
}

function parseTaskWorkdirs(row) {
  if (!row) return [];
  return parseWorkdirsJson(row.workdirs_json, row.workdir);
}

function openDb() {
  ensureDataDir();
  const db = new Database(path.join(DATA_DIR, 'tasks.db'));
  db.pragma('journal_mode = WAL');
  ensureSchema(db);
  return db;
}

function mapTask(row) {
  if (!row) return null;
  const workdirs = parseTaskWorkdirs(row);
  return {
    ...row,
    workdirs,
    workdir: workdirs[0]?.path || row.workdir || null,
    variables: JSON.parse(row.variables || '{}'),
    attachments: row.attachments_json ? JSON.parse(row.attachments_json) : [],
    is_complex: Boolean(row.is_complex),
    pipeline_mode: Boolean(row.pipeline_mode),
    pipeline_phase: row.pipeline_phase || null,
    deploy_completed: Boolean(row.deploy_completed),
    git_commit: Boolean(row.git_commit),
    archived: Boolean(row.archived),
    archived_at: row.archived_at || null,
    session_id: row.session_id || null,
    parent_task_id: row.parent_task_id || null,
    source_schedule_id: row.source_schedule_id || null,
    queue_position: row.queue_position == null ? null : Number(row.queue_position),
    interaction: row.interaction_json ? JSON.parse(row.interaction_json) : null,
  };
}

function mapProject(row) {
  if (!row) return null;
  const workdirs = parseProjectWorkdirs(row);
  return {
    ...row,
    workdirs,
    workdir: workdirs[0]?.path || row.workdir || null,
    git_enabled: Boolean(row.git_enabled),
    git_push: Boolean(row.git_push),
    simple_model: row.simple_model || null,
    complex_model: row.complex_model || null,
    default_template: row.default_template || null,
    enabled_templates: parseEnabledTemplates(row.enabled_templates),
  };
}

function parseEnabledTemplates(value) {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((id) => String(id)) : null;
  } catch (_) {
    return null;
  }
}

function createProjectRepo(db) {
  return {
    ensureMachineProject() {
      const existing = db.prepare("SELECT * FROM projects WHERE type = 'machine'").get();
      if (existing) return mapProject(existing);
      db.prepare(`
        INSERT INTO projects (
          id, name, type, workdir, deploy_command, is_system, created_at
        ) VALUES ('machine', '本机', 'machine', NULL, NULL, 1, ?)
      `).run(new Date().toISOString());
      return this.getProject('machine');
    },

    createProject(project) {
      const workdirs = normalizeWorkdirs(
        project.workdirs || (project.workdir ? [{ path: project.workdir }] : []),
      );
      const workdirsJson = workdirs.length ? JSON.stringify(workdirs) : null;
      const primaryWorkdir = workdirs[0]?.path || project.workdir || null;
      db.prepare(`
        INSERT INTO projects (
          id, name, type, workdir, workdirs_json, deploy_command, git_enabled, git_push,
          simple_model, complex_model, default_template, is_system, created_at
        ) VALUES (
          @id, @name, @type, @workdir, @workdirs_json, @deploy_command, @git_enabled, @git_push,
          @simple_model, @complex_model, @default_template, @is_system, @created_at
        )
      `).run({
        id: project.id,
        name: project.name,
        type: project.type || 'normal',
        workdir: primaryWorkdir,
        workdirs_json: workdirsJson,
        deploy_command: project.type === 'machine' ? null : (project.deploy_command || null),
        git_enabled: project.type === 'machine' ? 0 : (project.git_enabled ? 1 : 0),
        git_push: project.type === 'machine' ? 0 : (project.git_push ? 1 : 0),
        simple_model: project.type === 'machine' ? null : (project.simple_model || null),
        complex_model: project.type === 'machine' ? null : (project.complex_model || null),
        default_template: project.type === 'machine' ? null : (project.default_template || null),
        is_system: project.is_system || 0,
        created_at: project.created_at,
      });
      return this.getProject(project.id);
    },

    getProject(id) {
      return mapProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
    },

    listProjects() {
      return db.prepare('SELECT * FROM projects ORDER BY is_system DESC, created_at ASC').all();
    },

    updateProjectWorkdirs(id, workdirs) {
      const project = this.getProject(id);
      if (!project) throw new Error('项目不存在');
      if (project.type === 'machine') throw new Error('本机项目不支持修改目录');
      const normalized = normalizeWorkdirs(workdirs);
      if (!normalized.length) throw new Error('至少需要一个工作目录');
      db.prepare('UPDATE projects SET workdirs_json = ?, workdir = ? WHERE id = ?')
        .run(JSON.stringify(normalized), normalized[0].path, id);
      return this.getProject(id);
    },

    updateDeployCommand(id, deployCommand) {
      const project = this.getProject(id);
      if (!project) throw new Error('项目不存在');
      if (project.type === 'machine') throw new Error('本机项目不支持部署');
      db.prepare('UPDATE projects SET deploy_command = ? WHERE id = ?')
        .run(String(deployCommand || '').trim() || null, id);
      return this.getProject(id);
    },

    updateProjectGit(id, patch) {
      const project = this.getProject(id);
      if (!project) throw new Error('项目不存在');
      if (project.type === 'machine') throw new Error('本机项目不支持 Git 配置');
      const gitEnabled = Object.prototype.hasOwnProperty.call(patch, 'gitEnabled')
        ? Boolean(patch.gitEnabled)
        : project.git_enabled;
      const gitPush = Object.prototype.hasOwnProperty.call(patch, 'gitPush')
        ? Boolean(patch.gitPush)
        : project.git_push;
      db.prepare('UPDATE projects SET git_enabled = ?, git_push = ? WHERE id = ?')
        .run(gitEnabled ? 1 : 0, gitPush && gitEnabled ? 1 : 0, id);
      return this.getProject(id);
    },

    updateProjectDefaults(id, patch) {
      const project = this.getProject(id);
      if (!project) throw new Error('项目不存在');
      if (project.type === 'machine') throw new Error('本机项目不支持默认配置');
      db.prepare(`
        UPDATE projects
        SET simple_model = ?, complex_model = ?, default_template = ?
        WHERE id = ?
      `).run(
        patch.simpleModel || null,
        patch.complexModel || null,
        patch.defaultTemplate || null,
        id,
      );
      return this.getProject(id);
    },

    updateEnabledTemplates(id, ids) {
      const project = this.getProject(id);
      if (!project) throw new Error('项目不存在');
      const value = Array.isArray(ids)
        ? JSON.stringify(ids.map((item) => String(item)))
        : null;
      db.prepare('UPDATE projects SET enabled_templates = ? WHERE id = ?').run(value, id);
      return this.getProject(id);
    },

    ensureDeployCommandForWorkdir(workdir, deployCommand) {
      db.prepare(`
        UPDATE projects
        SET deploy_command = ?
        WHERE type != 'machine'
          AND lower(workdir) = lower(?)
          AND (deploy_command IS NULL OR trim(deploy_command) = '')
      `).run(deployCommand, workdir);
    },

    updateDeployState(id, patch) {
      const fields = [
        'deploy_status',
        'deploy_error',
        'deploy_started_at',
        'deploy_finished_at',
      ];
      const entries = fields.filter((field) => Object.prototype.hasOwnProperty.call(patch, field));
      if (!entries.length) return this.getProject(id);
      const assignments = entries.map((field) => `${field} = @${field}`).join(', ');
      db.prepare(`UPDATE projects SET ${assignments} WHERE id = @id`).run({ id, ...patch });
      return this.getProject(id);
    },

    deleteProject(id) {
      const project = this.getProject(id);
      if (!project) throw new Error('项目不存在');
      if (project.is_system) throw new Error('系统项目不能删除');
      const count = db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?').get(id).count;
      if (count > 0) throw new Error('项目下存在任务，不能删除');
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    },
  };
}

function createTaskRepo(db) {
  const insertTask = db.prepare(`
    INSERT INTO tasks (
      id, project_id, title, template, variables, attachments_json, workdir, workdirs_json, status,
      is_complex, pipeline_mode, git_commit, model_id, prompt_rendered, parent_task_id, source_schedule_id,
      queue_position, created_at
    ) VALUES (
      @id, @project_id, @title, @template, @variables, @attachments_json, @workdir, @workdirs_json, @status,
      @is_complex, @pipeline_mode, @git_commit, @model_id, @prompt_rendered, @parent_task_id, @source_schedule_id,
      @queue_position, @created_at
    )
  `);

  const insertEvent = db.prepare(`
    INSERT INTO task_events (task_id, type, payload, created_at)
    VALUES (@task_id, @type, @payload, @created_at)
  `);

  return {
    getNextQueuePosition(projectId) {
      const row = db.prepare(`
        SELECT MAX(queue_position) AS max_pos
        FROM tasks
        WHERE project_id = ?
          AND status = 'pending'
          AND archived = 0
      `).get(projectId);
      return (row?.max_pos || 0) + 1;
    },

    createTask(task) {
      const queuePosition = task.status === 'pending' && task.project_id
        ? (task.queue_position ?? this.getNextQueuePosition(task.project_id))
        : null;
      insertTask.run({
        id: task.id,
        project_id: task.project_id || null,
        title: task.title,
        template: task.template,
        variables: JSON.stringify(task.variables || {}),
        attachments_json: JSON.stringify(task.attachments || []),
        workdir: task.workdir,
        workdirs_json: JSON.stringify(task.workdirs || [{ label: '', path: task.workdir }]),
        status: task.status,
        is_complex: task.is_complex ? 1 : 0,
        pipeline_mode: task.pipeline_mode ? 1 : 0,
        git_commit: task.git_commit ? 1 : 0,
        model_id: task.model_id || null,
        prompt_rendered: task.prompt_rendered,
        parent_task_id: task.parent_task_id || null,
        source_schedule_id: task.source_schedule_id || null,
        queue_position: queuePosition,
        created_at: task.created_at,
      });
      return this.getTask(task.id);
    },

    getTask(id) {
      return mapTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
    },

    listTasks(status, projectId, options = {}) {
      const clauses = [];
      const params = [];
      if (status) {
        clauses.push('status = ?');
        params.push(status);
      }
      if (projectId) {
        clauses.push('project_id = ?');
        params.push(projectId);
      }
      if (options.archived === true) {
        clauses.push('archived = 1');
      } else if (options.archived !== 'all') {
        clauses.push('archived = 0');
      }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      const orderBy = status === 'pending'
        ? 'COALESCE(queue_position, 9223372036854775807) ASC, created_at ASC, id ASC'
        : 'created_at ASC';
      return db.prepare(`SELECT * FROM tasks${where} ORDER BY ${orderBy}`).all(...params).map(mapTask);
    },

    appendPendingQueuePosition(id) {
      const task = this.getTask(id);
      if (!task) throw new Error('任务不存在');
      const next = this.getNextQueuePosition(task.project_id);
      db.prepare('UPDATE tasks SET queue_position = ? WHERE id = ?').run(next, id);
      return this.getTask(id);
    },

    reorderPendingTasks(projectId, orderedIds) {
      const pending = db.prepare(`
        SELECT id FROM tasks
        WHERE project_id = ?
          AND status = 'pending'
          AND archived = 0
        ORDER BY COALESCE(queue_position, 9223372036854775807) ASC, created_at ASC, id ASC
      `).all(projectId).map((row) => row.id);
      const expected = [...pending].sort();
      const received = [...orderedIds].sort();
      if (expected.length !== received.length || !expected.every((id, index) => id === received[index])) {
        throw new Error('任务列表已变化，请刷新后重试');
      }
      const apply = db.transaction((ids) => {
        ids.forEach((taskId, index) => {
          db.prepare('UPDATE tasks SET queue_position = ? WHERE id = ?').run(index + 1, taskId);
        });
      });
      apply(orderedIds);
      return orderedIds.map((taskId) => this.getTask(taskId));
    },

    updateStatus(id, patch) {
      const fields = [
        'status',
        'title',
        'result_summary',
        'error_message',
        'started_at',
        'finished_at',
        'pipeline_phase',
        'deploy_completed',
        'session_id',
      ];
      const entries = fields.filter((field) => Object.prototype.hasOwnProperty.call(patch, field));
      if (entries.length === 0) return this.getTask(id);
      const assignments = entries.map((field) => `${field} = @${field}`).join(', ');
      db.prepare(`UPDATE tasks SET ${assignments} WHERE id = @id`).run({ id, ...patch });
      return this.getTask(id);
    },

    updateForIteration(id, patch) {
      const fields = [
        'status',
        'result_summary',
        'error_message',
        'started_at',
        'finished_at',
        'pipeline_phase',
        'deploy_completed',
        'prompt_rendered',
        'git_commit',
      ];
      const entries = fields.filter((field) => Object.prototype.hasOwnProperty.call(patch, field));
      const assignments = entries.map((field) => `${field} = @${field}`).join(', ');
      const values = { id, ...patch };
      if (Object.prototype.hasOwnProperty.call(patch, 'git_commit')) {
        values.git_commit = patch.git_commit ? 1 : 0;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'variables')) {
        values.variables = JSON.stringify(patch.variables || {});
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'attachments')) {
        values.attachments_json = JSON.stringify(patch.attachments || []);
      }
      let sqlAssignments = assignments;
      if (Object.prototype.hasOwnProperty.call(patch, 'variables')) {
        sqlAssignments = sqlAssignments ? `${sqlAssignments}, variables = @variables` : 'variables = @variables';
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'attachments')) {
        sqlAssignments = sqlAssignments
          ? `${sqlAssignments}, attachments_json = @attachments_json`
          : 'attachments_json = @attachments_json';
      }
      if (!sqlAssignments) return this.getTask(id);
      db.prepare(`UPDATE tasks SET ${sqlAssignments} WHERE id = @id`).run(values);
      return this.getTask(id);
    },

    updateTitle(id, title) {
      const trimmed = String(title || '').trim();
      if (!trimmed) return this.getTask(id);
      db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run(trimmed.slice(0, 120), id);
      return this.getTask(id);
    },

    setInteraction(id, interaction) {
      db.prepare('UPDATE tasks SET interaction_json = ? WHERE id = ?')
        .run(interaction ? JSON.stringify(interaction) : null, id);
      return this.getTask(id);
    },

    setPlan(id, planText) {
      db.prepare('UPDATE tasks SET plan_text = ? WHERE id = ?').run(planText || null, id);
      return this.getTask(id);
    },

    assignUnscopedTasks(projectId) {
      return db.prepare('UPDATE tasks SET project_id = ? WHERE project_id IS NULL').run(projectId).changes;
    },

    countByProject(projectId) {
      const rows = db.prepare(`
        SELECT status, COUNT(*) AS count
        FROM tasks
        WHERE project_id = ? AND archived = 0
        GROUP BY status
      `).all(projectId);
      return Object.fromEntries(rows.map((row) => [row.status, row.count]));
    },

    countArchivedByProject(projectId) {
      const row = db.prepare(`
        SELECT COUNT(*) AS count
        FROM tasks
        WHERE project_id = ? AND archived = 1
      `).get(projectId);
      return row?.count || 0;
    },

    archiveTasks(ids, projectId) {
      if (!ids?.length) return [];
      const now = new Date().toISOString();
      const stmt = db.prepare(`
        UPDATE tasks
        SET archived = 1,
            archived_at = @now
        WHERE id = @id
          AND archived = 0
          AND project_id = @project_id
      `);
      const archived = [];
      for (const id of ids) {
        const result = stmt.run({ id, now, project_id: projectId });
        if (result.changes > 0) {
          archived.push(this.getTask(id));
        }
      }
      return archived;
    },

    addEvent(taskId, type, payload) {
      const result = insertEvent.run({
        task_id: taskId,
        type,
        payload: JSON.stringify(payload || {}),
        created_at: new Date().toISOString(),
      });
      if (type === 'log_chunk' && Number(result.lastInsertRowid) % LOG_EVENT_PRUNE_INTERVAL === 0) {
        db.prepare(`
          DELETE FROM task_events
          WHERE task_id = ?
            AND type = 'log_chunk'
            AND id NOT IN (
              SELECT id
              FROM (
                SELECT
                  id,
                  SUM(length(payload)) OVER (ORDER BY id DESC) AS total_bytes,
                  ROW_NUMBER() OVER (ORDER BY id DESC) AS row_number
                FROM task_events
                WHERE task_id = ?
                  AND type = 'log_chunk'
              )
              WHERE total_bytes <= ?
                AND row_number <= ?
            )
        `).run(
          taskId,
          taskId,
          MAX_LOG_EVENT_BYTES_PER_TASK,
          MAX_LOG_EVENTS_PER_TASK,
        );
      }
    },

    listEvents(taskId) {
      return db
        .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id ASC')
        .all(taskId)
        .map((row) => ({
          ...row,
          payload: JSON.parse(row.payload || '{}'),
        }));
    },

    listPendingDeployTasks(projectId, workdir, excludeId) {
      return db.prepare(`
        SELECT * FROM tasks
        WHERE project_id = @project_id
          AND workdir = @workdir
          AND pipeline_mode = 1
          AND deploy_completed = 0
          AND archived = 0
          AND id != @exclude_id
          AND status = 'pending_deploy'
        ORDER BY created_at ASC
      `).all({
        project_id: projectId,
        workdir,
        exclude_id: excludeId,
      }).map(mapTask);
    },

    listProjectPendingDeployTasks(projectId) {
      return db.prepare(`
        SELECT * FROM tasks
        WHERE project_id = ?
          AND pipeline_mode = 1
          AND deploy_completed = 0
          AND archived = 0
          AND status = 'pending_deploy'
        ORDER BY created_at ASC
      `).all(projectId).map(mapTask);
    },

    markDeploying(ids) {
      const stmt = db.prepare(`
        UPDATE tasks
        SET status = 'deploying',
            pipeline_phase = 'deploy',
            error_message = NULL
        WHERE id = ?
      `);
      for (const id of ids) stmt.run(id);
    },

    markDeployPending(ids, error) {
      const stmt = db.prepare(`
        UPDATE tasks
        SET status = 'pending_deploy',
            pipeline_phase = 'pending_deploy',
            error_message = ?
        WHERE id = ?
      `);
      for (const id of ids) stmt.run(error || null, id);
    },

    markDeployCompleted(ids) {
      const now = new Date().toISOString();
      const stmt = db.prepare(`
        UPDATE tasks
        SET deploy_completed = 1,
            status = 'done',
            pipeline_phase = 'done',
            finished_at = COALESCE(finished_at, @now),
            error_message = NULL
        WHERE id = @id
      `);
      for (const id of ids) {
        stmt.run({ id, now });
      }
    },

    recoverStaleRunning() {
      const now = new Date().toISOString();
      const stale = db
        .prepare("SELECT id FROM tasks WHERE status IN ('planning', 'running', 'developing', 'testing', 'committing', 'deploying')")
        .all();
      for (const row of stale) {
        this.updateStatus(row.id, {
          status: 'failed',
          error_message: '服务重启，任务中断',
          finished_at: now,
        });
        this.addEvent(row.id, 'status_change', {
          status: 'failed',
          reason: 'recover_stale_running',
        });
      }
      return stale.length;
    },
  };
}

function mapChatSession(row) {
  if (!row) return null;
  return {
    ...row,
    interaction: row.interaction_json ? JSON.parse(row.interaction_json) : null,
  };
}

function mapChatMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    content: row.content,
    stream: row.stream || null,
    created_at: row.created_at,
  };
}

function createChatRepo(db) {
  const insertSession = db.prepare(`
    INSERT INTO chat_sessions (
      id, project_id, title, workdir, agent_session_id, model_id, status, created_at, updated_at
    ) VALUES (
      @id, @project_id, @title, @workdir, @agent_session_id, @model_id, @status, @created_at, @updated_at
    )
  `);

  const insertMessage = db.prepare(`
    INSERT INTO chat_messages (session_id, role, content, stream, created_at)
    VALUES (@session_id, @role, @content, @stream, @created_at)
  `);

  return {
    createSession(session) {
      insertSession.run({
        id: session.id,
        project_id: session.project_id || null,
        title: session.title || '新对话',
        workdir: session.workdir,
        agent_session_id: session.agent_session_id || null,
        model_id: session.model_id || null,
        status: session.status || 'idle',
        created_at: session.created_at,
        updated_at: session.updated_at,
      });
      return this.getSession(session.id);
    },

    getSession(id) {
      return mapChatSession(db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id));
    },

    listSessions(projectId) {
      if (projectId === null || projectId === undefined) {
        return db.prepare(`
          SELECT * FROM chat_sessions
          WHERE project_id IS NULL
          ORDER BY updated_at DESC
        `).all().map(mapChatSession);
      }
      return db.prepare(`
        SELECT * FROM chat_sessions
        WHERE project_id = ?
        ORDER BY updated_at DESC
      `).all(projectId).map(mapChatSession);
    },

    updateSession(id, patch) {
      const assignments = [];
      const values = { id };
      if (Object.prototype.hasOwnProperty.call(patch, 'title')) {
        assignments.push('title = @title');
        values.title = patch.title;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'agent_session_id')) {
        assignments.push('agent_session_id = @agent_session_id');
        values.agent_session_id = patch.agent_session_id;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
        assignments.push('status = @status');
        values.status = patch.status;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'error_message')) {
        assignments.push('error_message = @error_message');
        values.error_message = patch.error_message;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'updated_at')) {
        assignments.push('updated_at = @updated_at');
        values.updated_at = patch.updated_at;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'interaction')) {
        assignments.push('interaction_json = @interaction_json');
        values.interaction_json = patch.interaction ? JSON.stringify(patch.interaction) : null;
      }
      if (!assignments.length) return this.getSession(id);
      db.prepare(`UPDATE chat_sessions SET ${assignments.join(', ')} WHERE id = @id`).run(values);
      return this.getSession(id);
    },

    setInteraction(id, interaction) {
      db.prepare('UPDATE chat_sessions SET interaction_json = ? WHERE id = ?')
        .run(interaction ? JSON.stringify(interaction) : null, id);
      return this.getSession(id);
    },

    addMessage(sessionId, message) {
      const now = message.created_at || new Date().toISOString();
      const result = insertMessage.run({
        session_id: sessionId,
        role: message.role,
        content: message.content || '',
        stream: message.stream || null,
        created_at: now,
      });
      db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
      return this.getMessage(result.lastInsertRowid);
    },

    getMessage(id) {
      return mapChatMessage(db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id));
    },

    listMessages(sessionId) {
      return db.prepare(`
        SELECT * FROM chat_messages
        WHERE session_id = ?
        ORDER BY id ASC
      `).all(sessionId).map(mapChatMessage);
    },

    recoverStaleRunning() {
      const now = new Date().toISOString();
      const stale = db.prepare("SELECT id FROM chat_sessions WHERE status = 'running'").all();
      for (const row of stale) {
        this.updateSession(row.id, {
          status: 'idle',
          error_message: '服务重启，对话中断',
          updated_at: now,
        });
      }
      return stale.length;
    },
  };
}

function mapProjectTemplate(row) {
  if (!row) return null;
  let defaults = null;
  let variables = [];
  try {
    defaults = row.defaults_json ? JSON.parse(row.defaults_json) : null;
  } catch (_) {
    defaults = null;
  }
  try {
    const parsed = row.variables_json ? JSON.parse(row.variables_json) : [];
    variables = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    variables = [];
  }
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    category: row.category || '项目',
    description: row.description || '',
    defaults: defaults || {},
    variables,
    prompt: row.prompt || '',
    order: row.sort_order == null ? null : Number(row.sort_order),
    scope: 'project',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createProjectTemplateRepo(db) {
  const insertTemplate = db.prepare(`
    INSERT INTO project_templates (
      id, project_id, name, category, description, defaults_json, variables_json, prompt, sort_order,
      created_at, updated_at
    ) VALUES (
      @id, @project_id, @name, @category, @description, @defaults_json, @variables_json, @prompt, @sort_order,
      @created_at, @updated_at
    )
  `);

  return {
    list(projectId) {
      return db.prepare(`
        SELECT * FROM project_templates
        WHERE project_id = ?
        ORDER BY sort_order ASC, created_at ASC
      `).all(projectId).map(mapProjectTemplate);
    },

    get(id) {
      return mapProjectTemplate(db.prepare('SELECT * FROM project_templates WHERE id = ?').get(id));
    },

    getForProject(projectId, id) {
      return mapProjectTemplate(
        db.prepare('SELECT * FROM project_templates WHERE id = ? AND project_id = ?').get(id, projectId),
      );
    },

    create(template) {
      const now = new Date().toISOString();
      insertTemplate.run({
        id: template.id,
        project_id: template.project_id,
        name: template.name,
        category: template.category || '项目',
        description: template.description || '',
        defaults_json: JSON.stringify(template.defaults || {}),
        variables_json: JSON.stringify(template.variables || []),
        prompt: template.prompt || '',
        sort_order: template.order == null ? null : Number(template.order),
        created_at: template.created_at || now,
        updated_at: template.updated_at || now,
      });
      return this.get(template.id);
    },

    update(id, patch) {
      const assignments = [];
      const values = { id, updated_at: new Date().toISOString() };
      const setField = (column, key, transform) => {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) return;
        assignments.push(`${column} = @${column}`);
        values[column] = transform ? transform(patch[key]) : patch[key];
      };
      setField('name', 'name');
      setField('category', 'category');
      setField('description', 'description');
      setField('defaults_json', 'defaults', (value) => JSON.stringify(value || {}));
      setField('variables_json', 'variables', (value) => JSON.stringify(value || []));
      setField('prompt', 'prompt');
      setField('sort_order', 'order', (value) => (value == null ? null : Number(value)));
      if (!assignments.length) return this.get(id);
      assignments.push('updated_at = @updated_at');
      db.prepare(`UPDATE project_templates SET ${assignments.join(', ')} WHERE id = @id`).run(values);
      return this.get(id);
    },

    delete(id) {
      db.prepare('DELETE FROM project_templates WHERE id = ?').run(id);
    },
  };
}

function mapSchedule(row) {
  if (!row) return null;
  let variables = {};
  try {
    variables = row.variables_json ? JSON.parse(row.variables_json) : {};
  } catch (_) {
    variables = {};
  }
  return {
    id: row.id,
    project_id: row.project_id,
    template_id: row.template_id,
    name: row.name,
    variables: variables || {},
    workdirs: parseWorkdirsJson(row.workdirs_json, null),
    trigger: row.trigger || 'manual',
    cron_expr: row.cron_expr || null,
    enabled: Boolean(row.enabled),
    last_run_at: row.last_run_at || null,
    last_task_id: row.last_task_id || null,
    last_status: row.last_status || null,
    next_run_at: row.next_run_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createScheduleRepo(db) {
  const insertSchedule = db.prepare(`
    INSERT INTO schedules (
      id, project_id, template_id, name, variables_json, workdirs_json, trigger, cron_expr, enabled,
      created_at, updated_at
    ) VALUES (
      @id, @project_id, @template_id, @name, @variables_json, @workdirs_json, @trigger, @cron_expr, @enabled,
      @created_at, @updated_at
    )
  `);

  const serializeWorkdirs = (workdirs) => {
    const normalized = normalizeWorkdirs(workdirs || []);
    return normalized.length ? JSON.stringify(normalized) : null;
  };

  return {
    list(projectId) {
      return db.prepare(`
        SELECT * FROM schedules
        WHERE project_id = ?
        ORDER BY created_at ASC
      `).all(projectId).map(mapSchedule);
    },

    listAll() {
      return db.prepare('SELECT * FROM schedules ORDER BY created_at ASC').all().map(mapSchedule);
    },

    listAllEnabledCron() {
      return db.prepare(`
        SELECT * FROM schedules
        WHERE enabled = 1 AND trigger = 'cron' AND cron_expr IS NOT NULL AND trim(cron_expr) != ''
        ORDER BY created_at ASC
      `).all().map(mapSchedule);
    },

    get(id) {
      return mapSchedule(db.prepare('SELECT * FROM schedules WHERE id = ?').get(id));
    },

    getForProject(projectId, id) {
      return mapSchedule(
        db.prepare('SELECT * FROM schedules WHERE id = ? AND project_id = ?').get(id, projectId),
      );
    },

    create(schedule) {
      const now = new Date().toISOString();
      insertSchedule.run({
        id: schedule.id,
        project_id: schedule.project_id,
        template_id: schedule.template_id,
        name: schedule.name,
        variables_json: JSON.stringify(schedule.variables || {}),
        workdirs_json: serializeWorkdirs(schedule.workdirs),
        trigger: schedule.trigger === 'cron' ? 'cron' : 'manual',
        cron_expr: schedule.cron_expr || null,
        enabled: schedule.enabled === false ? 0 : 1,
        created_at: schedule.created_at || now,
        updated_at: schedule.updated_at || now,
      });
      return this.get(schedule.id);
    },

    update(id, patch) {
      const assignments = [];
      const values = { id };
      const setField = (column, key, transform) => {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) return;
        assignments.push(`${column} = @${column}`);
        values[column] = transform ? transform(patch[key]) : patch[key];
      };
      setField('template_id', 'template_id');
      setField('name', 'name');
      setField('variables_json', 'variables', (value) => JSON.stringify(value || {}));
      setField('workdirs_json', 'workdirs', (value) => serializeWorkdirs(value));
      setField('trigger', 'trigger', (value) => (value === 'cron' ? 'cron' : 'manual'));
      setField('cron_expr', 'cron_expr', (value) => value || null);
      setField('enabled', 'enabled', (value) => (value ? 1 : 0));
      if (!assignments.length) return this.get(id);
      assignments.push('updated_at = @updated_at');
      values.updated_at = new Date().toISOString();
      db.prepare(`UPDATE schedules SET ${assignments.join(', ')} WHERE id = @id`).run(values);
      return this.get(id);
    },

    recordRun(id, patch = {}) {
      const assignments = [];
      const values = { id };
      const setField = (column, key) => {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) return;
        assignments.push(`${column} = @${column}`);
        values[column] = patch[key];
      };
      setField('last_run_at', 'last_run_at');
      setField('last_task_id', 'last_task_id');
      setField('last_status', 'last_status');
      setField('next_run_at', 'next_run_at');
      if (!assignments.length) return this.get(id);
      db.prepare(`UPDATE schedules SET ${assignments.join(', ')} WHERE id = @id`).run(values);
      return this.get(id);
    },

    setNextRun(id, nextRunAt) {
      db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(nextRunAt || null, id);
      return this.get(id);
    },

    delete(id) {
      db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    },
  };
}

module.exports = {
  DATA_DIR,
  ensureDataDir,
  ensureSchema,
  openDb,
  createProjectRepo,
  createTaskRepo,
  createChatRepo,
  createProjectTemplateRepo,
  createScheduleRepo,
  normalizeWorkdirs,
  parseProjectWorkdirs,
  parseTaskWorkdirs,
};
