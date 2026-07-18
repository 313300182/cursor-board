function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    return header.slice(7);
  }
  if (req.query && req.query.token) {
    return String(req.query.token);
  }
  return '';
}

function authMiddleware(auth) {
  const verifyToken =
    typeof auth?.verifyToken === 'function'
      ? (candidate) => auth.verifyToken(candidate)
      : (candidate) => candidate === auth;
  return (req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (
      req.path === '/api/health'
      || req.path === '/api/auth/status'
      || req.path === '/api/auth/login'
    ) {
      return next();
    }
    if (!verifyToken(extractToken(req))) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

module.exports = {
  extractToken,
  authMiddleware,
};
