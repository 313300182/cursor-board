const express = require('express');
const { extractToken } = require('../middleware/auth');

function createEventsRouter(deps) {
  const { token, authService, broadcaster } = deps;
  const verifyToken =
    typeof authService?.verifyToken === 'function'
      ? (candidate) => authService.verifyToken(candidate)
      : (candidate) => candidate === token;
  const router = express.Router();

  router.get('/events', (req, res) => {
    if (!verifyToken(extractToken(req))) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    broadcaster.add(res);

    const heartbeat = setInterval(() => {
      try {
        if (!res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`)) {
          clearInterval(heartbeat);
          broadcaster.remove(res);
          res.destroy();
        }
      } catch (_) {
        clearInterval(heartbeat);
        broadcaster.remove(res);
        res.destroy();
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      broadcaster.remove(res);
    });
  });

  return router;
}

module.exports = {
  createEventsRouter,
};
