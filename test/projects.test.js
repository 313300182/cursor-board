const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { ensureSchema, createProjectRepo, createTaskRepo, normalizeWorkdirs } = require('../db');

function createMemoryRepos() {
  const db = new Database(':memory:');
  ensureSchema(db);
  return {
    db,
    projects: createProjectRepo(db),
    tasks: createTaskRepo(db),
  };
}

test('首次初始化会创建不可删除的本机项目', () => {
  const { db, projects } = createMemoryRepos();

  const machine = projects.ensureMachineProject();

  assert.equal(machine.type, 'machine');
  assert.equal(machine.name, '本机');
  assert.equal(machine.workdir, null);
  assert.equal(machine.is_system, 1);
  assert.throws(() => projects.deleteProject(machine.id), /系统项目不能删除/);
  db.close();
});

test('普通项目保存固定工作目录并可创建关联任务', () => {
  const { db, projects, tasks } = createMemoryRepos();
  const project = projects.createProject({
    id: 'java-app',
    name: 'Java App',
    type: 'normal',
    workdir: 'D:\\code\\java-app',
    created_at: new Date().toISOString(),
  });

  tasks.createTask({
    id: 'task-1',
    project_id: project.id,
    title: '修复登录',
    template: 'bugfix',
    model_id: 'gpt-5.6-luna',
    variables: {},
    workdir: project.workdir,
    status: 'pending',
    is_complex: 0,
    prompt_rendered: 'test',
    created_at: new Date().toISOString(),
  });

  assert.equal(tasks.getTask('task-1').project_id, project.id);
  assert.equal(tasks.getTask('task-1').model_id, 'gpt-5.6-luna');
  assert.equal(tasks.listTasks(undefined, project.id).length, 1);
  assert.deepEqual(project.workdirs, [{ label: '', path: 'D:\\code\\java-app' }]);
  db.close();
});

test('普通项目可保存多个工作目录并后续修改', () => {
  const { db, projects } = createMemoryRepos();
  const project = projects.createProject({
    id: 'full-stack',
    name: 'Full Stack',
    type: 'normal',
    workdirs: [
      { label: '后端', path: 'D:\\code\\api' },
      { label: '前端', path: 'D:\\code\\web' },
    ],
    created_at: new Date().toISOString(),
  });

  assert.equal(project.workdir, 'D:\\code\\api');
  assert.deepEqual(project.workdirs, [
    { label: '后端', path: 'D:\\code\\api' },
    { label: '前端', path: 'D:\\code\\web' },
  ]);

  const updated = projects.updateProjectWorkdirs(project.id, [
    { label: '网关', path: 'D:\\code\\gateway' },
    { label: '后端', path: 'D:\\code\\api' },
  ]);
  assert.equal(updated.workdir, 'D:\\code\\gateway');
  assert.deepEqual(updated.workdirs, [
    { label: '网关', path: 'D:\\code\\gateway' },
    { label: '后端', path: 'D:\\code\\api' },
  ]);
  db.close();
});

test('normalizeWorkdirs 会去重并忽略空路径', () => {
  assert.deepEqual(normalizeWorkdirs([
    { label: '后端', path: 'D:/code/api' },
    { label: '重复', path: 'D:\\code\\api' },
    { label: '空', path: '  ' },
  ]), [{ label: '后端', path: 'D:/code/api' }]);
});

test('普通项目可配置 Git 关联', () => {
  const { db, projects } = createMemoryRepos();
  const project = projects.createProject({
    id: 'git-app',
    name: 'Git App',
    type: 'normal',
    workdir: 'D:\\code\\git-app',
    git_enabled: true,
    git_push: true,
    created_at: new Date().toISOString(),
  });

  assert.equal(project.git_enabled, true);
  assert.equal(project.git_push, true);

  const updated = projects.updateProjectGit(project.id, {
    gitEnabled: true,
    gitPush: false,
  });
  assert.equal(updated.git_push, false);

  projects.ensureMachineProject();
  assert.throws(() => projects.updateProjectGit('machine', { gitEnabled: true }), /不支持 Git/);
  db.close();
});

test('任务可标记需要 Git 提交', () => {
  const { db, projects, tasks } = createMemoryRepos();
  const project = projects.createProject({
    id: 'git-app',
    name: 'Git App',
    type: 'normal',
    workdir: 'D:\\code\\git-app',
    git_enabled: true,
    created_at: new Date().toISOString(),
  });

  tasks.createTask({
    id: 'task-git',
    project_id: project.id,
    title: '提交任务',
    template: 'feature',
    variables: {},
    workdir: project.workdir,
    status: 'pending',
    is_complex: 0,
    pipeline_mode: 1,
    git_commit: 1,
    prompt_rendered: 'test',
    created_at: new Date().toISOString(),
  });

  assert.equal(tasks.getTask('task-git').git_commit, true);
  db.close();
});

test('任意状态任务可归档且默认列表不再返回', () => {
  const { db, projects, tasks } = createMemoryRepos();
  const project = projects.createProject({
    id: 'archive-app',
    name: 'Archive App',
    type: 'normal',
    workdir: 'D:\\code\\archive-app',
    created_at: new Date().toISOString(),
  });

  tasks.createTask({
    id: 'done-1',
    project_id: project.id,
    title: '已完成任务',
    template: 'general',
    variables: {},
    workdir: project.workdir,
    status: 'done',
    is_complex: 0,
    prompt_rendered: 'test',
    created_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  });
  tasks.createTask({
    id: 'pending-1',
    project_id: project.id,
    title: '待执行任务',
    template: 'general',
    variables: {},
    workdir: project.workdir,
    status: 'pending',
    is_complex: 0,
    prompt_rendered: 'test',
    created_at: new Date().toISOString(),
  });

  const archived = tasks.archiveTasks(['done-1'], project.id);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].archived, true);
  assert.ok(archived[0].archived_at);

  assert.equal(tasks.listTasks(undefined, project.id).length, 1);
  assert.equal(tasks.listTasks(undefined, project.id, { archived: true }).length, 1);
  assert.equal(tasks.countArchivedByProject(project.id), 1);
  assert.equal(tasks.countByProject(project.id).done, undefined);

  const pendingArchived = tasks.archiveTasks(['pending-1'], project.id);
  assert.equal(pendingArchived.length, 1);
  assert.equal(pendingArchived[0].archived, true);
  assert.equal(tasks.listTasks(undefined, project.id).length, 0);
  assert.equal(tasks.countArchivedByProject(project.id), 2);
  db.close();
});

test('删除项目：开启外键约束时归档任务并清理关联数据', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  const projects = createProjectRepo(db);
  const tasks = createTaskRepo(db);
  const machine = projects.ensureMachineProject();
  const project = projects.createProject({
    id: 'to-delete',
    name: '待删除项目',
    type: 'normal',
    workdir: 'D:\\code\\to-delete',
    created_at: new Date().toISOString(),
  });

  const now = new Date().toISOString();
  const makeTask = (id, status) => tasks.createTask({
    id,
    project_id: project.id,
    title: id,
    template: 'general',
    variables: {},
    workdir: project.workdir,
    status,
    is_complex: 0,
    prompt_rendered: 'test',
    created_at: now,
  });
  makeTask('done-1', 'done');
  makeTask('pending-1', 'pending');
  const active = makeTask('running-1', 'developing');

  db.prepare(`INSERT INTO chat_sessions (id, project_id, title, workdir, status, created_at, updated_at)
    VALUES ('chat-1', @pid, '会话', @wd, 'idle', @now, @now)`).run({ pid: project.id, wd: project.workdir, now });
  db.prepare(`INSERT INTO project_templates (id, project_id, name, prompt, created_at, updated_at)
    VALUES ('tpl-1', @pid, '私有类型', 'p', @now, @now)`).run({ pid: project.id, now });
  db.prepare(`INSERT INTO schedules (id, project_id, template_id, name, created_at, updated_at)
    VALUES ('sch-1', @pid, 'general', '常驻', @now, @now)`).run({ pid: project.id, now });

  assert.throws(() => projects.deleteProject(project.id), /正在执行的任务/);

  tasks.updateStatus(active.id, { status: 'done' });
  const result = projects.deleteProject(project.id);

  assert.equal(result.archived, 3);
  assert.equal(projects.getProject(project.id), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE project_id = ?').get(project.id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE project_id = ? AND archived = 1').get(machine.id).c, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM chat_sessions WHERE project_id = ?').get(machine.id).c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM project_templates WHERE project_id = ?').get(project.id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM schedules WHERE project_id = ?').get(project.id).c, 0);
  db.close();
});

test('规则扫描递归读取 .cursor/rules 下的 mdc 文件', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-board-rules-'));
  const rulesDir = path.join(root, '.cursor', 'rules', 'nested');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(
    path.join(rulesDir, 'java-style.mdc'),
    '---\ndescription: Java style\nalwaysApply: true\n---\n# Java 规范\n只使用 Java 8。',
    'utf8',
  );

  const { scanProjectRules, scanProjectRulesForWorkdirs } = require('../project-rules');
  const rules = await scanProjectRules(root);

  assert.equal(rules.length, 1);
  assert.equal(rules[0].name, 'java-style.mdc');
  assert.equal(rules[0].metadata.description, 'Java style');
  assert.equal(rules[0].content, '# Java 规范\n只使用 Java 8。');
  fs.rmSync(root, { recursive: true, force: true });
});

test('多目录项目会合并各目录下的 Cursor Rules', async () => {
  const { scanProjectRulesForWorkdirs } = require('../project-rules');
  const backendRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-board-backend-'));
  const frontendRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-board-frontend-'));
  const backendRules = path.join(backendRoot, '.cursor', 'rules');
  const frontendRules = path.join(frontendRoot, '.cursor', 'rules');
  fs.mkdirSync(backendRules, { recursive: true });
  fs.mkdirSync(frontendRules, { recursive: true });
  fs.writeFileSync(path.join(backendRules, 'api.mdc'), '---\n---\n# API', 'utf8');
  fs.writeFileSync(path.join(frontendRules, 'ui.mdc'), '---\n---\n# UI', 'utf8');

  const rules = await scanProjectRulesForWorkdirs([
    { label: '后端', path: backendRoot },
    { label: '前端', path: frontendRoot },
  ]);

  assert.equal(rules.length, 2);
  assert.ok(rules.some((rule) => rule.name === 'api.mdc' && rule.workdirLabel === '后端'));
  assert.ok(rules.some((rule) => rule.name === 'ui.mdc' && rule.workdirLabel === '前端'));
  fs.rmSync(backendRoot, { recursive: true, force: true });
  fs.rmSync(frontendRoot, { recursive: true, force: true });
});

test('Skills 扫描递归读取 .cursor/skills 下的 SKILL.md 文件', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-board-skills-'));
  const skillDir = path.join(root, '.cursor', 'skills', 'java-style');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: java-style\ndescription: Java 代码风格\n---\n# Java 规范\n只使用 Java 8。',
    'utf8',
  );

  const { scanProjectSkills, scanProjectSkillsForWorkdirs } = require('../project-skills');
  const skills = await scanProjectSkills(root);

  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'java-style');
  assert.equal(skills[0].metadata.name, 'java-style');
  assert.equal(skills[0].metadata.description, 'Java 代码风格');
  assert.equal(skills[0].content, '# Java 规范\n只使用 Java 8。');
  fs.rmSync(root, { recursive: true, force: true });
});

test('多目录项目会合并各目录下的 Cursor Skills', async () => {
  const { scanProjectSkillsForWorkdirs } = require('../project-skills');
  const backendRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-board-backend-skills-'));
  const frontendRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-board-frontend-skills-'));
  const backendSkill = path.join(backendRoot, '.cursor', 'skills', 'api');
  const frontendSkill = path.join(frontendRoot, '.cursor', 'skills', 'ui');
  fs.mkdirSync(backendSkill, { recursive: true });
  fs.mkdirSync(frontendSkill, { recursive: true });
  fs.writeFileSync(path.join(backendSkill, 'SKILL.md'), '---\nname: api\n---\n# API', 'utf8');
  fs.writeFileSync(path.join(frontendSkill, 'SKILL.md'), '---\nname: ui\n---\n# UI', 'utf8');

  const skills = await scanProjectSkillsForWorkdirs([
    { label: '后端', path: backendRoot },
    { label: '前端', path: frontendRoot },
  ]);

  assert.equal(skills.length, 2);
  assert.ok(skills.some((skill) => skill.metadata.name === 'api' && skill.workdirLabel === '后端'));
  assert.ok(skills.some((skill) => skill.metadata.name === 'ui' && skill.workdirLabel === '前端'));
  fs.rmSync(backendRoot, { recursive: true, force: true });
  fs.rmSync(frontendRoot, { recursive: true, force: true });
});
