// Copyright 2026 Neural Inverse
// SPDX-License-Identifier: Apache-2.0

import { ConfigurationError, ConnectionError, EntitlementError, KillSwitchError, RegionError, SandscaleError, parseErrorBody } from './errors.js';
import { VERSION } from './version.js';

export const DEFAULT_BASE_URL = 'https://api.sandscale.dev';
/** Sandscale's regional APIs ; api.sandscale.dev routes to the request's region, default US. */
export const SANDSCALE_REGION_URLS: Readonly<Record<string, string>> = Object.freeze({
  us: 'https://api.us.sandscale.dev',
  eu: 'https://api.eu.sandscale.dev',
});
const FRONT_DOOR_HOST = 'api.sandscale.dev';

/** A Sandscale region's name: `us1` and `us` are the same region. */
function sandscaleRegion(region: string): string {
  return region.toLowerCase().replace(/\d+$/, '');
}
/** The public names of the Sandscale regions; any region id the server lists works too. */
export type Region = 'us' | 'eu' | (string & {});

export type TokenSource = string | (() => string | Promise<string>);

export interface ClientOptions {
  /** A Sandscale API key. Default: $SANDSCALE_API_KEY. Give this or `token`. */
  apiKey?: string;
  /** The person's own sign-in access token, or a function returning a current one. */
  token?: TokenSource;
  /** Default: $SANDSCALE_BASE_URL, else https://api.sandscale.dev. */
  baseUrl?: string;
  /** Organization id: sent as X-Org-ID and used by the workspace and build host routes. Default: $SANDSCALE_ORG_ID. */
  orgId?: string;
  /** Region of every call that does not name one ("us" | "eu"). Without it calls go to `baseUrl`. */
  region?: Region;
  /** Explicit API URL per region, instead of the server's public region list. */
  regionUrls?: Record<string, string>;
  /** Per-request timeout in milliseconds (default 60 000). */
  timeoutMs?: number;
  /** Retries of safe (GET) calls after a connection error, 429, 502, 503 or 504 (default 2). */
  maxRetries?: number;
  /** A fetch implementation (tests, proxies). Default: globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

/** Options every call accepts. */
export interface CallOptions {
  /** The region to send this call to; overrides the client's region. */
  region?: Region;
  /** Aborts the call. */
  signal?: AbortSignal;
}

export interface RequestSpec {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  body?: Uint8Array;
  contentType?: string;
  accept?: string;
  timeoutMs?: number;
  /** Return the response unread (streams); errors are still thrown. */
  raw?: boolean;
  region?: Region;
  signal?: AbortSignal;
}

interface RegionEntry {
  id: string;
  status: string;
  api_url: string;
}

function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = proc?.env?.[name];
  return value ? value : undefined;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Validates an API origin: https, or http only to loopback; no credentials, query or fragment. */
export function checkUrl(raw: string, source: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError(`${source} is not an absolute URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigurationError(`${source} must not carry credentials, a query or a fragment`);
  }
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname)))) {
    throw new ConfigurationError(`${source} must use https (http only to a loopback host)`);
  }
  return url.toString().replace(/\/+$/, '');
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const REGION_LIST_TTL_MS = 60_000;
const MAX_BACKOFF_MS = 8_000;
const MAX_RETRY_AFTER_MS = 60_000;

/** The HTTP transport every service shares: auth, regions, retries and error mapping. */
export class Transport {
  readonly baseUrl: string;
  readonly orgId?: string;
  readonly region?: Region;
  /** True when the base URL is Sandscale's front door, whose regions are fixed hosts. */
  private readonly sandscale: boolean;
  private readonly credential: TokenSource;
  private readonly regionUrls: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private regionList?: { at: number; entries: RegionEntry[] };
  /** Overridable for tests. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? (options.token === undefined ? env('SANDSCALE_API_KEY') : undefined);
    if (apiKey !== undefined && options.token !== undefined) {
      throw new ConfigurationError('give apiKey or token, not both');
    }
    const credential = apiKey ?? options.token;
    if (credential === undefined || (typeof credential === 'string' && !credential.trim())) {
      throw new ConfigurationError('no credential: pass apiKey or token, or set SANDSCALE_API_KEY');
    }
    this.credential = credential;
    this.baseUrl = checkUrl(options.baseUrl ?? env('SANDSCALE_BASE_URL') ?? DEFAULT_BASE_URL, 'baseUrl');
    this.sandscale = new URL(this.baseUrl).hostname === FRONT_DOOR_HOST;
    this.orgId = options.orgId ?? env('SANDSCALE_ORG_ID');
    this.region = options.region;
    this.regionUrls = {};
    for (const [name, url] of Object.entries(options.regionUrls ?? {})) {
      this.regionUrls[name] = checkUrl(url, `regionUrls.${name}`);
    }
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** The organization id, required by the routes that name it in their path. */
  requireOrg(): string {
    if (!this.orgId) throw new ConfigurationError('this call needs an organization: pass orgId or set SANDSCALE_ORG_ID');
    return this.orgId;
  }

  /** The region a call goes to: its own, else the client's (undefined: the base URL). */
  regionOf(region?: Region): Region | undefined {
    return region ?? this.region;
  }

  /**
   * The API origin of a region. Explicit `regionUrls` win. On Sandscale (the front door
   * api.sandscale.dev) a region is one of Sandscale's regional APIs, `us` and `eu` (
   * a region id such as `us1` names the same); no lookup is made. Against another base URL (a
   * self-hosted Keystone) the region is looked up in the server's public region list
   * (GET /api/v1/regions): an exact id, or the one live region whose id is the name followed by
   * digits.
   */
  async originFor(region?: Region): Promise<string> {
    if (region === undefined) return this.baseUrl;
    const explicit = this.regionUrls[region];
    if (explicit) return explicit;
    if (this.sandscale) {
      const url = SANDSCALE_REGION_URLS[sandscaleRegion(region)];
      if (!url) {
        throw new RegionError(0, 'region_unknown', `Sandscale has no region ${region}; use ${Object.keys(SANDSCALE_REGION_URLS).join(' or ')}`);
      }
      return url;
    }
    const entries = await this.regions();
    const exact = entries.filter((r) => r.id === region);
    const pattern = new RegExp(`^${region.replace(/[^a-z0-9-]/gi, '')}\\d+$`);
    const matches = exact.length > 0 ? exact : entries.filter((r) => pattern.test(r.id));
    if (matches.length === 0) throw new RegionError(0, 'region_unknown', `the server lists no region ${region}`);
    if (matches.length > 1) {
      throw new RegionError(0, 'region_ambiguous', `region ${region} matches ${matches.map((r) => r.id).join(', ')}; name one`);
    }
    const entry = matches[0];
    if (entry.status !== 'live' || !entry.api_url) {
      throw new RegionError(0, 'region_unavailable', `region ${entry.id} is not available now (${entry.status || 'no API URL'})`, {
        region: entry.id,
      });
    }
    return checkUrl(entry.api_url, `the API URL of region ${entry.id}`);
  }

  /**
   * The live regions, for calls that list every region. On Sandscale: the Sandscale regions the
   * front door's region list reports live (`us1` is `us`).
   */
  async liveRegions(): Promise<string[]> {
    const named = Object.keys(this.regionUrls);
    if (named.length > 0) return named;
    const live = (await this.regions()).filter((r) => r.status === 'live' && (this.sandscale || r.api_url)).map((r) => r.id);
    if (!this.sandscale) return live;
    return [...new Set(live.map(sandscaleRegion))].filter((name) => name in SANDSCALE_REGION_URLS);
  }

  private async regions(): Promise<RegionEntry[]> {
    if (this.regionList && Date.now() - this.regionList.at < REGION_LIST_TTL_MS) return this.regionList.entries;
    // The region list is public: no credential is sent.
    const response = await this.send('GET', `${this.baseUrl}/api/v1/regions`, { Accept: 'application/json' }, undefined);
    if (!response.ok) throw parseErrorBody(response.status, response.statusText, await response.text(), response.headers);
    const body = (await response.json()) as { regions?: RegionEntry[] };
    const entries = (body.regions ?? []).filter((r) => typeof r?.id === 'string');
    this.regionList = { at: Date.now(), entries };
    return entries;
  }

  private async authorization(): Promise<string> {
    const value = typeof this.credential === 'function' ? await this.credential() : this.credential;
    if (!value || !value.trim()) throw new ConfigurationError('the token function returned an empty token');
    return `Bearer ${value}`;
  }

  /** Sends one request and returns the parsed JSON (undefined for an empty body). */
  async request<T>(spec: RequestSpec): Promise<T> {
    const response = await this.fetchResponse(spec);
    if (spec.raw) return response as unknown as T;
    const text = await response.text();
    return (text.length === 0 ? undefined : JSON.parse(text)) as T;
  }

  /** Sends one request, retrying safe calls, and returns the successful response. */
  async fetchResponse(spec: RequestSpec): Promise<Response> {
    const origin = await this.originFor(this.regionOf(spec.region));
    let url = `${origin}${spec.path}`;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(spec.query ?? {})) if (v !== undefined) params.set(k, String(v));
    if ([...params].length > 0) url += `?${params.toString()}`;

    const headers: Record<string, string> = {
      Authorization: await this.authorization(),
      Accept: spec.accept ?? 'application/json',
      'User-Agent': `sandscale-sdk-typescript/${VERSION}`,
    };
    if (this.orgId) headers['X-Org-ID'] = this.orgId;
    let body: BodyInit | undefined;
    if (spec.body !== undefined) {
      headers['Content-Type'] = spec.contentType ?? 'application/octet-stream';
      body = spec.body as BodyInit;
    } else if (spec.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(spec.json);
    }

    const retries = SAFE_METHODS.has(spec.method) ? this.maxRetries : 0;
    for (let attempt = 0; ; attempt++) {
      let error: SandscaleError;
      try {
        const response = await this.send(spec.method, url, headers, body, spec.timeoutMs, spec.signal);
        if (response.ok) return response;
        error = parseErrorBody(response.status, response.statusText, await response.text(), response.headers);
        if (!RETRY_STATUSES.has(response.status) || !retryable(error)) throw error;
      } catch (e) {
        if (!(e instanceof ConnectionError)) throw e;
        error = e;
      }
      if (attempt >= retries || spec.signal?.aborted) throw error;
      const wait = 'retryAfterMs' in error && (error.retryAfterMs as number) > 0
        ? Math.min(error.retryAfterMs as number, MAX_RETRY_AFTER_MS)
        : Math.random() * Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
      await this.sleep(wait);
    }
  }

  private async send(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: BodyInit | undefined,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs ?? this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await this.fetchImpl(url, { method, headers, body, signal: combined, redirect: 'error' });
    } catch (e) {
      if (signal?.aborted) throw e;
      const reason = timeout.aborted ? 'timed out' : 'failed';
      throw new ConnectionError(`${method} ${new URL(url).pathname} ${reason}`, e);
    }
  }
}

/** A kill switch, an entitlement or a region refusal never changes by retrying. */
function retryable(error: SandscaleError): boolean {
  return !(error instanceof KillSwitchError || error instanceof EntitlementError || error instanceof RegionError);
}

export function enc(segment: string): string {
  if (!segment) throw new ConfigurationError('an id is empty');
  return encodeURIComponent(segment);
}
