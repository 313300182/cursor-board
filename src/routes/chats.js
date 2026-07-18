const express = require('express');
const { asyncHandler } = require('../middleware/error');

function createChatsRouter(deps) {
  const { chatService } = deps;
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    const projectId = req.query.projectId;
    if (projectId === 'global') {
      res.json(chatService.listSessions(null));
      return;
    }
    res.json(chatService.listSessions(projectId !== undefined ? String(projectId) : undefined));
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const projectId = body.projectId;
    const session = chatService.createSession({
      projectId: projectId === null || projectId === 'global' ? null : projectId,
      title: body.title,
      modelId: body.modelId || undefined,
    });
    res.status(201).json(session);
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    res.json(chatService.getSessionDetail(req.params.id));
  }));

  router.get('/:id/messages', asyncHandler(async (req, res) => {
    res.json(chatService.listMessages(req.params.id));
  }));

  router.post('/:id/messages', asyncHandler(async (req, res) => {
    const session = chatService.startMessage(req.params.id, req.body || {});
    res.status(202).json(session);
  }));

  router.post('/:id/interaction', asyncHandler(async (req, res) => {
    const session = await chatService.submitInteraction(req.params.id, req.body || {});
    res.json(session);
  }));

  router.post('/:id/cancel', asyncHandler(async (req, res) => {
    const session = chatService.cancelTurn(req.params.id);
    res.json(session);
  }));

  return router;
}

module.exports = {
  createChatsRouter,
};
