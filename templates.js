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
      return JSON.parse(raw);
    });
  return sortTemplates(templates);
}

function getTemplate(id) {
  return loadTemplates().find((item) => item.id === id) || null;
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

const TITLE_MAX_LEN = 48;

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
  return '';
}

function deriveTaskTitle(template, variables, explicitTitle) {
  const trimmed = String(explicitTitle || '').trim();
  if (trimmed) return trimmed.slice(0, 120);

  const primary = normalizeTitleText(pickPrimaryVariable(template, variables));
  if (primary) {
    const summary = primary.length > TITLE_MAX_LEN
      ? `${primary.slice(0, TITLE_MAX_LEN)}…`
      : primary;
    const prefix = template?.name ? `${template.name} · ` : '';
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
  deriveTaskTitle,
};
