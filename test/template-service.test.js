const assert = require('node:assert/strict');
const test = require('node:test');

const { createTemplateService } = require('../template-service');
const { normalizeTemplateDefaults, loadTemplates } = require('../templates');

function stubProjectTemplates(entries) {
  return {
    list(projectId) {
      return entries.filter((item) => item.project_id === projectId);
    },
    getForProject(projectId, id) {
      return entries.find((item) => item.project_id === projectId && item.id === id) || null;
    },
  };
}

test('normalizeTemplateDefaults 回退到隐式流水线判断', () => {
  assert.deepEqual(
    normalizeTemplateDefaults({ category: '开发' }),
    { pipeline: true, git: true, complex: false },
  );
  assert.deepEqual(
    normalizeTemplateDefaults({ category: '通用' }),
    { pipeline: false, git: true, complex: false },
  );
  assert.deepEqual(
    normalizeTemplateDefaults({ defaults: { pipeline: false, git: false, complex: true } }),
    { pipeline: false, git: false, complex: true },
  );
});

test('全局模板加载时附带规范化 defaults 与 scope', () => {
  const templates = loadTemplates();
  const feature = templates.find((item) => item.id === 'feature');
  const general = templates.find((item) => item.id === 'general');
  assert.equal(feature.scope, 'global');
  assert.equal(feature.defaults.pipeline, true);
  assert.equal(general.defaults.pipeline, false);
  assert.equal(general.defaults.git, false);
});

test('listEffectiveTemplates 默认返回全部全局模板并合并私有', () => {
  const projectTemplates = stubProjectTemplates([
    { id: 'pt1', project_id: 'p1', name: '金融分析', prompt: '{{data}}', variables: [], defaults: { pipeline: false, git: false } },
  ]);
  const service = createTemplateService({ projectTemplates });
  const globals = loadTemplates();
  const result = service.listEffectiveTemplates({ id: 'p1', enabled_templates: null });
  assert.equal(result.length, globals.length + 1);
  const priv = result.find((item) => item.id === 'pt1');
  assert.equal(priv.scope, 'project');
});

test('listEffectiveTemplates 按 enabled 子集过滤并强制并入 general', () => {
  const projectTemplates = stubProjectTemplates([]);
  const service = createTemplateService({ projectTemplates });
  const result = service.listEffectiveTemplates({ id: 'p1', enabled_templates: ['feature'] });
  const ids = result.map((item) => item.id).sort();
  assert.deepEqual(ids, ['feature', 'general']);
});

test('resolveTemplate 命中全局与项目私有', () => {
  const projectTemplates = stubProjectTemplates([
    { id: 'pt1', project_id: 'p1', name: '金融分析', prompt: '{{data}}', variables: [{ name: 'data', required: true }], defaults: { pipeline: true } },
  ]);
  const service = createTemplateService({ projectTemplates });

  const global = service.resolveTemplate('p1', 'feature');
  assert.equal(global.scope, 'global');
  assert.equal(global.defaults.pipeline, true);

  const priv = service.resolveTemplate('p1', 'pt1');
  assert.equal(priv.scope, 'project');
  assert.equal(priv.defaults.pipeline, true);
  assert.equal(priv.defaults.git, true);

  assert.equal(service.resolveTemplate('p1', 'not-exist'), null);
  assert.equal(service.resolveTemplate('other', 'pt1'), null);
});
