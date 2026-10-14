// One error shape for the whole API: { error: { code, message, requestId? } }.
// `requestId` is the id app.js stamped on the request (also returned in the
// X-Request-Id response header) so a user-visible failure can be matched to a
// server log line. It is optional and omitted when a request carries no id.

/**
 * An expected, client-facing failure: an HTTP status, a stable error code, and
 * a message that is safe to show. Routes throw these instead of hand-building
 * response bodies, so every error keeps the same shape.
 */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Build the envelope, including the request id only when we have one. */
function errorBody(req, code, message) {
  return { error: { code, message, ...(req?.id ? { requestId: req.id } : {}) } };
}

export function notFoundHandler(req, res) {
  res.status(404).json(errorBody(req, 'NOT_FOUND', `No route for ${req.method} ${req.path}`));
}

// Registered last in Express. Anything thrown (or rejected) lands here.
// Contract: the client never sees a stack trace, a file path, a query, or a
// secret — unexpected failures are logged server-side and answered with a
// generic message that points at the logs.
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof ApiError) {
    return res.status(err.status).json(errorBody(req, err.code, err.message));
  }

  // multer errors (file too large, unexpected field, …)
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json(errorBody(req, 'FILE_TOO_LARGE', 'Upload exceeds the maximum allowed size.'));
  }

  // Full detail (stack included) stays on the server, keyed by request id.
  console.error(`[unhandled error]${req?.id ? ` (request ${req.id})` : ''}`, err);
  res.status(500).json(errorBody(req, 'INTERNAL', 'Something went wrong on the server. Check the server logs.'));
}
