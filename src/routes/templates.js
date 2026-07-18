const express = require('express');
const { loadTemplates } = require('../../templates');
const { asyncHandler } = require('../middleware/error');

function createTemplatesRouter() {
  const router = express.Router();

  router.get('/', asyncHandler(async (_req, res) => {
    res.json(loadTemplates());
  }));

  return router;
}

module.exports = {
  createTemplatesRouter,
};
