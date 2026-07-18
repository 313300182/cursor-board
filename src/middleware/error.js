class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function errorHandler(err, req, res, _next) {
  const status = err.status || 400;
  res.status(status).json({ error: String(err.message || err) });
}

module.exports = {
  HttpError,
  asyncHandler,
  errorHandler,
};
