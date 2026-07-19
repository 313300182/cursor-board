const fs = require('fs');
const path = require('path');

const TEMPLATE_DIR = path.join(__dirname, 'templates');
const CATEGORY_ORDER = ['开发', '质量', '通用'];

function sortTemplates(templates) {
  const categoryRank = new Map(CATEGORY_ORDER.map((name, index) => [name, index]));
  return [...templates].sort((left, right) => {
    const leftCategory = left.category || '其他';
    const rightCategory = right.category || '其他';
    const leftRank = categoryRank.has(leftCategory)
      ? categoryRank.get(leftCategory)
      : CATEGORY_ORDER.length;
    const rightRank = categoryRank.has(rightCategory)
      ? categoryRank.get(rightCategory)
      : CATEGORY_ORDER.length;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    const leftOrder = Number.isFinite(left.order) ? left.order : Number.MAX_SAFE_INTEGER;
    const rightOrder = Number.isFinite(right.order) ? right.order : Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return String(left.name || left.id).localeCompare(String(right.name || right.id), 'zh-CN');
  });
}

function loadTemplates() {
  if (!fs.existsSync(TEMPLATE_DIR)) {
    return [];
  }
  const templates = fs
    .readdirSync(TEMPLATE_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const raw = fs.readFileSync(path.join(TEMPLATE_DIR, name), 'utf8');
      return decorateTemplate(JSON.parse(raw), 'global');
    });
  return sortTemplates(templates);
}

function getTemplate(id) {
  return loadTemplates().find((item) => item.id === id) || null;
}

function formatWorkdirsDetail(workdirs) {
  const list = Array.isArray(workdirs) ? workdirs : [];
  if (!list.length) return '';
  if (list.length === 1) {
    const entry = list[0];
    const label = String(entry.label || '').trim();
    return label ? `${label}：${entry.path}` : String(entry.path || '');
  }
  return list.map((entry, index) => {
    const label = String(entry.label || '').trim() || `目录 ${index + 1}`;
    return `- ${label}：${entry.path}`;
  }).join('\n');
}

function buildWorkdirTemplateContext(workdirs) {
  const list = Array.isArray(workdirs) ? workdirs : [];
  const primary = list[0]?.path || '';
  return {
    workdir: primary,
    workdirs: list.map((entry) => entry.path).join('\n'),
    workdirs_detail: formatWorkdirsDetail(list),
  };
}

function renderTemplate(template, context) {
  let prompt = template.prompt;
  for (const [key, value] of Object.entries(context)) {
    prompt = prompt.split(`{{${key}}}`).join(String(value ?? ''));
  }
  return prompt;
}

function validateVariables(template, variables) {
  const missing = (template.variables || [])
    .filter((item) => item.required)
    .filter((item) => !variables[item.name] || String(variables[item.name]).trim() === '')
    .map((item) => item.name);
  return missing;
}

function isPipelineTemplate(template) {
  return Boolean(template?.pipeline || template?.category === '开发');
}

function normalizeTemplateDefaults(template) {
  const defaults = template && typeof template.defaults === 'object' && template.defaults
    ? template.defaults
    : {};
  const pipeline = typeof defaults.pipeline === 'boolean'
    ? defaults.pipeline
    : isPipelineTemplate(template);
  const git = typeof defaults.git === 'boolean' ? defaults.git : true;
  const complex = typeof defaults.complex === 'boolean' ? defaults.complex : false;
  return { pipeline, git, complex };
}

function decorateTemplate(template, scope = 'global') {
  if (!template || typeof template !== 'object') return template;
  return {
    ...template,
    scope: template.scope || scope,
    defaults: normalizeTemplateDefaults(template),
  };
}

const TITLE_MAX_LEN = 48;
const PROVISIONAL_TITLE_MAX_LEN = 28;

function firstMeaningfulLine(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)[0] || '';
}

function normalizeTitleText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' · ');
}

function pickPrimaryVariable(template, variables) {
  const fields = template?.variables || [];
  const requiredText = fields.find(
    (item) => item.required && item.input !== 'input',
  );
  if (requiredText) {
    const value = String(variables[requiredText.name] || '').trim();
    if (value) return value;
  }
  for (const item of fields) {
    const value = String(variables[item.name] || '').trim();
    if (value) return value;
  }
  return String(variables?.__requirement || '').trim();
}

function deriveTaskTitle(template, variables, explicitTitle) {
  const trimmed = String(explicitTitle || '').trim();
  if (trimmed) return trimmed.slice(0, 120);

  const firstLine = firstMeaningfulLine(pickPrimaryVariable(template, variables));
  if (firstLine) {
    const prefix = template?.name ? `${template.name} · ` : '';
    if (firstLine.length > PROVISIONAL_TITLE_MAX_LEN) {
      return `${prefix}待总结`.slice(0, 120);
    }
    const summary = firstLine.length > TITLE_MAX_LEN
      ? `${firstLine.slice(0, TITLE_MAX_LEN)}…`
      : firstLine;
    return `${prefix}${summary}`.slice(0, 120);
  }

  return template?.name || '未命名任务';
}

module.exports = {
  CATEGORY_ORDER,
  loadTemplates,
  getTemplate,
  renderTemplate,
  sortTemplates,
  validateVariables,
  isPipelineTemplate,
  normalizeTemplateDefaults,
  decorateTemplate,
  deriveTaskTitle,
  formatWorkdirsDetail,
  buildWorkdirTemplateContext,
};
