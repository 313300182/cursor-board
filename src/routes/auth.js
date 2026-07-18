const express = require('express');
const { extractToken } = require('../middleware/auth');

function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function sendAuthFailure(res, result) {
  if (result.locked) {
    const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: `登录尝试过多，请在 ${retryAfter} 秒后重试` });
  }
  if (result.invalid) {
    return res.status(400).json({ error: '新密码至少需要 6 位' });
  }
  return res.status(401).json({ error: '密码错误' });
}

function createAuthRouter(deps) {
  const { authService } = deps;
  const router = express.Router();

  router.get('/status', (req, res) => {
    res.json({ authenticated: authService.verifyToken(extractToken(req)) });
  });

  router.post('/login', (req, res) => {
    const result = authService.login(req.body?.password, clientKey(req));
    if (!result.ok) return sendAuthFailure(res, result);
    return res.json({ token: result.token });
  });

  router.put('/password', (req, res) => {
    const result = authService.changePassword(
      req.body?.currentPassword,
      req.body?.newPassword,
      clientKey(req),
    );
    if (!result.ok) return sendAuthFailure(res, result);
    return res.json({ token: result.token });
  });

  return router;
}

module.exports = {
  createAuthRouter,
};
