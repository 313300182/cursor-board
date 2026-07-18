const assert = require('node:assert/strict');
const test = require('node:test');

const TaskQueue = require('../queue');

function createQueue() {
  let createdTask;
  const repo = {
    createTask(task) {
      createdTask = task;
      return task;
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
        workdir: process.cwd(),
      };
    },
  };
  const config = {
    security: { workdirAllowlist: [process.cwd()] },
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
