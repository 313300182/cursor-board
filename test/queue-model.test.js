const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TaskQueue = require('../queue');

test('多目录项目创建任务时可选择一个或多个目录', () => {
  const { queue, getCreatedTask } = createQueue({
    workdirs: [
      { label: '后端', path: process.cwd() },
      { label: '前端', path: process.cwd() },
    ],
  });

  queue.createTask({
    projectId: 'board',
    template: 'general',
    workdir: process.cwd(),
    variables: { description: '后端改动' },
  });

  assert.equal(getCreatedTask().workdir, process.cwd());
  assert.equal(getCreatedTask().workdirs.length, 1);

  queue.createTask({
    projectId: 'board',
    template: 'general',
    workdirs: [process.cwd(), process.cwd()],
    variables: { description: '前后端联动' },
  });

  assert.equal(getCreatedTask().workdirs.length, 1);

  assert.throws(() => queue.createTask({
    projectId: 'board',
    template: 'general',
    variables: { description: '缺少目录' },
  }), /请至少选择一个工作目录/);
});

test('多目录任务 prompt 包含全部所选目录', () => {
  const backend = process.cwd();
  const frontend = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-board-front-'));
  try {
    const { queue, getCreatedTask } = createQueue({
      workdirs: [
        { label: '后端', path: backend },
        { label: '前端', path: frontend },
      ],
      allowlist: [backend, frontend],
    });

    queue.createTask({
      projectId: 'board',
      template: 'general',
      workdirs: [backend, frontend],
      variables: { description: '联动改动' },
    });

    assert.match(getCreatedTask().prompt_rendered, /后端：/);
    assert.match(getCreatedTask().prompt_rendered, /前端：/);
    assert.match(getCreatedTask().prompt_rendered, /可同时修改多个仓库/);
    assert.equal(getCreatedTask().workdirs.length, 2);
  } finally {
    fs.rmSync(frontend, { recursive: true, force: true });
  }
});

function createQueue(projectOverrides = {}) {
  let createdTask;
  const projectWorkdirs = projectOverrides.workdirs || [{ label: '', path: process.cwd() }];
  const repo = {
    createTask(task) {
      createdTask = {
        ...task,
        workdirs: task.workdirs || [{ label: '', path: task.workdir }],
      };
      return createdTask;
    },
    addEvent() {},
    listTasks() {
      return [];
    },
  };
  const projects = {
    getProject() {
      return {
        id: 'board',
        type: 'normal',
        workdir: projectWorkdirs[0]?.path || process.cwd(),
        workdirs: projectWorkdirs,
      };
    },
  };
  const allowlist = projectOverrides.allowlist || [process.cwd(), path.dirname(process.cwd())];
  const config = {
    security: { workdirAllowlist: allowlist },
    cursor: {
      models: {
        simpleDefault: 'luna-id',
        complexDefault: 'opus-id',
        options: [
          { id: 'luna-id', name: 'Luna' },
          { id: 'opus-id', name: 'Opus' },
          { id: 'other-id', name: 'Other' },
        ],
      },
    },
  };
  const queue = new TaskQueue({
    repo,
    projects,
    config,
    broadcast() {},
  });
  return { queue, getCreatedTask: () => createdTask };
}

test('创建任务时保存按复杂度解析后的默认模型', () => {
  const { queue, getCreatedTask } = createQueue();

  queue.createTask({
    projectId: 'board',
    title: '复杂任务',
    template: 'general',
    isComplex: true,
    variables: { description: '测试' },
  });

  assert.equal(getCreatedTask().model_id, 'opus-id');
});

test('创建任务时保存用户选择的模型', () => {
  const { queue, getCreatedTask } = createQueue();

  queue.createTask({
    projectId: 'board',
    title: '指定模型',
    template: 'general',
    modelId: 'other-id',
    variables: { description: '测试' },
  });

  assert.equal(getCreatedTask().model_id, 'other-id');
});

test('创建流水线任务时保存 pipeline_mode', () => {
  const { queue, getCreatedTask } = createQueue();

  queue.createTask({
    projectId: 'board',
    title: '流水线任务',
    template: 'feature',
    pipelineMode: true,
    variables: { requirement: '新功能' },
  });

  assert.equal(getCreatedTask().pipeline_mode, true);
});

test('开发类模板默认启用流水线', () => {
  const { queue, getCreatedTask } = createQueue();

  queue.createTask({
    projectId: 'board',
    title: '修复 Bug',
    template: 'bugfix',
    variables: { description: '登录失败', location: 'AuthService' },
  });

  assert.equal(getCreatedTask().pipeline_mode, true);
});

test('简单任务未填标题时从描述自动生成', () => {
  const { queue, getCreatedTask } = createQueue();

  queue.createTask({
    projectId: 'board',
    template: 'general',
    variables: { description: '整理 README 文档结构' },
  });

  assert.equal(getCreatedTask().title, '通用任务 · 整理 README 文档结构');
});
