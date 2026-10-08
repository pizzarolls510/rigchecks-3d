// One JSON error shape for every response: { error: { code, message } }.

export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class UpstreamError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

export function sendError(res, status, code, message, details = undefined) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return res.status(status).json({ error });
}

export function errorHandler(logger = console) {
  // Express recognizes error handlers by arity, so `next` must stay in the signature.
  // eslint-disable-next-line no-unused-vars
  return (error, req, res, next) => {
    if (error instanceof ApiError) {
      if (error.status === 429 && error.details?.retryAfterSeconds) res.set('Retry-After', String(error.details.retryAfterSeconds));
      return sendError(res, error.status, error.code, error.message, error.details);
    }
    // express.json() rejections: malformed JSON or an oversized body.
    if (error?.type === 'entity.parse.failed' || error?.type === 'entity.verify.failed' || error?.type === 'encoding.unsupported') {
      return sendError(res, 400, 'invalid_request', 'The request body must be valid JSON.');
    }
    if (error?.type === 'entity.too.large') {
      return sendError(res, 413, 'invalid_request', 'The request body is too large.');
    }
    if (error instanceof UpstreamError) {
      logger.error('Asset Library upstream error', { status: error.status, message: error.message });
      return sendError(res, 502, 'upstream_error', 'The authoritative repository could not be reached. Try again shortly.');
    }
    logger.error('Asset Library internal error', error);
    return sendError(res, 500, 'internal', 'The Asset Library API hit an unexpected error.');
  };
}
