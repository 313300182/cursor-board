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
        // write() 返回 false 仅表示 TCP 背压，数据仍会发出，不能据此断开连接，
        // 否则会误杀正常但繁忙的 SSE 客户端。真正断开由下方 req 的 close 事件处理。
        res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
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
