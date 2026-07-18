const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');

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
  `);
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
  ensureColumn(db, 'tasks', 'workdirs_json', 'TEXT');
  ensureColumn(db, 'tasks', 'git_commit', 'INTEGER NOT NULL DEFAULT 0');
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
  };
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
          id, name, type, workdir, workdirs_json, deploy_command, git_enabled, git_push, is_system, created_at
        ) VALUES (
          @id, @name, @type, @workdir, @workdirs_json, @deploy_command, @git_enabled, @git_push, @is_system, @created_at
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
      is_complex, pipeline_mode, git_commit, model_id, prompt_rendered, parent_task_id, created_at
    ) VALUES (
      @id, @project_id, @title, @template, @variables, @attachments_json, @workdir, @workdirs_json, @status,
      @is_complex, @pipeline_mode, @git_commit, @model_id, @prompt_rendered, @parent_task_id, @created_at
    )
  `);

  const insertEvent = db.prepare(`
    INSERT INTO task_events (task_id, type, payload, created_at)
    VALUES (@task_id, @type, @payload, @created_at)
  `);

  return {
    createTask(task) {
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
      return db.prepare(`SELECT * FROM tasks${where} ORDER BY created_at ASC`).all(...params).map(mapTask);
    },

    updateStatus(id, patch) {
      const fields = [
        'status',
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
          AND status = 'done'
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
      insertEvent.run({
        task_id: taskId,
        type,
        payload: JSON.stringify(payload || {}),
        created_at: new Date().toISOString(),
      });
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

module.exports = {
  DATA_DIR,
  ensureDataDir,
  ensureSchema,
  openDb,
  createProjectRepo,
  createTaskRepo,
  normalizeWorkdirs,
  parseProjectWorkdirs,
  parseTaskWorkdirs,
};
