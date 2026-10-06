export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (message = 'The request was not valid.', code = 'invalid_request', extra?: Record<string, unknown>) => new AppError(400, code, message, extra);
export const unauthorized = (message = 'Please sign in to continue.', code = 'unauthenticated') => new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission to do that.', code = 'forbidden') => new AppError(403, code, message);
export const notFound = (message = 'That could not be found.', code = 'not_found') => new AppError(404, code, message);
export const conflict = (message = 'That conflicts with the current state.', code = 'conflict') => new AppError(409, code, message);
export const tooMany = (message = 'Too many requests. Please wait a moment and try again.', code = 'rate_limited') => new AppError(429, code, message);
export const stepUpRequired = () => new AppError(403, 'step_up_required', 'Please confirm your authenticator code to continue.');
