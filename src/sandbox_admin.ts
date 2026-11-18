// Copyright 2026 Neural Inverse
// SPDX-License-Identifier: Apache-2.0

import { enc, type CallOptions, type Region, type Transport } from './http.js';
import { date, listAcrossRegions, opts, toSnapshot } from './sandboxes.js';
import { hideSecret, withoutSecrets } from './secret.js';
import type {
  CreatedWebhook,
  CreateTemplateOptions,
  CreateWebhookOptions,
  ListTracesOptions,
  SandboxPolicy,
  SandboxPolicyUpdate,
  SetTraceExportOptions,
  SnapshotList,
  Template,
  TemplateBuildStatus,
  Trace,
  TraceExport,
  TraceExportTest,
  TraceSpan,
  TraceSummary,
  Webhook,
} from './models.js';
import type { ListResult, Snapshot } from './types.js';

type Raw = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const optNum = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const rec = (v: unknown): Raw => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : {});
const nullableNum = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** The organization's sandbox snapshots (take one with `sandboxes.snapshot`). */
export class Snapshots {
  constructor(private readonly t: Transport) {}

  /** The snapshots you may see, with the snapshot quota used (summed over the regions read). */
  async list(options: CallOptions & { limit?: number } = {}): Promise<SnapshotList> {
    const usage = { count: 0, bytes: 0 };
    const merged: ListResult<Snapshot> = await listAcrossRegions(this.t, options.region, async (region) => {
      const raw = await this.t.request<{ snapshots?: Raw[]; usage?: { count?: number; bytes?: number } }>({
        method: 'GET',
        path: '/api/v1/sandbox/snapshots',
        query: { limit: options.limit },
        region,
        signal: options.signal,
      });
      usage.count += raw.usage?.count ?? 0;
      usage.bytes += raw.usage?.bytes ?? 0;
      return { data: (raw.snapshots ?? []).map((s) => toSnapshot(s, region)), page: { region, hasMore: false } };
    });
    return { ...merged, usage };
  }

  async get(snapshotId: string, options: CallOptions = {}): Promise<Snapshot> {
    const raw = await this.t.request<Raw>({ method: 'GET', path: `/api/v1/sandbox/snapshots/${enc(snapshotId)}`, ...opts(options) });
    return toSnapshot(raw, this.t.regionOf(options.region));
  }

  /** Deletes the snapshot and its stored copy; sandboxes started from it keep running. */
  async delete(snapshotId: string, options: CallOptions = {}): Promise<void> {
    await this.t.request({ method: 'DELETE', path: `/api/v1/sandbox/snapshots/${enc(snapshotId)}`, ...opts(options) });
  }
}

function toTemplate(raw: Raw, region: Region | undefined): Template {
  return {
    id: str(raw.id),
    name: str(raw.name),
    version: str(raw.version),
    status: str(raw.status),
    diskSizeMb: optNum(raw.disk_size_mb),
    memSizeMb: optNum(raw.mem_size_mb),
    cpuCount: optNum(raw.cpu_count),
    image: optStr(raw.image),
    snapshotId: optStr(raw.snapshot_id),
    createdBy: optStr(raw.created_by),
    createdAt: date(raw.created_at),
    region,
    raw,
  };
}

/** Sandbox templates: an image with its default resources. */
export class Templates {
  constructor(private readonly t: Transport) {}

  /** Creates a template from an OCI image pinned by digest (`name@sha256:...`) or from a snapshot. */
  async create(options: CreateTemplateOptions): Promise<Template> {
    const json: Raw = { name: options.name };
    if (options.version !== undefined) json.version = options.version;
    if (options.image !== undefined) json.image = options.image;
    if (options.snapshotId !== undefined) json.snapshot_id = options.snapshotId;
    if (options.diskMb !== undefined) json.disk_size_mb = options.diskMb;
    if (options.memoryMb !== undefined) json.mem_size_mb = options.memoryMb;
    if (options.cpuCount !== undefined) json.cpu_count = options.cpuCount;
    const raw = await this.t.request<Raw>({ method: 'POST', path: '/api/v1/sandbox/templates', json, ...opts(options) });
    return toTemplate(raw, this.t.regionOf(options.region));
  }

  /** The organization's templates and the built-in ones, of one region or of every live region. */
  async list(options: CallOptions = {}): Promise<ListResult<Template>> {
    return listAcrossRegions(this.t, options.region, async (region) => {
      const raw = await this.t.request<{ data?: Raw[]; next_cursor?: string | null; has_more?: boolean }>({
        method: 'GET',
        path: '/api/v1/sandbox/templates',
        region,
        signal: options.signal,
      });
      return {
        data: (raw.data ?? []).map((x) => toTemplate(x, region)),
        page: { region, nextCursor: raw.next_cursor ?? undefined, hasMore: raw.has_more ?? false },
      };
    });
  }

  async get(templateId: string, options: CallOptions = {}): Promise<Template> {
    const raw = await this.t.request<Raw>({ method: 'GET', path: `/api/v1/sandbox/templates/${enc(templateId)}`, ...opts(options) });
    return toTemplate(raw, this.t.regionOf(options.region));
  }

  /** Removes a template; sandboxes already started from it keep running. */
  async delete(templateId: string, options: CallOptions = {}): Promise<void> {
    await this.t.request({ method: 'DELETE', path: `/api/v1/sandbox/templates/${enc(templateId)}`, ...opts(options) });
  }

  /** Whether the template's image is building, ready or failed. */
  async buildStatus(templateId: string, options: CallOptions = {}): Promise<TemplateBuildStatus> {
    const raw = await this.t.request<Raw>({ method: 'GET', path: `/api/v1/sandbox/templates/${enc(templateId)}/build-status`, ...opts(options) });
    return { status: str(raw.status), progressPercent: num(raw.progress_percent) };
  }
}

function toPolicy(raw: Raw, region: Region | undefined): SandboxPolicy {
  return {
    maxConcurrent: num(raw.max_concurrent),
    maxExecTimeSeconds: num(raw.max_exec_time_sec),
    maxMemoryMb: num(raw.max_mem_mb),
    maxCpu: num(raw.max_cpu),
    maxDiskMb: nullableNum(raw.max_disk_mb),
    maxWorkspacesPerUser: nullableNum(raw.max_workspaces_per_user),
    maxCpuCoresPerUser: nullableNum(raw.max_cpu_cores_per_user),
    maxMemoryGbPerUser: nullableNum(raw.max_memory_gb_per_user),
    egressAllowlist: strs(raw.egress_allowlist),
    allowedProviders: strs(raw.allowed_providers),
    egressPresets: strs(raw.egress_presets),
    hibernation: optStr(raw.hibernation),
    region,
    raw,
  };
}

/** The organization's sandbox policy: limits, egress allowlist and presets. */
export class Policy {
  constructor(private readonly t: Transport) {}

  async get(options: CallOptions = {}): Promise<SandboxPolicy> {
    const raw = await this.t.request<Raw>({ method: 'GET', path: '/api/v1/sandbox/policy', ...opts(options) });
    return toPolicy(raw, this.t.regionOf(options.region));
  }

  /** Changes the members you name; the rest keep their values. The server decides what is allowed. */
  async set(update: SandboxPolicyUpdate): Promise<SandboxPolicy> {
    const json: Raw = {};
    const set = (key: string, value: unknown) => {
      if (value !== undefined) json[key] = value;
    };
    set('max_concurrent', update.maxConcurrent);
    set('max_exec_time_sec', update.maxExecTimeSeconds);
    set('max_mem_mb', update.maxMemoryMb);
    set('max_cpu', update.maxCpu);
    set('max_disk_mb', update.maxDiskMb);
    set('max_workspaces_per_user', update.maxWorkspacesPerUser);
    set('max_cpu_cores_per_user', update.maxCpuCoresPerUser);
    set('max_memory_gb_per_user', update.maxMemoryGbPerUser);
    set('egress_allowlist', update.egressAllowlist);
    set('allowed_providers', update.allowedProviders);
    set('egress_presets', update.egressPresets);
    set('hibernation', update.hibernation);
    const raw = await this.t.request<Raw>({ method: 'PUT', path: '/api/v1/sandbox/policy', json, ...opts(update) });
    return toPolicy(raw, this.t.regionOf(update.region));
  }
}

const HEX = /^[0-9a-f]+$/;

/**
 * True when `signature` (the `X-Keystone-Signature` header, `sha256=<hex>`) is the HMAC-SHA256 of
 * the raw request `body` under the webhook's secret. Pass the body exactly as received, before any
 * JSON parsing. The comparison is constant time; a missing or malformed header is false. The
 * current signing carries no timestamp.
 */
export async function verifyWebhookSignature(signature: string | null | undefined, body: string | Uint8Array, secret: string): Promise<boolean> {
  if (!signature || !secret || !signature.startsWith('sha256=')) return false;
  const hex = signature.slice('sha256='.length).trim().toLowerCase();
  // A SHA-256 MAC is exactly 32 bytes: WebCrypto would accept a truncated one.
  if (hex.length !== 64 || !HEX.test(hex)) return false;
  const given = Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
  const data = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  // subtle.verify compares in constant time.
  return crypto.subtle.verify('HMAC', key, given as unknown as BufferSource, data as unknown as BufferSource);
}

function toWebhook(raw: Raw, region: Region | undefined): Webhook {
  return {
    id: str(raw.id),
    url: str(raw.url),
    events: strs(raw.events),
    active: raw.active === true,
    createdAt: date(raw.created_at),
    updatedAt: date(raw.updated_at),
    region,
    raw: withoutSecrets(raw, 'secret'),
  };
}

/** Webhook endpoints for sandbox events (`instance.created`, `instance.terminated`, `run.completed`, `snapshot.created`). */
export class Webhooks {
  constructor(private readonly t: Transport) {}

  /** Verifies a delivery's `X-Keystone-Signature`; see {@link verifyWebhookSignature}. */
  static verify = verifyWebhookSignature;

  async list(options: CallOptions = {}): Promise<Webhook[]> {
    const raw = await this.t.request<{ webhooks?: Raw[] }>({ method: 'GET', path: '/api/v1/sandbox/webhooks', ...opts(options) });
    return (raw.webhooks ?? []).map((w) => toWebhook(w, this.t.regionOf(options.region)));
  }

  /** Registers an endpoint. The signing secret is shown once, on the returned object's `secret`. */
  async create(options: CreateWebhookOptions): Promise<CreatedWebhook> {
    const json: Raw = { url: options.url };
    if (options.events !== undefined) json.events = options.events;
    if (options.secret !== undefined) json.secret = options.secret;
    const raw = await this.t.request<Raw>({ method: 'POST', path: '/api/v1/sandbox/webhooks', json, ...opts(options) });
    return hideSecret(toWebhook(raw, this.t.regionOf(options.region)), 'secret', raw.secret) as CreatedWebhook;
  }

  async delete(webhookId: string, options: CallOptions = {}): Promise<void> {
    await this.t.request({ method: 'DELETE', path: `/api/v1/sandbox/webhooks/${enc(webhookId)}`, ...opts(options) });
  }
}

function toSummary(raw: Raw, region: Region | undefined): TraceSummary {
  return {
    traceId: str(raw.trace_id),
    startTime: date(raw.start_time),
    endTime: date(raw.end_time),
    durationMs: num(raw.duration_ms),
    spans: num(raw.spans),
    errors: num(raw.errors),
    sandboxes: strs(raw.sandboxes),
    vcpuHours: num(raw.vcpu_hours),
    usd: num(raw.usd),
    status: str(raw.status),
    region,
    raw,
  };
}

function toSpan(raw: Raw): TraceSpan {
  const command = raw.command === undefined ? undefined : rec(raw.command);
  const box = rec(raw.box);
  const cost = rec(raw.cost);
  return {
    traceId: str(raw.trace_id),
    spanId: str(raw.span_id),
    parentSpanId: optStr(raw.parent_span_id),
    kind: str(raw.kind),
    name: str(raw.name),
    status: str(raw.status),
    startTime: date(raw.start_time),
    endTime: date(raw.end_time),
    durationMs: num(raw.duration_ms),
    userId: optStr(raw.user_id),
    toolIdentity: optStr(raw.tool_identity),
    auditEntryId: str(raw.audit_entry_id),
    command: command && {
      runId: optStr(command.run_id),
      argv: strs(command.argv),
      exitCode: optNum(command.exit_code),
      outputBytes: optNum(command.output_bytes),
      oomKilled: command.oom_killed === true,
      timedOut: command.timed_out === true,
    },
    files: (Array.isArray(raw.files) ? raw.files : []).map((f) => {
      const file = rec(f);
      return { path: str(file.path), sha256: optStr(file.sha256), sizeBytes: optNum(file.size_bytes) };
    }),
    box: {
      sandboxId: optStr(box.sandbox_id),
      workerId: optStr(box.worker_id),
      runtime: optStr(box.runtime),
      isolation: optStr(box.isolation),
      vcpu: optNum(box.vcpu),
      memoryMb: optNum(box.memory_mb),
      region: optStr(box.region),
    },
    cost: { vcpuHours: num(cost.vcpu_hours), usd: num(cost.usd) },
    dlpRules: strs(raw.dlp_rules),
    raw,
  };
}

function toExport(raw: Raw, region: Region | undefined): TraceExport {
  return {
    enabled: raw.enabled === true,
    protocol: str(raw.protocol),
    endpoint: str(raw.endpoint),
    headerNames: strs(raw.header_names),
    state: str(raw.state),
    consecutiveFailures: num(raw.consecutive_failures),
    lastError: optStr(raw.last_error),
    lastExportAt: date(raw.last_export_at),
    nextAttemptAt: date(raw.next_attempt_at),
    exportedSpans: num(raw.exported_spans),
    updatedAt: date(raw.updated_at),
    updatedBy: optStr(raw.updated_by),
    region,
    raw,
  };
}

function iso(v: Date | string | undefined): string | undefined {
  return v instanceof Date ? v.toISOString() : v;
}

/** Agent run traces (a run is a trace, each tool call a span) and the OpenTelemetry export. */
export class Traces {
  constructor(private readonly t: Transport) {}

  /** Runs, most recently active first, of one region or of every live region. */
  async list(options: ListTracesOptions = {}): Promise<ListResult<TraceSummary>> {
    return listAcrossRegions(this.t, options.region, async (region) => {
      const raw = await this.t.request<{ data?: Raw[]; next_cursor?: string | null; has_more?: boolean }>({
        method: 'GET',
        path: '/api/v1/sandbox/traces',
        query: { sandbox_id: options.sandboxId, from: iso(options.from), to: iso(options.to), limit: options.limit, cursor: options.cursor },
        region,
        signal: options.signal,
      });
      return {
        data: (raw.data ?? []).map((x) => toSummary(x, region)),
        page: { region, nextCursor: raw.next_cursor ?? undefined, hasMore: raw.has_more ?? false },
      };
    });
  }

  /** One run with its spans (oldest first). Spans on sandboxes you may not use are counted in `hiddenSpans`. */
  async get(traceId: string, options: CallOptions = {}): Promise<Trace> {
    const raw = await this.t.request<Raw>({ method: 'GET', path: `/api/v1/sandbox/traces/${enc(traceId)}`, ...opts(options) });
    return {
      ...toSummary(raw, this.t.regionOf(options.region)),
      spanList: (Array.isArray(raw.span_list) ? raw.span_list : []).map((s) => toSpan(rec(s))),
      hiddenSpans: num(raw.hidden_spans),
      truncated: raw.truncated === true,
      events: (Array.isArray(raw.events) ? raw.events : []).map((e) => {
        const ev = rec(e);
        return { id: str(ev.id), ts: date(ev.ts), source: str(ev.source), type: str(ev.type), severity: str(ev.severity) };
      }),
    };
  }

  /** The organization's OTLP export (404 `not_found` when none is configured). Header names only. */
  async getExport(options: CallOptions = {}): Promise<TraceExport> {
    const raw = await this.t.request<Raw>({ method: 'GET', path: '/api/v1/sandbox/trace-export', ...opts(options) });
    return toExport(raw, this.t.regionOf(options.region));
  }

  /** Creates or replaces the export. Header values go to Keystone Vault and are never answered. */
  async setExport(options: SetTraceExportOptions): Promise<TraceExport> {
    const json: Raw = { protocol: options.protocol, endpoint: options.endpoint };
    if (options.headers !== undefined) json.headers = options.headers;
    if (options.enabled !== undefined) json.enabled = options.enabled;
    const raw = await this.t.request<Raw>({ method: 'PUT', path: '/api/v1/sandbox/trace-export', json, ...opts(options) });
    return toExport(raw, this.t.regionOf(options.region));
  }

  /** Removes the export and its stored headers. */
  async deleteExport(options: CallOptions = {}): Promise<void> {
    await this.t.request({ method: 'DELETE', path: '/api/v1/sandbox/trace-export', ...opts(options) });
  }

  /** Sends one synthetic span to the endpoint with the stored headers. */
  async testExport(options: CallOptions = {}): Promise<TraceExportTest> {
    const raw = await this.t.request<Raw>({ method: 'POST', path: '/api/v1/sandbox/trace-export/test', ...opts(options) });
    return { ok: raw.ok === true, traceId: optStr(raw.trace_id), error: optStr(raw.error) };
  }
}
