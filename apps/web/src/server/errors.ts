/**
 * What an endpoint answers with when it will not, or cannot, do what was
 * asked. `code` is stable and meant for programs; `message` is for people and
 * never carries a secret.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Extra fields of the response body, such as which source was unavailable. */
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const unauthenticated = (message = 'sign in first') => new ApiError(401, 'unauthenticated', message);

/**
 * One answer for "there is no such thing" and "it is not yours": telling the
 * two apart would tell a stranger which organisations exist.
 */
export const notFound = () => new ApiError(404, 'not_found', 'not found');

export const invalid = (message: string, problems?: readonly string[]) =>
  new ApiError(400, 'invalid_input', message, problems === undefined ? {} : { problems: [...problems] });

export const badOrigin = () => new ApiError(403, 'bad_origin', 'this request did not come from the application itself');

/** Understood and well-formed, but not something that will be done as things stand. */
export const refused = (message: string, details: Record<string, unknown> = {}) => new ApiError(409, 'refused', message, details);

/**
 * A source could not be read, or what it returned is too old to use. Nothing
 * stands in for the missing value: the caller is told it is missing.
 */
export const unavailable = (source: string, reason: string) =>
  new ApiError(503, 'unavailable', `${source} is unavailable: ${reason}`, { source });

/** The deployment lacks a setting, or has one that cannot be used. The message names the variable and never its value. */
export class ConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, problem: string) {
    super(`${variable} ${problem}`);
    this.name = 'ConfigError';
    this.variable = variable;
  }
}
