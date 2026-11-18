// Copyright 2026 Neural Inverse
// SPDX-License-Identifier: Apache-2.0

import type { CallOptions } from './http.js';
import type { ListResult, Regional, Snapshot } from './types.js';

type Raw = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Sandbox: ports, preview links, SSH
// ---------------------------------------------------------------------------

/** A TCP port of a running sandbox, exposed to its creator through Keystone. */
export interface PortExposure extends Regional {
  id: string;
  instanceId: string;
  port: number;
  protocol: string;
  /** `open`, `closed` or `expired`. */
  status: string;
  createdBy: string;
  createdAt?: Date;
  expiresAt?: Date;
  closedAt?: Date;
  closeReason?: string;
  /** The WebSocket route that carries one TCP connection (on the region's API origin). */
  connectPath: string;
  subprotocol: string;
  raw: Raw;
}

export interface ExposePortOptions extends CallOptions {
  /** Seconds the exposure lives (60 to 86400; the server's port policy has the default and the cap). */
  ttlSeconds?: number;
}

export type PreviewVisibility = 'team' | 'public';

/** A shareable URL of an exposed port, served on the operator's preview domain. */
export interface PreviewLink extends Regional {
  id: string;
  instanceId: string;
  exposureId: string;
  port: number;
  visibility: PreviewVisibility | (string & {});
  url: string;
  /** `active`, `expired` or `revoked`. */
  status: string;
  createdBy: string;
  createdAt?: Date;
  expiresAt?: Date;
  revokedAt?: Date;
  revokeReason?: string;
  abuseRule?: string;
  raw: Raw;
}

export interface CreatePreviewLinkOptions extends CallOptions {
  visibility: PreviewVisibility;
  /** Seconds the link lives (60 to 86400; default 3600). */
  ttlSeconds?: number;
}

/** How to connect to a sandbox over SSH: the host key to trust and the route to connect through. */
export interface SandboxSshInfo extends Regional {
  host: string;
  user: string;
  knownHosts: string;
  hostKeySha256: string;
  certificatePath: string;
  connectPath: string;
  subprotocol: string;
  certTtlSeconds: number;
  raw: Raw;
}

/** The connection details with a short-lived certificate for your public key. */
export interface SandboxSshCertificate extends SandboxSshInfo {
  certificate: string;
  serial: string;
  keyId: string;
  validBefore?: Date;
}

// ---------------------------------------------------------------------------
// Organization snapshots and templates
// ---------------------------------------------------------------------------

export interface SnapshotUsage {
  count: number;
  bytes: number;
}

/** The organization's snapshots with how much of the snapshot quota is used (summed over the regions read). */
export interface SnapshotList extends ListResult<Snapshot> {
  usage: SnapshotUsage;
}

export interface Template extends Regional {
  id: string;
  name: string;
  version: string;
  /** `building`, `ready` or `failed`. */
  status: string;
  diskSizeMb?: number;
  memSizeMb?: number;
  cpuCount?: number;
  /** The OCI image the template's sandboxes run, pinned by digest. */
  image?: string;
  /** The snapshot a template made from a snapshot restores. */
  snapshotId?: string;
  createdBy?: string;
  createdAt?: Date;
  raw: Raw;
}

export interface CreateTemplateOptions extends CallOptions {
  /** 2 to 64 lowercase letters, digits or hyphens. */
  name: string;
  /** Semver (default 0.1.0). */
  version?: string;
  /** An OCI image pinned by digest (`name@sha256:...`). Give this or `snapshotId`. */
  image?: string;
  snapshotId?: string;
  diskMb?: number;
  memoryMb?: number;
  cpuCount?: number;
}

export interface TemplateBuildStatus {
  /** `building`, `ready` or `failed`. */
  status: string;
  progressPercent: number;
}

// ---------------------------------------------------------------------------
// Sandbox policy
// ---------------------------------------------------------------------------

export interface SandboxPolicy extends Regional {
  maxConcurrent: number;
  maxExecTimeSeconds: number;
  maxMemoryMb: number;
  maxCpu: number;
  /** null: no cap beyond the workers' maximum. */
  maxDiskMb: number | null;
  maxWorkspacesPerUser: number | null;
  maxCpuCoresPerUser: number | null;
  maxMemoryGbPerUser: number | null;
  /** Hosts a sandbox of network mode `allowlist` may reach. */
  egressAllowlist: string[];
  allowedProviders: string[];
  /** Package registry presets turned on for `allowlist` sandboxes (`npm`, `pypi`, `go`, `crates`). */
  egressPresets: string[];
  /** Hibernation between tool calls: `default` (follow the platform), `on` or `off`. */
  hibernation?: 'default' | 'on' | 'off' | (string & {});
  raw: Raw;
}

/** The members to change; everything left out keeps its value. `null` removes a cap where the server allows it. */
export interface SandboxPolicyUpdate extends CallOptions {
  maxConcurrent?: number;
  maxExecTimeSeconds?: number;
  maxMemoryMb?: number;
  maxCpu?: number;
  maxDiskMb?: number;
  maxWorkspacesPerUser?: number;
  maxCpuCoresPerUser?: number;
  maxMemoryGbPerUser?: number;
  egressAllowlist?: string[];
  allowedProviders?: string[];
  egressPresets?: string[];
  /** Hibernation between tool calls: `default`, `on` or `off` (running sandboxes are notified). */
  hibernation?: 'default' | 'on' | 'off';
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export type WebhookEvent = 'instance.created' | 'instance.terminated' | 'run.completed' | 'snapshot.created' | (string & {});

export interface Webhook extends Regional {
  id: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  raw: Raw;
}

/**
 * A webhook as created. `secret` is the signing secret the server shows once: it is a
 * non-enumerable property (not in `JSON.stringify`, `console.log` or spread) and not in `raw`.
 */
export interface CreatedWebhook extends Webhook {
  readonly secret: string;
}

export interface CreateWebhookOptions extends CallOptions {
  url: string;
  /** Default: every event. */
  events?: WebhookEvent[];
  /** Your own signing secret; default: the server generates one. */
  secret?: string;
}

// ---------------------------------------------------------------------------
// Run traces
// ---------------------------------------------------------------------------

export interface TraceSummary extends Regional {
  traceId: string;
  startTime?: Date;
  endTime?: Date;
  durationMs: number;
  spans: number;
  errors: number;
  sandboxes: string[];
  vcpuHours: number;
  usd: number;
  /** `ok` or `error`. */
  status: string;
  raw: Raw;
}

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  /** `command` or `file_write`. */
  kind: string;
  name: string;
  /** `ok`, `error`, `withheld` or `unfinished`. */
  status: string;
  startTime?: Date;
  endTime?: Date;
  durationMs: number;
  userId?: string;
  toolIdentity?: string;
  auditEntryId: string;
  command?: { runId?: string; argv: string[]; exitCode?: number; outputBytes?: number; oomKilled: boolean; timedOut: boolean };
  files: { path: string; sha256?: string; sizeBytes?: number }[];
  box: { sandboxId?: string; workerId?: string; runtime?: string; isolation?: string; vcpu?: number; memoryMb?: number; region?: string };
  cost: { vcpuHours: number; usd: number };
  dlpRules: string[];
  raw: Raw;
}

export interface Trace extends TraceSummary {
  spanList: TraceSpan[];
  /** Spans on sandboxes the caller may not use (left out). */
  hiddenSpans: number;
  truncated: boolean;
  events: { id: string; ts?: Date; source: string; type: string; severity: string }[];
}

export interface ListTracesOptions extends CallOptions {
  sandboxId?: string;
  /** Last activity from (default: 7 days ago). */
  from?: Date | string;
  to?: Date | string;
  /** 1 to 100 (default 50). */
  limit?: number;
  /** A cursor of one region's page; needs `region`. */
  cursor?: string;
}

export type TraceExportProtocol = 'otlp_http' | 'otlp_grpc';

/** The organization's OpenTelemetry export. Header names only: the values are never answered. */
export interface TraceExport extends Regional {
  enabled: boolean;
  protocol: TraceExportProtocol | (string & {});
  endpoint: string;
  headerNames: string[];
  /** `active` or `degraded`. */
  state: string;
  consecutiveFailures: number;
  lastError?: string;
  lastExportAt?: Date;
  nextAttemptAt?: Date;
  exportedSpans: number;
  updatedAt?: Date;
  updatedBy?: string;
  raw: Raw;
}

export interface SetTraceExportOptions extends CallOptions {
  protocol: TraceExportProtocol;
  /** https only; the server refuses loopback, private and metadata addresses. */
  endpoint: string;
  /** Sent with every export request (e.g. `DD-API-KEY`); stored in Keystone Vault, never answered. Omit to keep them; `{}` removes them. */
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface TraceExportTest {
  ok: boolean;
  traceId?: string;
  /** A fixed reason, never a header value or a response body. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Object storage
// ---------------------------------------------------------------------------

export interface DefaultRetention {
  /** `GOVERNANCE` or `COMPLIANCE`. */
  mode: string;
  days: number;
}

export interface Bucket extends Regional {
  name: string;
  nrn?: string;
  versioning: string;
  objectLock: boolean;
  defaultRetention?: DefaultRetention;
  encryption: string;
  contentClass: string;
  dataEvents: string;
  presign: boolean;
  allowUnsignedPayload: boolean;
  hasPolicy: boolean;
  tags: Record<string, string>;
  createdAt?: Date;
  endpoints: { pathStyle: string; virtualHosted?: string; signingRegion: string };
  usage?: { keys: number; versions: number; bytes: number; uploads: number; reportedAt?: Date };
  deleting: boolean;
  raw: Raw;
}

export interface CreateBucketOptions extends CallOptions {
  name: string;
  versioning?: string;
  objectLock?: boolean;
  defaultRetention?: DefaultRetention;
  contentClass?: string;
  dataEvents?: string;
  presign?: boolean;
  allowUnsignedPayload?: boolean;
  tags?: Record<string, string>;
  /** An idempotency token: the same token creates the bucket once. */
  clientToken?: string;
}

export interface UpdateBucketOptions extends CallOptions {
  versioning?: string;
  objectLock?: boolean;
  defaultRetention?: DefaultRetention;
  clearDefaultRetention?: boolean;
  dataEvents?: string;
  contentClass?: string;
  presign?: boolean;
  allowUnsignedPayload?: boolean;
  tags?: Record<string, string>;
}

export interface BucketList {
  buckets: Bucket[];
  nextToken?: string;
}

export interface LifecycleRule {
  id: string;
  prefix?: string;
  /** `Enabled` or `Disabled`. */
  status: string;
  /** Delete current versions this many days after creation. */
  expirationDays?: number;
  noncurrentVersionExpiration?: { noncurrentDays: number; newerNoncurrentVersions?: number };
  expiredObjectDeleteMarker?: boolean;
  abortIncompleteMultipartUploadDays?: number;
}

export interface AccessKey extends Regional {
  accessKeyId: string;
  nrn?: string;
  principal: string;
  description: string;
  /** `Active` or `Inactive`. */
  status: string;
  createdAt?: Date;
  expiresAt?: Date;
  permissions: string[];
  buckets: string[];
  prefixes: string[];
  cidrs: string[];
  raw: Raw;
}

/** An access key as created. `secretAccessKey` is shown once, and is a non-enumerable property (see `hideSecret`). */
export interface CreatedAccessKey {
  accessKey: AccessKey;
  readonly secretAccessKey: string;
}

export interface CreateAccessKeyOptions extends CallOptions {
  description?: string;
  /** 1 to 365 (default 365). */
  expiresInDays?: number;
  permissions?: string[];
  buckets?: string[];
  prefixes?: string[];
  cidrs?: string[];
}

export interface ObjectsLimits {
  enabled: boolean;
  reason?: string;
  region: string;
  quotas: { quotaCode: string; name: string; value: number; used: number }[];
  features: Record<string, { available: boolean; reason?: string }>;
  raw: Raw;
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export interface CreateWorkspaceOptions extends CallOptions {
  name: string;
  templateId?: string;
  templateVersionId?: string;
  parameters?: Record<string, string>;
  ttlSeconds?: number;
  idleTimeoutSeconds?: number;
  /** A 5-field cron schedule. */
  autostartSchedule?: string;
  projectId?: string;
  environmentId?: string;
  /** The git repository the workspace is for. */
  repository?: string;
}

export interface UpdateWorkspaceOptions extends CallOptions {
  name?: string;
  ttlSeconds?: number;
  idleTimeoutSeconds?: number;
  autostartSchedule?: string;
}

export interface RebuildWorkspaceOptions extends CallOptions {
  templateVersionId?: string;
  parameters?: Record<string, string>;
}

/** The link that opens a workspace in an IDE, built by the server from the workspace. */
export interface OpenLink {
  ide: string;
  /** `deeplink` or `url`. */
  kind: string;
  url: string;
  sshHost?: string;
  folder?: string;
  /** What the IDE side needs (e.g. `config-ssh`). */
  requires: string[];
  raw: Raw;
}

export interface WorkspaceBackup extends Regional {
  id: string;
  workspaceId?: string;
  type: string;
  status: string;
  size: number;
  checksum?: string;
  createdAt?: Date;
  completedAt?: Date;
  error?: string;
  raw: Raw;
}

export interface BackupVerification {
  backupId: string;
  valid: boolean;
  checksumMatch: boolean;
  errors: string[];
  verifiedAt?: Date;
}

/** An app a workspace serves (a web Editor, a dev server). */
export interface WorkspaceApp extends Regional {
  slug: string;
  displayName: string;
  port?: number;
  path?: string;
  /** `owner`, `members`, `org` or `public`. */
  share: string;
  effectiveShare: string;
  health?: string;
  origin?: string;
  canOpen: boolean;
  /** Why it cannot be opened now (`not_running`, `not_authorized`, `kill_switch`...). */
  reason?: string;
  message?: string;
  shareLevels: string[];
  raw: Raw;
}

export type AppShare = 'owner' | 'members' | 'org' | 'public';

/** The app's share level after a change, and the level in force once the organization's policy caps it. */
export interface AppShareResult {
  slug: string;
  share: string;
  effectiveShare: string;
  raw: Raw;
}

// ---------------------------------------------------------------------------
// Build hosts and Agent Cloud
// ---------------------------------------------------------------------------

export interface LeaseRun extends Regional {
  id: string;
  leaseId: string;
  argv: string[];
  cwd?: string;
  command: string;
  state: string;
  exitCode?: number;
  startedAt?: Date;
  finishedAt?: Date;
  durationMs?: number;
  raw: Raw;
}

export interface LeaseArtifact extends Regional {
  id: string;
  leaseId: string;
  runId?: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  createdAt?: Date;
  expiresAt?: Date;
  raw: Raw;
}

export interface CacheEntry {
  id: string;
  cache: string;
  key: string;
  scope: string;
  sizeBytes: number;
  sha256: string;
  leaseId?: string;
  createdAt?: Date;
  lastUsedAt?: Date;
  expiresAt?: Date;
}

/** A build cache of a pool with the entries you may restore (every entry for an administrator). */
export interface CacheView extends Regional {
  name: string;
  scope: string;
  maxBytes: number;
  usedBytes: number;
  entries: CacheEntry[];
  raw: Raw;
}

export interface LabHost extends Regional {
  id: string;
  name: string;
  status: string;
  labels: Record<string, string>;
  poolIds: string[];
  maxLeases: number;
  disabled: boolean;
  hostname?: string;
  os?: string;
  arch?: string;
  health?: string;
  lastSeenAt?: Date;
  activeLeases: number;
  raw: Raw;
}

export type LeadTaskTarget = 'any' | 'worker' | 'account' | 'pool';

export interface AgentTask extends Regional {
  id: string;
  leadGrantId: string;
  /** `queued`, `dispatching`, `dispatched`, `ended`, `cancelled` or `refused`. */
  state: string;
  engine: string;
  mode?: string;
  repository?: string;
  ref?: string;
  target?: string;
  leaseId?: string;
  taskId?: string;
  endReason?: string;
  attempts?: number;
  createdAt?: Date;
  dispatchedAt?: Date;
  endedAt?: Date;
  raw: Raw;
}

export interface CreateAgentTaskOptions extends CallOptions {
  /** The repository the agent works on. */
  repository: string;
  /** What the agent should do. The server keeps its hash and size, never the text. */
  brief: string;
  /** A coding agent engine (`claude_code`, `codex`, ...). */
  engine: string;
  ref?: string;
  /** `edit` (default) or `full`. */
  mode?: string;
  access?: string;
  governanceMode?: 'observe' | 'enforce';
  target?: LeadTaskTarget;
  leaseId?: string;
  accountId?: string;
  poolId?: string;
  cwd?: string;
  maxRuntimeSeconds?: number;
  /** The lead grant the task runs under; default `current` (the caller's one active grant). */
  grantId?: string;
}

export interface ListAgentTasksOptions extends CallOptions {
  /** `open`, `queued`, `dispatched`, `ended`, `cancelled` or `refused`. */
  state?: string;
  limit?: number;
  grantId?: string;
}

// ---------------------------------------------------------------------------
// Account: billing, usage, regions, API keys
// ---------------------------------------------------------------------------

/** One plan in the price book. Every value is the server's. */
export interface PlanOffer {
  plan: string;
  name: string;
  monthlyMinor: number;
  annualMonthlyMinor: number;
  currency: string;
  perSeat: boolean;
  includedVcpuHours: number;
  maxConcurrentBoxes: number;
  maxVcpuPerBox: number;
  networkEgress: boolean;
  maxLeaseHours: number;
  objectStorageGb: number;
  overageAllowed: boolean;
  overageMinorPerVcpuHour: number;
  features: string[];
  raw: Raw;
}

export interface PlanState {
  plan: string;
  interval?: string;
  paidSeats: number;
  overageEnabled: boolean;
  subscriptionStatus?: string;
  currentPeriodEnd?: Date;
  cancelAtPeriodEnd: boolean;
  pendingPlan?: string;
  pendingInterval?: string;
  pendingEffectiveAt?: Date;
  raw: Raw;
}

export interface CreditBalance {
  month: string;
  resetsAt?: Date;
  includedVcpuHours: string;
  usedVcpuHours: string;
  remainingVcpuHours: string;
  overageVcpuHours: string;
  raw: Raw;
}

/** The billing page of a Sandscale organization: plan state, offer in force, balance and price book. */
export interface Billing {
  state: PlanState;
  offer: PlanOffer;
  balance: CreditBalance;
  plans: PlanOffer[];
  raw: Raw;
}

export interface ChangePlanOptions extends CallOptions {
  /** A plan id as the billing page lists it (`PlanOffer.plan`); the server decides which exist and what each costs. */
  plan: string;
  interval?: 'month' | 'year';
  seats?: number;
}

export interface Checkout {
  id: string;
  /** Open this URL to pay. */
  url: string;
  plan: string;
  interval: string;
  seats: number;
  expiresAt?: Date;
  raw: Raw;
}

export interface Usage {
  month: string;
  vcpuSecondsUsed: number;
  vcpuSecondsLeft: number;
  runningBoxes: number;
  runningByRegion: Record<string, number>;
  raw: Raw;
}

export interface RegionInfo {
  id: string;
  status: string;
  apiUrl?: string;
  raw: Raw;
}

export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  expiresAt?: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
  createdAt?: Date;
  /** `active`, `expired` or `revoked`. */
  state: string;
  raw: Raw;
}

/** An API key as created or rotated. `key` is the secret, shown once: a non-enumerable property, not in `raw`. */
export interface CreatedApiKey extends ApiKey {
  readonly key: string;
  rotatedFrom?: string;
  previousExpiresAt?: Date;
}

export interface CreateApiKeyOptions extends CallOptions {
  name: string;
  scopes?: string[];
  /** Required by the server: a personal key always expires. */
  expiresAt: Date | string;
}

export interface RotateApiKeyOptions extends CallOptions {
  /** Seconds the old key keeps working after the rotation. */
  overlapSeconds?: number;
}

export interface ApiKeyList {
  apiKeys: ApiKey[];
  limits: { maxDays?: number; maxActive?: number };
}
