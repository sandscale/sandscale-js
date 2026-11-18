// Copyright 2026 Neural Inverse
// SPDX-License-Identifier: Apache-2.0

/**
 * Every error the SDK throws for an answer of the Sandscale API is a SandscaleError carrying
 * the server's own `code` and `message`. The subclasses only sort those answers so callers can
 * catch a family (limits, entitlement, region, kill switch); the server decides every refusal,
 * the SDK never refuses a call on its own.
 */
export class SandscaleError extends Error {
  /** HTTP status of the answer (0 when no answer was received). */
  readonly status: number;
  /** The server's error code, e.g. `quota_exceeded`, `kill_switch_engaged`. */
  readonly code: string;
  /** The server's request id, when it sent one; quote it when you contact support. */
  readonly requestId?: string;
  /** Structured details the server sent (`error.detail` or `error.details`). */
  readonly details?: unknown;
  /** The region the server names in the answer (`wrong_region` answers carry it). */
  readonly region?: string;

  constructor(status: number, code: string, message: string, extra: ErrorExtra = {}) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.requestId = extra.requestId;
    this.details = extra.details;
    this.region = extra.region;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ErrorExtra {
  requestId?: string;
  details?: unknown;
  region?: string;
  retryAfterMs?: number;
}

/** 400 or 422: the request was refused as invalid. */
export class InvalidRequestError extends SandscaleError {}
/** 401: the API key or token is missing, expired, revoked or of another region. */
export class AuthenticationError extends SandscaleError {}
/** 403: the caller may not do this (role, policy, host access rules). */
export class PermissionDeniedError extends SandscaleError {}
/** 404: not found, or not visible to the caller. */
export class NotFoundError extends SandscaleError {}
/** 409: the resource is not in a state that allows the call (paused, ended, busy). */
export class ConflictError extends SandscaleError {}
/** A plan, quota or usage limit refused the call (402, or a quota or limit code). */
export class LimitExceededError extends SandscaleError {
  /** How long the server asked to wait (Retry-After), in milliseconds; 0 when it did not say. */
  readonly retryAfterMs: number;
  constructor(status: number, code: string, message: string, extra: ErrorExtra = {}) {
    super(status, code, message, extra);
    this.retryAfterMs = extra.retryAfterMs ?? 0;
  }
}
/** 429: too many requests; retry after `retryAfterMs`. */
export class RateLimitError extends LimitExceededError {}
/** The organization's plan does not include this, or payment is required. */
export class EntitlementError extends SandscaleError {}
/** The call was sent to a region that cannot serve it (wrong region, region unavailable). */
export class RegionError extends SandscaleError {}
/** A kill switch (the organization's or Sandscale's) stopped the call. */
export class KillSwitchError extends SandscaleError {}
/** 5xx: the server could not answer the call. */
export class ServerError extends SandscaleError {
  /** How long the server asked to wait (Retry-After), in milliseconds; 0 when it did not say. */
  readonly retryAfterMs: number;
  constructor(status: number, code: string, message: string, extra: ErrorExtra = {}) {
    super(status, code, message, extra);
    this.retryAfterMs = extra.retryAfterMs ?? 0;
  }
  /** True when the same call may succeed a moment later (502, 503 and 504 answers). */
  get retryable(): boolean {
    return this.status === 502 || this.status === 503 || this.status === 504;
  }
}
/** 503: the service cannot answer now and says so; retry after `retryAfterMs`. */
export class ServiceUnavailableError extends ServerError {}
/** 503 `sandbox_waking`: the sandbox is resuming from a pause; retry the call after `retryAfterMs`. */
export class SandboxWakingError extends ServiceUnavailableError {}
/** No answer: the connection failed or the call timed out. */
export class ConnectionError extends SandscaleError {
  constructor(message: string, cause?: unknown) {
    super(0, 'connection_error', message);
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** Thrown before any call when the client cannot be configured safely. */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const ENTITLEMENT_CODES = new Set(['not_entitled', 'payment_required', 'service_not_entitled']);
/** 503 codes that are a moment's refusal (fail closed), never an entitlement answer. */
const UNAVAILABLE_CODES = new Set(['entitlement_unavailable']);

/** Sorts a server answer into its error class. Exported for tests and wrappers. */
export function errorFor(status: number, code: string, message: string, extra: ErrorExtra = {}): SandscaleError {
  if (/(^|_)kill_switch/.test(code)) return new KillSwitchError(status, code, message, extra);
  if (code === 'wrong_region' || code.startsWith('region_')) return new RegionError(status, code, message, extra);
  if (code === 'sandbox_waking') return new SandboxWakingError(status, code, message, extra);
  if (UNAVAILABLE_CODES.has(code)) return new ServiceUnavailableError(status, code, message, extra);
  if (ENTITLEMENT_CODES.has(code) || code.startsWith('entitlement_') || code.startsWith('plan_') || code.endsWith('_not_in_plan')) {
    return new EntitlementError(status, code, message, extra);
  }
  if (status === 429) return new RateLimitError(status, code, message, extra);
  if (status === 402 || /(^|_)quota(_|$)|(^|_)limit(_|$)|limit_exceeded$/.test(code)) {
    return new LimitExceededError(status, code, message, extra);
  }
  switch (status) {
    case 400:
    case 413:
    case 422:
      return new InvalidRequestError(status, code, message, extra);
    case 401:
      return new AuthenticationError(status, code, message, extra);
    case 403:
      return new PermissionDeniedError(status, code, message, extra);
    case 404:
      return new NotFoundError(status, code, message, extra);
    case 409:
      return new ConflictError(status, code, message, extra);
  }
  if (status === 503) return new ServiceUnavailableError(status, code, message, extra);
  if (status >= 500) return new ServerError(status, code, message, extra);
  return new SandscaleError(status, code, message, extra);
}

/**
 * Reads the server's error envelope. Keystone answers `{"error": {"code", "message",
 * "request_id", "detail" | "details"}}`; the bearer middleware's `wrong_region` answer also
 * carries `code` and `region` at the top level.
 */
export function parseErrorBody(status: number, statusText: string, text: string, headers: Headers): SandscaleError {
  let code = `http_${status}`;
  let message = statusText || `HTTP ${status}`;
  const extra: ErrorExtra = {};
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const err = (typeof body.error === 'object' && body.error !== null ? body.error : body) as Record<string, unknown>;
    if (typeof err.code === 'string') code = err.code;
    else if (typeof body.code === 'string') code = body.code;
    if (typeof err.message === 'string') message = err.message;
    if (typeof err.request_id === 'string') extra.requestId = err.request_id;
    if (err.detail !== undefined && err.detail !== null) extra.details = err.detail;
    if (err.details !== undefined && err.details !== null) extra.details = err.details;
    const region = err.region ?? body.region ?? body.home_region;
    if (typeof region === 'string') extra.region = region;
  } catch {
    // Not JSON: keep the status text.
  }
  extra.requestId ??= headers.get('X-Request-ID') ?? undefined;
  extra.retryAfterMs = retryAfterMs(headers.get('Retry-After'));
  return errorFor(status, code, message, extra);
}

/** Retry-After in milliseconds (seconds or an HTTP date); 0 when absent or unreadable. */
export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? 0 : Math.max(0, at - now);
}
