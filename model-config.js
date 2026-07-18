/**
 * Resolve task model settings from application configuration.
 * @author Amadeus
 */
function getModelSettings(config) {
  const models = config.cursor?.models || {};
  return {
    simpleDefault: models.simpleDefault,
    complexDefault: models.complexDefault,
    options: Array.isArray(models.options)
      ? models.options.map((option) => ({ id: option.id, name: option.name }))
      : [],
  };
}

function resolveTaskModel(config, isComplex, requestedModel) {
  const settings = getModelSettings(config);
  const modelId = requestedModel || (
    isComplex ? settings.complexDefault : settings.simpleDefault
  );
  if (!modelId || !settings.options.some((option) => option.id === modelId)) {
    throw new Error(`模型不可用: ${modelId || '(未配置)'}`);
  }
  return modelId;
}

module.exports = {
  getModelSettings,
  resolveTaskModel,
};
