// One error shape for the whole API: { error: { code, message } }.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` },
  });
}

// Registered last in Express. Anything thrown (or rejected) lands here.
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }

  // multer errors (file too large, unexpected field, …)
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: { code: 'FILE_TOO_LARGE', message: 'Upload exceeds the maximum allowed size.' },
    });
  }

  console.error('[unhandled error]', err);
  res.status(500).json({
    error: { code: 'INTERNAL', message: 'Something went wrong on the server. Check the server logs.' },
  });
}
