const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CATEGORY_ORDER,
  loadTemplates,
  getTemplate,
  renderTemplate,
  sortTemplates,
  validateVariables,
  isPipelineTemplate,
  deriveTaskTitle,
} = require('../templates');

test('任务模板按分类与顺序返回完整列表', () => {
  const templates = loadTemplates();

  assert.ok(templates.length >= 9);
  assert.deepEqual(
    [...new Set(templates.map((item) => item.category))].slice(0, 3),
    CATEGORY_ORDER,
  );
  assert.ok(templates.some((item) => item.id === 'general'));
  assert.ok(templates.some((item) => item.id === 'optimize'));
  assert.ok(templates.some((item) => item.id === 'iteration'));
  assert.ok(templates.some((item) => item.id === 'code-review'));

  const devTemplates = templates.filter((item) => item.category === '开发');
  assert.equal(devTemplates[0].id, 'feature');
  assert.equal(devTemplates[1].id, 'iteration');
});

test('模板变量校验与 prompt 渲染', () => {
  const template = getTemplate('code-review');
  assert.ok(template);
  assert.deepEqual(
    validateVariables(template, { scope: 'src/main/java' }),
    [],
  );
  assert.deepEqual(
    validateVariables(template, { scope: '' }),
    ['scope'],
  );

  const prompt = renderTemplate(template, {
    workdir: 'D:\\code\\demo',
    scope: 'src/service',
    focus: '并发安全',
    context: '支付模块',
  });
  assert.match(prompt, /审查范围：src\/service/);
  assert.match(prompt, /关注重点：并发安全/);
});

test('sortTemplates 会按分类和 order 排序', () => {
  const sorted = sortTemplates([
    { id: 'general', name: '通用任务', category: '通用', order: 1 },
    { id: 'feature', name: '新功能开发', category: '开发', order: 1 },
    { id: 'iteration', name: '功能优化迭代', category: '开发', order: 2 },
    { id: 'bugfix', name: '修复 Bug', category: '开发', order: 3 },
    { id: 'optimize', name: '性能优化', category: '质量', order: 2 },
  ]);

  assert.deepEqual(sorted.map((item) => item.id), ['feature', 'iteration', 'bugfix', 'optimize', 'general']);
});

test('isPipelineTemplate 识别流水线模板', () => {
  assert.equal(isPipelineTemplate(getTemplate('feature')), true);
  assert.equal(isPipelineTemplate(getTemplate('bugfix')), true);
  assert.equal(isPipelineTemplate(getTemplate('general')), false);
});

test('deriveTaskTitle 优先使用用户标题，否则从描述总结', () => {
  const template = getTemplate('general');
  assert.equal(
    deriveTaskTitle(template, { description: '优化登录页样式' }, '自定义标题'),
    '自定义标题',
  );
  assert.equal(
    deriveTaskTitle(template, { description: '优化登录页样式' }, ''),
    '通用任务 · 优化登录页样式',
  );
  assert.match(
    deriveTaskTitle(template, { description: '第一行\n第二行补充' }, ''),
    /通用任务 · 第一行 · 第二行补充/,
  );
  assert.equal(
    deriveTaskTitle(template, { description: '' }, ''),
    '通用任务',
  );
});

test('deriveTaskTitle 会截断过长描述', () => {
  const template = getTemplate('general');
  const longText = '这是一段很长的任务描述'.repeat(10);
  const title = deriveTaskTitle(template, { description: longText }, '');
  assert.ok(title.length <= 120);
  assert.match(title, /…$/);
});

test('各模板主 textarea 字段应支持图片附件', () => {
  const primaryFields = {
    bugfix: 'description',
    feature: 'requirement',
    iteration: 'requirement',
    refactor: 'target',
    general: 'description',
    'local-doc': 'description',
    test: 'target',
    optimize: 'target',
    'code-review': 'scope',
  };

  for (const [id, fieldName] of Object.entries(primaryFields)) {
    const template = getTemplate(id);
    assert.ok(template, `模板 ${id} 应存在`);
    const field = (template.variables || []).find((item) => item.name === fieldName);
    assert.ok(field, `模板 ${id} 应包含字段 ${fieldName}`);
    assert.equal(field.images, true, `模板 ${id} 的 ${fieldName} 应启用 images`);
  }
});
