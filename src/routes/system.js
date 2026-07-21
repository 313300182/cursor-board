const express = require('express');
const { getModelSettings } = require('../../model-config');
const { getPlatformCompatibility } = require('../platform-compatibility');
const { asyncHandler } = require('../middleware/error');

function createSystemRouter(deps) {
  const { config, queue, root } = deps;
  const router = express.Router();

  router.get('/health', asyncHandler(async (_req, res) => {
    res.json({
      ok: true,
      runningTaskId: queue.currentTaskId,
      runningTaskIds: queue.runningTaskIds,
      queueBusy: queue.running,
      maxConcurrent: config.queue?.maxConcurrent || 3,
    });
  }));

  router.get('/bootstrap', asyncHandler(async (_req, res) => {
    res.json({
      workdirDefault: root,
      workdirAllowlist: config.security?.workdirAllowlist || [],
      models: getModelSettings(config),
      platform: getPlatformCompatibility(config),
    });
  }));

  return router;
}

module.exports = {
  createSystemRouter,
};
