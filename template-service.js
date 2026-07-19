const {
  loadTemplates,
  getTemplate,
  decorateTemplate,
} = require('./templates');

const GENERAL_TEMPLATE_ID = 'general';

/**
 * 统一的任务类型解析服务：合并全局模板（文件）与项目私有模板（DB），
 * 并按项目的 enabled_templates 过滤，强制并入通用任务。
 * @author Amadeus
 */
function createTemplateService({ projectTemplates } = {}) {
  function resolveTemplate(projectId, templateId) {
    if (!templateId) return null;
    const global = getTemplate(templateId);
    if (global) return global;
    if (projectId && projectTemplates) {
      const priv = projectTemplates.getForProject(projectId, templateId);
      if (priv) return decorateTemplate(priv, 'project');
    }
    return null;
  }

  function listEffectiveTemplates(project) {
    const proj = project && typeof project === 'object' ? project : null;
    const projectId = proj ? proj.id : project;
    const globals = loadTemplates();
    const enabled = proj ? proj.enabled_templates : null;

    let selectedGlobals;
    if (Array.isArray(enabled)) {
      const allow = new Set(enabled.map((id) => String(id)));
      allow.add(GENERAL_TEMPLATE_ID);
      selectedGlobals = globals.filter((tpl) => allow.has(tpl.id));
    } else {
      selectedGlobals = globals;
    }

    const privates = projectId && projectTemplates
      ? projectTemplates.list(projectId).map((tpl) => decorateTemplate(tpl, 'project'))
      : [];

    return [...selectedGlobals, ...privates];
  }

  return { resolveTemplate, listEffectiveTemplates };
}

module.exports = {
  createTemplateService,
  GENERAL_TEMPLATE_ID,
};
