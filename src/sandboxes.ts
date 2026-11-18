// Copyright 2026 Neural Inverse
// SPDX-License-Identifier: Apache-2.0

import { SandboxWakingError, SandscaleError, ServerError } from './errors.js';
import { enc, type CallOptions, type Region, type Transport } from './http.js';
import type { CreatePreviewLinkOptions, ExposePortOptions, PortExposure, PreviewLink, SandboxSshCertificate, SandboxSshInfo } from './models.js';
import type {
  CreateSandboxOptions,
  FileEntry,
  ListResult,
  ListSandboxesOptions,
  OutputChunk,
  RegionPage,
  RunOptions,
  RunResult,
  Sandbox,
  Snapshot,
} from './types.js';

// The server waits for the command up to its timeout plus a 30 s worker margin.
const EXEC_MARGIN_SECONDS = 30;
// keepAwake retries a sandbox that is still waking this often, waiting at most this long each time.
const WAKING_RETRIES = 3;
const WAKING_MAX_WAIT_MS = 10_000;

type Raw = Record<string, unknown>;

export class Sandboxes {
  constructor(private readonly t: Transport) {}

  /** Starts a sandbox. Limits, entitlement and policy are decided by the server. */
  async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    const body: Raw = {};
    const set = (key: string, value: unknown) => {
      if (value !== undefined) body[key] = value;
    };
    set('template_id', options.template);
    set('snapshot_id', options.snapshotId);
    set('cpu_count', options.cpuCount);
    set('mem_mb', options.memoryMb);
    set('disk_mb', options.diskMb);
    set('ttl_seconds', options.timeoutSeconds);
    set('network', options.network);
    set('image', options.image);
    set('runtime', options.runtime);
    set('environment_id', options.environmentId);
    set('env', options.env);
    set('vault_env', options.vaultEnv);
    set('command', options.command);
    set('name', options.name);
    set('labels', options.labels);
    set('metadata', options.metadata);
    const raw = await this.t.request<Raw>({ method: 'POST', path: '/api/v1/sandbox/instances', json: body, ...opts(options) });
    return toSandbox(raw, this.t.regionOf(options.region));
  }

  async get(id: string, options: CallOptions = {}): Promise<Sandbox> {
    const raw = await this.t.request<Raw>({ method: 'GET', path: `/api/v1/sandbox/instances/${enc(id)}`, ...opts(options) });
    return toSandbox(raw, this.t.regionOf(options.region));
  }

  /** Lists sandboxes: of one region when one is named, else of every live region. */
  async list(options: ListSandboxesOptions = {}): Promise<ListResult<Sandbox>> {
    return listAcrossRegions(this.t, options.region, async (region) => {
      const raw = await this.t.request<{ data?: Raw[]; next_cursor?: string | null; has_more?: boolean }>({
        method: 'GET',
        path: '/api/v1/sandbox/instances',
        query: { status: options.status, project_id: options.projectId, limit: options.limit, cursor: options.cursor },
        region,
        signal: options.signal,
      });
      return {
        data: (raw.data ?? []).map((s) => toSandbox(s, region)),
        page: { region, nextCursor: raw.next_cursor ?? undefined, hasMore: raw.has_more ?? false },
      };
    });
  }

  /** Stops the sandbox and releases it. */
  async stop(id: string, options: CallOptions = {}): Promise<void> {
    await this.t.request({ method: 'DELETE', path: `/api/v1/sandbox/instances/${enc(id)}`, ...opts(options) });
  }

  /** Pauses a microVM sandbox (409 pause_unsupported for a container sandbox). */
  async pause(id: string, options: CallOptions = {}): Promise<{ id: string; status: string }> {
    return this.t.request({ method: 'POST', path: `/api/v1/sandbox/instances/${enc(id)}/pause`, ...opts(options) });
  }

  async resume(id: string, options: CallOptions = {}): Promise<{ id: string; status: string }> {
    return this.t.request({ method: 'POST', path: `/api/v1/sandbox/instances/${enc(id)}/resume`, ...opts(options) });
  }

  /**
   * Keeps the sandbox from hibernating between tool calls for `ttlSeconds` (0 clears it; at most
   * 86400), with a reason people can read back. A sandbox that is idle between two calls is
   * hibernated (its memory is compressed in RAM) and woken by the next call; use this for a box
   * that must stay awake, such as one that waits on a slow external reply.
   */
  async keepAwake(
    id: string,
    ttlSeconds: number,
    options: CallOptions & { reason?: string } = {},
  ): Promise<{ id: string; keep_awake: boolean; until?: string; reason?: string; ttl_seconds: number }> {
    // Setting a keep-awake time is idempotent, so a 503 `sandbox_waking` (the sandbox is resuming)
    // is retried a few times after the server's Retry-After before it is raised.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.t.request({
          method: 'POST',
          path: `/api/v1/sandbox/instances/${enc(id)}/keep-awake`,
          json: { ttl_seconds: ttlSeconds, reason: options.reason },
          ...opts(options),
        });
      } catch (e) {
        if (!(e instanceof SandboxWakingError) || attempt >= WAKING_RETRIES || options.signal?.aborted) throw e;
        await this.t.sleep(e.retryAfterMs > 0 ? Math.min(e.retryAfterMs, WAKING_MAX_WAIT_MS) : 500 * 2 ** attempt);
      }
    }
  }

  /**
   * Optional hint that a call to the sandbox is about to start (for example once a model has
   * answered and before the tool call runs): a hibernated sandbox starts waking early. It is
   * fire-and-forget: it never throws (a `SandboxWakingError` included: the wake is already under
   * way), never waits for the wake, and skipping it changes nothing but the latency of the next call.
   */
  prepare(id: string, options: CallOptions = {}): void {
    void this.t
      .request({ method: 'POST', path: `/api/v1/sandbox/instances/${enc(id)}/prepare`, ...opts(options) })
      .catch(() => undefined);
  }

  /** Snapshots the sandbox's /workspace. Start a new sandbox from it with `create({snapshotId})`. */
  async snapshot(id: string, options: CallOptions & { label?: string } = {}): Promise<Snapshot> {
    const json = options.label !== undefined ? { label: options.label } : undefined;
    const raw = await this.t.request<Raw>({ method: 'POST', path: `/api/v1/sandbox/instances/${enc(id)}/snapshot`, json, ...opts(options) });
    return toSnapshot(raw, this.t.regionOf(options.region));
  }

  /** The snapshots of one sandbox. */
  async listSnapshots(id: string, options: CallOptions = {}): Promise<Snapshot[]> {
    // The server answers {"snapshots": [...]}.
    const raw = await this.t.request<{ snapshots?: Raw[] }>({ method: 'GET', path: `/api/v1/sandbox/instances/${enc(id)}/snapshots`, ...opts(options) });
    return (raw.snapshots ?? []).map((s) => toSnapshot(s, this.t.regionOf(options.region)));
  }

  /**
   * Runs a command and returns its exit code and output. With `onStdout` or `onStderr` the
   * command is started without waiting (`wait: false`): the server answers with its run id at
   * once and the output is delivered live from that run's log stream, the exit code from the
   * stream's end. A server that answers with the finished result instead (a server before
   * `wait`, or a sandbox without live output) gets the callbacks the final output once
   * (`streamed: false`).
   */
  async run(id: string, command: string[] | string, options: RunOptions = {}): Promise<RunResult> {
    const argv = typeof command === 'string' ? ['sh', '-c', command] : command;
    const timeoutSeconds = options.timeoutSeconds ?? 60;
    const body: Raw = { command: argv, timeout_sec: timeoutSeconds };
    if (options.env !== undefined) body.env = options.env;
    if (options.workdir !== undefined) body.workdir = options.workdir;
    if (options.stdin !== undefined) body.stdin = toBase64(options.stdin);
    const live = options.onStdout !== undefined || options.onStderr !== undefined;
    if (live) body.wait = false;
    const raw = await this.t.request<Raw>({
      method: 'POST',
      path: `/api/v1/sandbox/instances/${enc(id)}/exec`,
      json: body,
      timeoutMs: (timeoutSeconds + EXEC_MARGIN_SECONDS) * 1000,
      ...opts(options),
    });
    if (!live || 'exit_code' in raw) {
      const result = toRunResult(raw, String(raw.stdout ?? ''), String(raw.stderr ?? ''), false);
      if (live) {
        if (result.stdout) options.onStdout?.(result.stdout);
        if (result.stderr) options.onStderr?.(result.stderr);
      }
      return result;
    }
    // 202: the run is queued; its output and end come from its log stream.
    const runId = String(raw.run_id ?? '');
    const out = { stdout: '', stderr: '' };
    let end: RunEnd | undefined;
    for await (const chunk of this.logs(id, runId, { ...opts(options), onDone: (d) => (end = d) })) {
      out[chunk.stream] += chunk.data;
      (chunk.stream === 'stderr' ? options.onStderr : options.onStdout)?.(chunk.data);
    }
    let final: Raw = end?.raw ?? {};
    if (end?.exitCode === undefined) {
      // A server whose stream end carries no result: read the run.
      final = await this.t.request<Raw>({ method: 'GET', path: `/api/v1/sandbox/runs/${enc(runId)}`, ...opts(options) });
    }
    return toRunResult({ ...final, run_id: runId }, out.stdout, out.stderr, true);
  }

  /** Streams a run's output (Server-Sent Events), resuming after a dropped connection. */
  async *logs(
    id: string,
    runId: string,
    options: CallOptions & { fromChunk?: number; onDone?: (end: RunEnd) => void } = {},
  ): AsyncGenerator<OutputChunk> {
    let next = options.fromChunk;
    let reconnects = 0;
    for (;;) {
      const response = await this.t.request<Response>({
        method: 'GET',
        path: `/api/v1/sandbox/instances/${enc(id)}/logs`,
        query: { run_id: runId, from_chunk: next },
        accept: 'text/event-stream',
        raw: true,
        timeoutMs: 24 * 3600 * 1000,
        region: options.region,
        signal: options.signal,
      });
      let done = false;
      try {
        for await (const event of readEvents(response)) {
          const data = parseJSON(event.data);
          if (event.event === 'done') {
            done = true;
            options.onDone?.(toRunEnd(runId, data ?? {}));
            break;
          }
          if (event.event === 'error') {
            // The server withheld the rest (its DLP scan failed): never a silently cut output.
            throw new ServerError(503, String(data?.code ?? 'stream_error'), String(data?.message ?? 'the output stream ended with an error'));
          }
          if (event.event === 'chunk' && data && typeof data.data === 'string') {
            const chunkIndex = Number(data.chunk_index ?? 0);
            next = chunkIndex + 1;
            yield { stream: data.stream === 'stderr' ? 'stderr' : 'stdout', data: data.data, chunkIndex };
          }
        }
      } catch (e) {
        if (e instanceof SandscaleError || options.signal?.aborted || reconnects >= 3) throw e;
      }
      if (done || options.signal?.aborted) return;
      reconnects++;
    }
  }

  /** Writes a file into the sandbox (at most what the server accepts per request). */
  async writeFile(id: string, path: string, data: Uint8Array | string, options: CallOptions & { mode?: string } = {}): Promise<void> {
    const json: Raw = { path, content: toBase64(data) };
    if (options.mode) json.mode = options.mode;
    await this.t.request({ method: 'PUT', path: `/api/v1/sandbox/instances/${enc(id)}/files`, json, ...opts(options) });
  }

  /** Reads a file from the sandbox. */
  async readFile(id: string, path: string, options: CallOptions = {}): Promise<Uint8Array> {
    const raw = await this.files(id, path, options);
    if (raw.type !== 'file') throw new SandscaleError(400, 'not_a_file', `${path} is not a regular file`);
    return fromBase64(String(raw.content ?? ''));
  }

  async listFiles(id: string, path: string, options: CallOptions = {}): Promise<FileEntry[]> {
    const raw = await this.files(id, path, options);
    if (raw.type !== 'dir') throw new SandscaleError(400, 'not_a_directory', `${path} is not a directory`);
    const dir = path.endsWith('/') ? path : `${path}/`;
    return ((raw.entries as Raw[] | undefined) ?? []).map((e) => ({
      name: String(e.name),
      path: `${dir}${String(e.name)}`,
      isDir: e.type === 'dir',
      size: typeof e.size_bytes === 'number' ? e.size_bytes : undefined,
    }));
  }

  /**
   * Opens a TCP port of the running sandbox to you alone, through Keystone, within the
   * organization's port policy. Nothing is exposed to the internet: connect through the
   * exposure's `connectPath` (WebSocket) or share it with `createPreviewLink`. Calling it again
   * for a port you already exposed returns that exposure.
   */
  async exposePort(id: string, port: number, options: ExposePortOptions = {}): Promise<PortExposure> {
    const json: Raw = { port };
    if (options.ttlSeconds !== undefined) json.ttl_seconds = options.ttlSeconds;
    const raw = await this.t.request<Raw>({ method: 'POST', path: `/api/v1/sandbox/instances/${enc(id)}/ports`, json, ...opts(options) });
    return toPortExposure(raw, this.t.regionOf(options.region));
  }

  /** The sandbox's open port exposures. */
  async listPorts(id: string, options: CallOptions = {}): Promise<PortExposure[]> {
    const raw = await this.t.request<{ ports?: Raw[] }>({ method: 'GET', path: `/api/v1/sandbox/instances/${enc(id)}/ports`, ...opts(options) });
    return (raw.ports ?? []).map((p) => toPortExposure(p, this.t.regionOf(options.region)));
  }

  /** Closes an exposure, by its id or its port number. */
  async closePort(id: string, port: string | number, options: CallOptions = {}): Promise<void> {
    await this.t.request({ method: 'DELETE', path: `/api/v1/sandbox/instances/${enc(id)}/ports/${enc(String(port))}`, ...opts(options) });
  }

  /** Shares your exposure of `port` (its id or port number) as a URL on the preview domain. */
  async createPreviewLink(id: string, port: string | number, options: CreatePreviewLinkOptions): Promise<PreviewLink> {
    const json: Raw = { visibility: options.visibility };
    if (options.ttlSeconds !== undefined) json.ttl_seconds = options.ttlSeconds;
    const raw = await this.t.request<Raw>({
      method: 'POST',
      path: `/api/v1/sandbox/instances/${enc(id)}/ports/${enc(String(port))}/preview-links`,
      json,
      ...opts(options),
    });
    return toPreviewLink(raw, this.t.regionOf(options.region));
  }

  /** The sandbox's live preview links. */
  async listPreviewLinks(id: string, options: CallOptions = {}): Promise<PreviewLink[]> {
    const raw = await this.t.request<{ preview_links?: Raw[] }>({ method: 'GET', path: `/api/v1/sandbox/instances/${enc(id)}/preview-links`, ...opts(options) });
    return (raw.preview_links ?? []).map((l) => toPreviewLink(l, this.t.regionOf(options.region)));
  }

  /** Revokes a preview link; its sessions end with it. */
  async revokePreviewLink(id: string, linkId: string, options: CallOptions = {}): Promise<void> {
    await this.t.request({ method: 'DELETE', path: `/api/v1/sandbox/instances/${enc(id)}/preview-links/${enc(linkId)}`, ...opts(options) });
  }

  /** The host key to trust, the user, and the route to connect through (WebSocket `keystone-ssh.v1`). */
  async sshInfo(id: string, options: CallOptions = {}): Promise<SandboxSshInfo> {
    const raw = await this.t.request<Raw>({ method: 'GET', path: `/api/v1/sandbox/instances/${enc(id)}/ssh`, ...opts(options) });
    return toSshInfo(raw, this.t.regionOf(options.region));
  }

  /** Signs your public key (ed25519 or ECDSA P-256) for this sandbox only, for a few minutes. */
  async sshCertificate(id: string, publicKey: string, options: CallOptions = {}): Promise<SandboxSshCertificate> {
    const raw = await this.t.request<Raw>({
      method: 'POST',
      path: `/api/v1/sandbox/instances/${enc(id)}/ssh/certificate`,
      json: { public_key: publicKey },
      ...opts(options),
    });
    return {
      ...toSshInfo(raw, this.t.regionOf(options.region)),
      certificate: String(raw.certificate ?? ''),
      serial: String(raw.serial ?? ''),
      keyId: String(raw.key_id ?? ''),
      validBefore: date(raw.valid_before),
    };
  }

  private files(id: string, path: string, options: CallOptions): Promise<Raw> {
    return this.t.request<Raw>({ method: 'GET', path: `/api/v1/sandbox/instances/${enc(id)}/files`, query: { path }, ...opts(options) });
  }
}

/** Runs one list call per region (or the named one) and merges the pages. */
export async function listAcrossRegions<T>(
  t: Transport,
  named: Region | undefined,
  one: (region: Region | undefined) => Promise<{ data: T[]; page: RegionPage }>,
): Promise<ListResult<T>> {
  const region = t.regionOf(named);
  if (region !== undefined) {
    const { data, page } = await one(region);
    return { data, pages: [page] };
  }
  let regions: (Region | undefined)[];
  try {
    regions = await t.liveRegions();
  } catch {
    regions = [];
  }
  if (regions.length === 0) regions = [undefined]; // a single-region installation
  const results = await Promise.allSettled(regions.map((r) => one(r)));
  const out: ListResult<T> = { data: [], pages: [] };
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      out.data.push(...r.value.data);
      out.pages.push(r.value.page);
    } else {
      const error = r.reason instanceof SandscaleError ? r.reason : new SandscaleError(0, 'unknown_error', String(r.reason));
      out.pages.push({ region: regions[i], hasMore: false, error });
    }
  });
  if (out.pages.every((p) => p.error)) throw out.pages[0].error;
  return out;
}

export function opts(o: CallOptions): { region?: Region; signal?: AbortSignal } {
  return { region: o.region, signal: o.signal };
}

export function date(v: unknown): Date | undefined {
  return typeof v === 'string' && v ? new Date(v) : undefined;
}

function toSandbox(raw: Raw, region: Region | undefined): Sandbox {
  const suspend = raw.suspend as Raw | undefined;
  return {
    id: String(raw.id),
    status: String(raw.status ?? ''),
    name: raw.name as string | undefined,
    templateId: (raw.template_id as string) || undefined,
    cpuCount: raw.cpu_count as number | undefined,
    memoryMb: raw.mem_mb as number | undefined,
    timeoutSeconds: raw.ttl_seconds as number | undefined,
    labels: raw.labels as Record<string, string> | undefined,
    statusReason: raw.status_reason as string | undefined,
    createdAt: date(raw.created_at),
    startedAt: date(raw.started_at),
    terminatedAt: date(raw.terminated_at),
    suspend: suspend
      ? { canPause: suspend.can_pause === true, canResume: suspend.can_resume === true, reason: suspend.reason as string | undefined }
      : undefined,
    region,
    raw,
  };
}

function toPortExposure(raw: Raw, region: Region | undefined): PortExposure {
  return {
    id: String(raw.id ?? ''),
    instanceId: String(raw.instance_id ?? ''),
    port: Number(raw.port ?? 0),
    protocol: String(raw.protocol ?? 'tcp'),
    status: String(raw.status ?? ''),
    createdBy: String(raw.created_by ?? ''),
    createdAt: date(raw.created_at),
    expiresAt: date(raw.expires_at),
    closedAt: date(raw.closed_at),
    closeReason: (raw.close_reason as string) || undefined,
    connectPath: String(raw.connect_path ?? ''),
    subprotocol: String(raw.subprotocol ?? ''),
    region,
    raw,
  };
}

function toPreviewLink(raw: Raw, region: Region | undefined): PreviewLink {
  return {
    id: String(raw.id ?? ''),
    instanceId: String(raw.instance_id ?? ''),
    exposureId: String(raw.exposure_id ?? ''),
    port: Number(raw.port ?? 0),
    visibility: String(raw.visibility ?? ''),
    url: String(raw.url ?? ''),
    status: String(raw.status ?? ''),
    createdBy: String(raw.created_by ?? ''),
    createdAt: date(raw.created_at),
    expiresAt: date(raw.expires_at),
    revokedAt: date(raw.revoked_at),
    revokeReason: (raw.revoke_reason as string) || undefined,
    abuseRule: (raw.abuse_rule as string) || undefined,
    region,
    raw,
  };
}

function toSshInfo(raw: Raw, region: Region | undefined): SandboxSshInfo {
  return {
    host: String(raw.host ?? ''),
    user: String(raw.user ?? ''),
    knownHosts: String(raw.known_hosts ?? ''),
    hostKeySha256: String(raw.host_key_sha256 ?? ''),
    certificatePath: String(raw.certificate_path ?? ''),
    connectPath: String(raw.connect_path ?? ''),
    subprotocol: String(raw.subprotocol ?? ''),
    certTtlSeconds: Number(raw.cert_ttl_seconds ?? 0),
    region,
    raw,
  };
}

/** How a run ended, as its log stream's done event says (`exitCode` once it ended). */
export interface RunEnd {
  runId: string;
  status?: string;
  exitCode?: number;
  oomKilled: boolean;
  timedOut: boolean;
  raw: Raw;
}

function toRunEnd(runId: string, raw: Raw): RunEnd {
  return {
    runId: typeof raw.run_id === 'string' ? raw.run_id : runId,
    status: raw.status as string | undefined,
    exitCode: typeof raw.exit_code === 'number' ? raw.exit_code : undefined,
    oomKilled: raw.oom_killed === true,
    timedOut: raw.timed_out === true,
    raw,
  };
}

function toRunResult(raw: Raw, stdout: string, stderr: string, streamed: boolean): RunResult {
  return {
    runId: String(raw.run_id ?? raw.id ?? ''),
    exitCode: Number(raw.exit_code ?? -1),
    stdout,
    stderr,
    durationMs: Number(raw.duration_ms ?? 0),
    oomKilled: raw.oom_killed === true || raw.status === 'oom_killed',
    timedOut: raw.timed_out === true || raw.status === 'timed_out',
    streamed,
  };
}

export function toSnapshot(raw: Raw, region: Region | undefined): Snapshot {
  return {
    id: String(raw.id),
    instanceId: String(raw.instance_id ?? ''),
    status: String(raw.status ?? ''),
    label: String(raw.label ?? ''),
    sizeBytes: Number(raw.size_bytes ?? 0),
    sha256: raw.sha256 as string | undefined,
    createdAt: date(raw.created_at),
    expiresAt: date(raw.expires_at),
    failure: raw.failure as string | undefined,
    region,
    raw,
  };
}

interface SSEEvent {
  event: string;
  data: string;
}

async function* readEvents(response: Response): AsyncGenerator<SSEEvent> {
  if (response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line === '') {
          if (data.length > 0) yield { event, data: data.join('\n') };
          event = 'message';
          data = [];
        } else if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseJSON(text: string): Raw | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : null;
  } catch {
    return null;
  }
}

function toBase64(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
