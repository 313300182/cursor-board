const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { ensureSchema, createProjectRepo, createTaskRepo } = require('../db');

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
  db.close();
});

test('已完成任务可归档且默认列表不再返回', () => {
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

  const skipped = tasks.archiveTasks(['pending-1'], project.id);
  assert.equal(skipped.length, 0);
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

  const { scanProjectRules } = require('../project-rules');
  const rules = await scanProjectRules(root);

  assert.equal(rules.length, 1);
  assert.equal(rules[0].name, 'java-style.mdc');
  assert.equal(rules[0].metadata.description, 'Java style');
  assert.equal(rules[0].content, '# Java 规范\n只使用 Java 8。');
  fs.rmSync(root, { recursive: true, force: true });
});
