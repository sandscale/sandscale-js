// Copyright 2026 Neural Inverse
// SPDX-License-Identifier: Apache-2.0

import { enc, type CallOptions, type Region, type Transport } from './http.js';
import { date, listAcrossRegions, opts } from './sandboxes.js';
import type {
  AgentTask,
  AppShare,
  AppShareResult,
  BackupVerification,
  CacheView,
  CreateAgentTaskOptions,
  CreateWorkspaceOptions,
  LabHost,
  LeaseArtifact,
  LeaseRun,
  ListAgentTasksOptions,
  OpenLink,
  RebuildWorkspaceOptions,
  UpdateWorkspaceOptions,
  WorkspaceApp,
  WorkspaceBackup,
} from './models.js';
import type { ListResult, Regional } from './types.js';

type Raw = Record<string, unknown>;

export interface Workspace extends Regional {
  id: string;
  name: string;
  status: string;
  health?: string;
  templateId?: string;
  ownerId?: string;
  projectId?: string;
  createdAt?: Date;
  updatedAt?: Date;
  lastUsedAt?: Date;
  raw: Raw;
}

/** A workspace build: start and stop are builds the server queues (202 Accepted). */
export interface WorkspaceBuild extends Regional {
  id: string;
  workspaceId: string;
  state: string;
  desiredState?: string;
  buildNumber?: number;
  reason?: string;
  failureMessage?: string;
  createdAt?: Date;
  completedAt?: Date;
  raw: Raw;
}

export interface ConnectInfo {
  sshHost: string;
  sshCommand?: string;
  portForwardCommand?: string;
  folder?: string;
  sshReady: boolean;
  sshUnavailableReason?: string;
  sshNote?: string;
  links: { ide: string; kind: string; url: string; requires?: string[] }[];
  raw: Raw;
}

export interface ListWorkspacesOptions extends CallOptions {
  limit?: number;
  cursor?: string;
  /** Include deleted workspaces. */
  all?: boolean;
}

export class Workspaces {
  constructor(private readonly t: Transport) {}

  private org(): string {
    return enc(this.t.requireOrg());
  }

  /** Lists workspaces: of one region when one is named, else of every live region. */
  async list(options: ListWorkspacesOptions = {}): Promise<ListResult<Workspace>> {
    const path = `/api/v1/orgs/${this.org()}/workspaces`;
    return listAcrossRegions(this.t, options.region, async (region) => {
      const raw = await this.t.request<{ workspaces?: Raw[]; next_cursor?: string }>({
        method: 'GET',
        path,
        query: { limit: options.limit, cursor: options.cursor, all: options.all ? 'true' : undefined },
        region,
        signal: options.signal,
      });
      return {
        data: (raw.workspaces ?? []).map((w) => toWorkspace(w, region)),
        page: { region, nextCursor: raw.next_cursor || undefined, hasMore: Boolean(raw.next_cursor) },
      };
    });
  }

  async get(id: string, options: CallOptions = {}): Promise<Workspace> {
    return toWorkspace(await this.t.request<Raw>({ method: 'GET', path: `/api/v1/orgs/${this.org()}/workspaces/${enc(id)}`, ...opts(options) }), this.t.regionOf(options.region));
  }

  /** Queues a start build. */
  async start(id: string, options: CallOptions = {}): Promise<WorkspaceBuild> {
    const raw = await this.t.request<Raw>({ method: 'POST', path: `/api/v1/orgs/${this.org()}/workspaces/${enc(id)}/start`, ...opts(options) });
    return toBuild(raw, this.t.regionOf(options.region));
  }

  /** Queues a stop build. */
  async stop(id: string, options: CallOptions = {}): Promise<WorkspaceBuild> {
    const raw = await this.t.request<Raw>({ method: 'POST', path: `/api/v1/orgs/${this.org()}/workspaces/${enc(id)}/stop`, ...opts(options) });
    return toBuild(raw, this.t.regionOf(options.region));
  }

  /** How to connect: SSH host and command, port forwarding, editor links, as the server allows. */
  async connectInfo(id: string, options: CallOptions = {}): Promise<ConnectInfo> {
    return toConnect(await this.t.request<Raw>({ method: 'GET', path: `/api/v1/orgs/${this.org()}/workspaces/${enc(id)}/connect`, ...opts(options) }));
  }

  /** Creates a workspace from a template and queues its first build. The plan, quota and policy are the server's. */
  async create(options: CreateWorkspaceOptions): Promise<{ workspace: Workspace; build: WorkspaceBuild }> {
    const json: Raw = { name: options.name };
    const set = (key: string, value: unknown) => {
      if (value !== undefined) json[key] = value;
    };
    set('template_id', options.templateId);
    set('template_version_id', options.templateVersionId);
    set('parameters', options.parameters);
    set('ttl_seconds', options.ttlSeconds);
    set('idle_timeout_seconds', options.idleTimeoutSeconds);
    set('autostart_schedule', options.autostartSchedule);
    set('project_id', options.projectId);
    set('environment_id', options.environmentId);
    set('repository', options.repository);
    const raw = await this.t.request<{ workspace?: Raw; build?: Raw }>({ method: 'POST', path: `/api/v1/orgs/${this.org()}/workspaces`, json, ...opts(options) });
    const region = this.t.regionOf(options.region);
    return { workspace: toWorkspace(raw.workspace ?? {}, region), build: toBuild(raw.build ?? {}, region) };
  }

  /** Changes the members you name. */
  async update(id: string, options: UpdateWorkspaceOptions): Promise<Workspace> {
    const json: Raw = {};
    if (options.name !== undefined) json.name = options.name;
    if (options.ttlSeconds !== undefined) json.ttl_seconds = options.ttlSeconds;
    if (options.idleTimeoutSeconds !== undefined) json.idle_timeout_seconds = options.idleTimeoutSeconds;
    if (options.autostartSchedule !== undefined) json.autostart_schedule = options.autostartSchedule;
    const raw = await this.t.request<Raw>({ method: 'PATCH', path: `/api/v1/orgs/${this.org()}/workspaces/${enc(id)}`, json, ...opts(options) });
    return toWorkspace(raw, this.t.regionOf(options.region));
  }

  /** Deletes the workspace. */
  async delete(id: string, options: CallOptions = {}): Promise<void> {
    await this.t.request({ method: 'DELETE', path: `/api/v1/orgs/${this.org()}/workspaces/${enc(id)}`, ...opts(options) });
  }

  /** Queues a rebuild, optionally on another template version. */
  async rebuild(id: string, options: RebuildWorkspaceOptions = {}): Promise<WorkspaceBuild> {
    const json: Raw = {};
    if (options.templateVersionId !== undefined) json.template_version_id = options.templateVersionId;
    if (options.parameters !== undefined) json.parameters = options.parameters;
    const raw = await this.t.request<Raw>({ method: 'POST', path: `/api/v1/orgs/${this.org()}/workspaces/${enc(id)}/rebuild`, json, ...opts(options) });
    return toBuild(raw, this.t.regionOf(options.region));
  }

  /** The link that opens the workspace in `ide` (`vscode`, `cursor`, ...), built by the server and only for the IDEs the policy allows. */
  async openLink(id: string, ide: string, options: CallOptions = {}): Promise<OpenLink> {
    const raw = await this.t.request<Raw>({ method: 'GET', path: `/api/v1/orgs/${this.org()}/workspaces/${enc(id)}/open`, query: { ide }, ...opts(options) });
    return {
      ide: String(raw.ide ?? ide),
      kind: String(raw.kind ?? ''),
      url: String(raw.url ?? ''),
      sshHost: (raw.ssh_host as string) || undefined,
      folder: (raw.folder as string) || undefined,
      requires: Array.isArray(raw.requires) ? (raw.requires as string[]) : [],
      raw,
    };
  }

  /** The workspace's backups, newest first. */
  async listBackups(id: string, options: CallOptions & { limit?: number } = {}): Promise<WorkspaceBackup[]> {
    const raw = await this.t.request<{ backups?: Raw[] }>({
      method: 'GET',
      path: `/api/v1/orgs/${this.org()}/workspaces/${enc(id)}/backups`,
      query: { limit: options.limit },
      ...opts(options),
    });
    return (raw.backups ?? []).map((b) => toBackup(b, this.t.regionOf(options.region)));
  }

  /** Takes a backup of the workspace now. */
  async createBackup(id: string, options: CallOptions = {}): Promise<WorkspaceBackup> {
    const raw = await this.t.request<Raw>({ method: 'POST', path: `/api/v1/orgs/${this.org()}/workspaces/${enc(id)}/backups`, ...opts(options) });
    return toBackup(raw, this.t.regionOf(options.region));
  }

  /** Checks the backup's integrity (its checksum). */
  async verifyBackup(backupId: string, options: CallOptions = {}): Promise<BackupVerification> {
    const raw = await this.t.request<Raw>({ method: 'POST', path: `/api/v1/orgs/${this.org()}/backups/${enc(backupId)}/verify`, ...opts(options) });
    return {
      backupId: String(raw.backup_id ?? backupId),
      valid: raw.valid === true,
      checksumMatch: raw.checksum_match === true,
      errors: Array.isArray(raw.errors) ? (raw.errors as string[]) : [],
      verifiedAt: date(raw.verified_at),
    };
  }

  /** The apps the workspace serves, with who may open each. */
  async listApps(id: string, options: CallOptions = {}): Promise<WorkspaceApp[]> {
    const raw = await this.t.request<{ apps?: Raw[] }>({ method: 'GET', path: `/api/v1/orgs/${this.org()}/workspaces/${enc(id)}/apps`, ...opts(options) });
    const region = this.t.regionOf(options.region);
    return (raw.apps ?? []).map((a) => ({
      slug: String(a.slug ?? ''),
      displayName: String(a.display_name ?? ''),
      port: typeof a.port === 'number' ? a.port : undefined,
      path: (a.path as string) || undefined,
      share: String(a.share ?? ''),
      effectiveShare: String(a.effective_share ?? ''),
      health: (a.health as string) || undefined,
      origin: (a.origin as string) || undefined,
      canOpen: a.can_open === true,
      reason: (a.reason as string) || undefined,
      message: (a.message as string) || undefined,
      shareLevels: Array.isArray(a.share_levels) ? (a.share_levels as string[]) : [],
      region,
      raw: a,
    }));
  }

  /** Sets an app's share level; the organization's policy caps it (`effectiveShare`). */
  async shareApp(id: string, slug: string, share: AppShare, options: CallOptions = {}): Promise<AppShareResult> {
    const raw = await this.t.request<Raw>({
      method: 'PATCH',
      path: `/api/v1/orgs/${this.org()}/workspaces/${enc(id)}/apps/${enc(slug)}/share`,
      json: { share },
      ...opts(options),
    });
    return { slug: String(raw.slug ?? slug), share: String(raw.share ?? share), effectiveShare: String(raw.effective_share ?? ''), raw };
  }
}

export interface Lease extends Regional {
  id: string;
  poolId: string;
  state: string;
  size?: { name: string; cpuCores: number; memoryGb: number };
  purpose?: string;
  repo?: string;
  /** The lease's host is this cloud workspace (cloud and BYOC pools). */
  workspaceId?: string;
  /** The lease's host is this lab host. */
  labHostId?: string;
  host?: { status: string; ready: boolean; sshUser?: string };
  createdAt?: Date;
  expiresAt?: Date;
  endedAt?: Date;
  endReason?: string;
  raw: Raw;
}

export interface Pool extends Regional {
  id: string;
  name: string;
  backend: string;
  sizes: { name: string; cpuCores: number; memoryGb: number }[];
  defaultSize?: string;
  requiresApproval: boolean;
  raw: Raw;
}

export interface StartLeaseOptions extends CallOptions {
  /** A size the pool offers (default: the pool's). */
  size?: string;
  ttlSeconds?: number;
  purpose?: string;
  repo?: string;
}

export interface LeaseConnectInfo {
  lease: Lease;
  /** `workspace`: connect like a workspace; `lab`: SSH through the lease's relay WebSocket. */
  kind: 'workspace' | 'lab' | 'pending';
  workspace?: ConnectInfo;
  /** For a lab lease: the relay path (WebSocket, binary SSH) on the region's API origin. */
  sshRelayPath?: string;
  sshUser?: string;
}

export interface SSHCertificate {
  certificate: string;
  serial: string;
  keyId: string;
  principals: string[];
  validAfter?: Date;
  validBefore?: Date;
  ssh: Raw;
}

export class BuildHosts {
  constructor(
    private readonly t: Transport,
    private readonly workspaces: Workspaces,
  ) {}

  private org(): string {
    return enc(this.t.requireOrg());
  }

  /** The pools the caller can see, of one region or of every live region. */
  async listPools(options: CallOptions = {}): Promise<ListResult<Pool>> {
    const path = `/api/v1/orgs/${this.org()}/build/pools`;
    return listAcrossRegions(this.t, options.region, async (region) => {
      const raw = await this.t.request<{ pools?: Raw[] }>({ method: 'GET', path, region, signal: options.signal });
      return { data: (raw.pools ?? []).map((p) => toPool(p, region)), page: { region, hasMore: false } };
    });
  }

  /** The caller's leases (`scope: 'org'` for every lease, where the server allows it). */
  async list(options: CallOptions & { scope?: 'mine' | 'org'; state?: string; limit?: number } = {}): Promise<ListResult<Lease>> {
    const path = `/api/v1/orgs/${this.org()}/build/leases`;
    return listAcrossRegions(this.t, options.region, async (region) => {
      const raw = await this.t.request<{ leases?: Raw[] }>({
        method: 'GET',
        path,
        query: { scope: options.scope, state: options.state, limit: options.limit },
        region,
        signal: options.signal,
      });
      return { data: (raw.leases ?? []).map((l) => toLease(l, region)), page: { region, hasMore: false } };
    });
  }

  async get(leaseId: string, options: CallOptions = {}): Promise<Lease> {
    const raw = await this.t.request<Raw>({ method: 'GET', path: `/api/v1/orgs/${this.org()}/build/leases/${enc(leaseId)}`, ...opts(options) });
    return toLease(raw, this.t.regionOf(options.region));
  }

  /** Takes a build host lease from a pool (it may wait for an approval: state `pending_approval`). */
  async start(poolId: string, options: StartLeaseOptions = {}): Promise<Lease> {
    const json: Raw = {};
    if (options.size !== undefined) json.size = options.size;
    if (options.ttlSeconds !== undefined) json.ttl_seconds = options.ttlSeconds;
    if (options.purpose !== undefined) json.purpose = options.purpose;
    if (options.repo !== undefined) json.repo = options.repo;
    const raw = await this.t.request<Raw>({ method: 'POST', path: `/api/v1/orgs/${this.org()}/build/pools/${enc(poolId)}/leases`, json, ...opts(options) });
    return toLease(raw, this.t.regionOf(options.region));
  }

  /** Releases the lease; its host is wiped and deleted by the server. */
  async stop(leaseId: string, options: CallOptions = {}): Promise<Lease> {
    const raw = await this.t.request<Raw>({ method: 'POST', path: `/api/v1/orgs/${this.org()}/build/leases/${enc(leaseId)}/release`, ...opts(options) });
    return toLease(raw, this.t.regionOf(options.region));
  }

  /** How to reach the lease's host: its workspace's connect info, or a lab host's SSH relay. */
  async connectInfo(leaseId: string, options: CallOptions = {}): Promise<LeaseConnectInfo> {
    const lease = await this.get(leaseId, options);
    if (lease.workspaceId) {
      return { lease, kind: 'workspace', workspace: await this.workspaces.connectInfo(lease.workspaceId, options) };
    }
    if (lease.labHostId) {
      return { lease, kind: 'lab', sshRelayPath: `/api/v1/orgs/${this.org()}/build/leases/${enc(leaseId)}/ssh`, sshUser: lease.host?.sshUser };
    }
    return { lease, kind: 'pending' };
  }

  /** Extends the lease by `ttlSeconds` (the plan's lease hours and the pool's hard maximum are the server's). */
  async renew(leaseId: string, ttlSeconds: number, options: CallOptions = {}): Promise<Lease> {
    const raw = await this.t.request<Raw>({
      method: 'POST',
      path: `/api/v1/orgs/${this.org()}/build/leases/${enc(leaseId)}/renew`,
      json: { ttl_seconds: ttlSeconds },
      ...opts(options),
    });
    return toLease(raw, this.t.regionOf(options.region));
  }

  /** Ends any lease at once (administrators). */
  async kill(leaseId: string, options: CallOptions & { reason?: string } = {}): Promise<Lease> {
    const raw = await this.t.request<Raw>({
      method: 'POST',
      path: `/api/v1/orgs/${this.org()}/build/leases/${enc(leaseId)}/kill`,
      json: { reason: options.reason ?? '' },
      ...opts(options),
    });
    return toLease(raw, this.t.regionOf(options.region));
  }

  /** The commands recorded on the lease. */
  async listRuns(leaseId: string, options: CallOptions = {}): Promise<LeaseRun[]> {
    const raw = await this.t.request<{ runs?: Raw[] }>({ method: 'GET', path: `/api/v1/orgs/${this.org()}/build/leases/${enc(leaseId)}/runs`, ...opts(options) });
    return (raw.runs ?? []).map((r) => toRun(r, this.t.regionOf(options.region)));
  }

  async getRun(leaseId: string, runId: string, options: CallOptions = {}): Promise<LeaseRun> {
    const raw = await this.t.request<Raw>({ method: 'GET', path: `/api/v1/orgs/${this.org()}/build/leases/${enc(leaseId)}/runs/${enc(runId)}`, ...opts(options) });
    return toRun(raw, this.t.regionOf(options.region));
  }

  async listArtifacts(leaseId: string, options: CallOptions = {}): Promise<LeaseArtifact[]> {
    const raw = await this.t.request<{ artifacts?: Raw[] }>({ method: 'GET', path: `/api/v1/orgs/${this.org()}/build/leases/${enc(leaseId)}/artifacts`, ...opts(options) });
    return (raw.artifacts ?? []).map((a) => toArtifact(a, this.t.regionOf(options.region)));
  }

  async getArtifact(leaseId: string, artifactId: string, options: CallOptions = {}): Promise<LeaseArtifact> {
    const raw = await this.t.request<Raw>({
      method: 'GET',
      path: `/api/v1/orgs/${this.org()}/build/leases/${enc(leaseId)}/artifacts/${enc(artifactId)}`,
      ...opts(options),
    });
    return toArtifact(raw, this.t.regionOf(options.region));
  }

  /** The artifact's content. */
  async downloadArtifact(leaseId: string, artifactId: string, options: CallOptions = {}): Promise<Uint8Array> {
    const response = await this.t.request<Response>({
      method: 'GET',
      path: `/api/v1/orgs/${this.org()}/build/leases/${enc(leaseId)}/artifacts/${enc(artifactId)}/content`,
      accept: 'application/octet-stream',
      raw: true,
      ...opts(options),
    });
    return new Uint8Array(await response.arrayBuffer());
  }

  async deleteArtifact(leaseId: string, artifactId: string, options: CallOptions = {}): Promise<void> {
    await this.t.request({
      method: 'DELETE',
      path: `/api/v1/orgs/${this.org()}/build/leases/${enc(leaseId)}/artifacts/${enc(artifactId)}`,
      ...opts(options),
    });
  }

  /** The build caches of the lease's pool that the lease may restore. */
  async listCaches(leaseId: string, options: CallOptions = {}): Promise<CacheView[]> {
    const raw = await this.t.request<{ caches?: Raw[] }>({ method: 'GET', path: `/api/v1/orgs/${this.org()}/build/leases/${enc(leaseId)}/caches`, ...opts(options) });
    return (raw.caches ?? []).map((c) => toCacheView(c, this.t.regionOf(options.region)));
  }

  async listPoolCaches(poolId: string, options: CallOptions = {}): Promise<CacheView[]> {
    const raw = await this.t.request<{ caches?: Raw[] }>({ method: 'GET', path: `/api/v1/orgs/${this.org()}/build/pools/${enc(poolId)}/caches`, ...opts(options) });
    return (raw.caches ?? []).map((c) => toCacheView(c, this.t.regionOf(options.region)));
  }

  /** Deletes every entry of a pool's cache (administrators). */
  async purgePoolCache(poolId: string, cacheName: string, options: CallOptions = {}): Promise<void> {
    await this.t.request({
      method: 'DELETE',
      path: `/api/v1/orgs/${this.org()}/build/pools/${enc(poolId)}/caches/${enc(cacheName)}`,
      ...opts(options),
    });
  }

  /** A short-lived SSH certificate for the lease's host, for your public key. */
  async sshCertificate(leaseId: string, publicKey: string, options: CallOptions = {}): Promise<SSHCertificate> {
    const raw = await this.t.request<Raw>({
      method: 'POST',
      path: `/api/v1/orgs/${this.org()}/build/leases/${enc(leaseId)}/ssh/certificate`,
      json: { public_key: publicKey },
      ...opts(options),
    });
    return {
      certificate: String(raw.certificate ?? ''),
      serial: String(raw.serial ?? ''),
      keyId: String(raw.key_id ?? ''),
      principals: (raw.principals as string[]) ?? [],
      validAfter: date(raw.valid_after),
      validBefore: date(raw.valid_before),
      ssh: (raw.ssh as Raw) ?? {},
    };
  }
}

function toWorkspace(raw: Raw, region: Region | undefined): Workspace {
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    status: String(raw.status ?? ''),
    health: raw.health as string | undefined,
    templateId: (raw.template_id as string) || undefined,
    ownerId: (raw.owner_id as string) || undefined,
    projectId: (raw.project_id as string) || undefined,
    createdAt: date(raw.created_at),
    updatedAt: date(raw.updated_at),
    lastUsedAt: date(raw.last_used_at),
    region,
    raw,
  };
}

function toBuild(raw: Raw, region: Region | undefined): WorkspaceBuild {
  return {
    id: String(raw.id),
    workspaceId: String(raw.workspace_id ?? ''),
    state: String(raw.state ?? ''),
    desiredState: raw.desired_state as string | undefined,
    buildNumber: raw.build_number as number | undefined,
    reason: raw.reason as string | undefined,
    failureMessage: (raw.failure_message as string) || undefined,
    createdAt: date(raw.created_at),
    completedAt: date(raw.completed_at),
    region,
    raw,
  };
}

function toConnect(raw: Raw): ConnectInfo {
  return {
    sshHost: String(raw.ssh_host ?? ''),
    sshCommand: raw.ssh_command as string | undefined,
    portForwardCommand: raw.port_forward_command as string | undefined,
    folder: raw.folder as string | undefined,
    sshReady: raw.ssh_ready === true,
    sshUnavailableReason: raw.ssh_unavailable_reason as string | undefined,
    sshNote: raw.ssh_note as string | undefined,
    links: (raw.links as ConnectInfo['links']) ?? [],
    raw,
  };
}

function toSize(raw: unknown): { name: string; cpuCores: number; memoryGb: number } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const s = raw as Raw;
  return { name: String(s.name ?? ''), cpuCores: Number(s.cpu_cores ?? 0), memoryGb: Number(s.memory_gb ?? 0) };
}

function toLease(raw: Raw, region: Region | undefined): Lease {
  const host = raw.host as Raw | undefined;
  return {
    id: String(raw.id),
    poolId: String(raw.pool_id ?? ''),
    state: String(raw.state ?? ''),
    size: toSize(raw.size),
    purpose: (raw.purpose as string) || undefined,
    repo: (raw.repo as string) || undefined,
    workspaceId: (raw.workspace_id as string) || undefined,
    labHostId: (raw.lab_host_id as string) || undefined,
    host: host ? { status: String(host.status ?? ''), ready: host.ready === true, sshUser: host.ssh_user as string | undefined } : undefined,
    createdAt: date(raw.created_at),
    expiresAt: date(raw.expires_at),
    endedAt: date(raw.ended_at),
    endReason: (raw.end_reason as string) || undefined,
    region,
    raw,
  };
}

function toPool(raw: Raw, region: Region | undefined): Pool {
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    backend: String(raw.backend ?? ''),
    sizes: ((raw.sizes as unknown[]) ?? []).map(toSize).filter((s): s is NonNullable<typeof s> => s !== undefined),
    defaultSize: (raw.default_size as string) || undefined,
    requiresApproval: raw.requires_approval === true,
    region,
    raw,
  };
}

/** Lab hosts: machines your organization enrolled to serve build host leases. */
export class LabHosts {
  constructor(private readonly t: Transport) {}

  private org(): string {
    return enc(this.t.requireOrg());
  }

  /** The organization's lab hosts, of one region or of every live region. */
  async list(options: CallOptions = {}): Promise<ListResult<LabHost>> {
    const path = `/api/v1/orgs/${this.org()}/build/lab-hosts`;
    return listAcrossRegions(this.t, options.region, async (region) => {
      const raw = await this.t.request<{ lab_hosts?: Raw[] }>({ method: 'GET', path, region, signal: options.signal });
      return { data: (raw.lab_hosts ?? []).map((h) => toLabHost(h, region)), page: { region, hasMore: false } };
    });
  }

  async get(hostId: string, options: CallOptions = {}): Promise<LabHost> {
    const raw = await this.t.request<Raw>({ method: 'GET', path: `/api/v1/orgs/${this.org()}/build/lab-hosts/${enc(hostId)}`, ...opts(options) });
    return toLabHost(raw, this.t.regionOf(options.region));
  }

  /** Revokes the host: it takes no new lease and its certificate stops working (administrators). */
  async revoke(hostId: string, options: CallOptions & { reason?: string } = {}): Promise<LabHost> {
    const raw = await this.t.request<Raw>({
      method: 'POST',
      path: `/api/v1/orgs/${this.org()}/build/lab-hosts/${enc(hostId)}/revoke`,
      json: { reason: options.reason ?? '' },
      ...opts(options),
    });
    return toLabHost(raw, this.t.regionOf(options.region));
  }
}

/**
 * Agent Cloud: background coding-agent tasks run on your build hosts, queued, listed and stopped
 * through Keystone's lead routes (`/build/leads/{grant}/tasks`), never through a device agent.
 * These routes refuse API keys (`403 person_required`): build the client with the person's own
 * sign-in `token`. The grant, engine, mode, budget and repository checks are the server's.
 */
export class AgentCloud {
  constructor(private readonly t: Transport) {}

  private org(): string {
    return enc(this.t.requireOrg());
  }

  /** Queues a task for an agent engine on a repository. */
  async createTask(options: CreateAgentTaskOptions): Promise<AgentTask> {
    const json: Raw = { repository: options.repository, brief: options.brief, engine: options.engine };
    const set = (key: string, value: unknown) => {
      if (value !== undefined) json[key] = value;
    };
    set('ref', options.ref);
    set('mode', options.mode);
    set('access', options.access);
    set('governance_mode', options.governanceMode);
    set('target', options.target);
    set('lease_id', options.leaseId);
    set('account_id', options.accountId);
    set('pool_id', options.poolId);
    set('cwd', options.cwd);
    set('max_runtime_seconds', options.maxRuntimeSeconds);
    const raw = await this.t.request<Raw>({
      method: 'POST',
      path: `/api/v1/orgs/${this.org()}/build/leads/${enc(options.grantId ?? 'current')}/tasks`,
      json,
      ...opts(options),
    });
    return toAgentTask(raw, this.t.regionOf(options.region));
  }

  /** Tasks, newest first. */
  async listTasks(options: ListAgentTasksOptions = {}): Promise<AgentTask[]> {
    const raw = await this.t.request<{ tasks?: Raw[] }>({
      method: 'GET',
      path: `/api/v1/orgs/${this.org()}/build/leads/${enc(options.grantId ?? 'current')}/tasks`,
      query: { state: options.state, limit: options.limit },
      ...opts(options),
    });
    return (raw.tasks ?? []).map((t) => toAgentTask(t, this.t.regionOf(options.region)));
  }

  async getTask(taskId: string, options: CallOptions & { grantId?: string } = {}): Promise<AgentTask> {
    const raw = await this.t.request<Raw>({
      method: 'GET',
      path: `/api/v1/orgs/${this.org()}/build/leads/${enc(options.grantId ?? 'current')}/tasks/${enc(taskId)}`,
      ...opts(options),
    });
    return toAgentTask(raw, this.t.regionOf(options.region));
  }

  /** Cancels a queued task, or stops a dispatched one. */
  async cancelTask(taskId: string, options: CallOptions & { grantId?: string } = {}): Promise<AgentTask> {
    const raw = await this.t.request<Raw>({
      method: 'POST',
      path: `/api/v1/orgs/${this.org()}/build/leads/${enc(options.grantId ?? 'current')}/tasks/${enc(taskId)}/stop`,
      ...opts(options),
    });
    return toAgentTask(raw, this.t.regionOf(options.region));
  }
}

const rstr = (v: unknown): string => (typeof v === 'string' ? v : '');
const ropt = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const rnum = (v: unknown): number => (typeof v === 'number' ? v : 0);

function toBackup(raw: Raw, region: Region | undefined): WorkspaceBackup {
  return {
    id: rstr(raw.id),
    workspaceId: ropt(raw.workspace_id),
    type: rstr(raw.type),
    status: rstr(raw.status),
    size: rnum(raw.size),
    checksum: ropt(raw.checksum),
    createdAt: date(raw.created_at),
    completedAt: date(raw.completed_at),
    error: ropt(raw.error_msg),
    region,
    raw,
  };
}

function toRun(raw: Raw, region: Region | undefined): LeaseRun {
  return {
    id: rstr(raw.id),
    leaseId: rstr(raw.lease_id),
    argv: Array.isArray(raw.argv) ? (raw.argv as string[]) : [],
    cwd: ropt(raw.cwd),
    command: rstr(raw.command),
    state: rstr(raw.state),
    exitCode: typeof raw.exit_code === 'number' ? raw.exit_code : undefined,
    startedAt: date(raw.started_at),
    finishedAt: date(raw.finished_at),
    durationMs: typeof raw.duration_ms === 'number' ? raw.duration_ms : undefined,
    region,
    raw,
  };
}

function toArtifact(raw: Raw, region: Region | undefined): LeaseArtifact {
  return {
    id: rstr(raw.id),
    leaseId: rstr(raw.lease_id),
    runId: ropt(raw.run_id),
    name: rstr(raw.name),
    sizeBytes: rnum(raw.size_bytes),
    sha256: rstr(raw.sha256),
    createdAt: date(raw.created_at),
    expiresAt: date(raw.expires_at),
    region,
    raw,
  };
}

function toCacheView(raw: Raw, region: Region | undefined): CacheView {
  return {
    name: rstr(raw.name),
    scope: rstr(raw.scope),
    maxBytes: rnum(raw.max_bytes),
    usedBytes: rnum(raw.used_bytes),
    entries: (Array.isArray(raw.entries) ? (raw.entries as Raw[]) : []).map((e) => ({
      id: rstr(e.id),
      cache: rstr(e.cache),
      key: rstr(e.key),
      scope: rstr(e.scope),
      sizeBytes: rnum(e.size_bytes),
      sha256: rstr(e.sha256),
      leaseId: ropt(e.lease_id),
      createdAt: date(e.created_at),
      lastUsedAt: date(e.last_used_at),
      expiresAt: date(e.expires_at),
    })),
    region,
    raw,
  };
}

function toLabHost(raw: Raw, region: Region | undefined): LabHost {
  return {
    id: rstr(raw.id),
    name: rstr(raw.name),
    status: rstr(raw.status),
    labels: Object.fromEntries(Object.entries((raw.labels as Record<string, unknown>) ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string')),
    poolIds: Array.isArray(raw.pool_ids) ? (raw.pool_ids as string[]) : [],
    maxLeases: rnum(raw.max_leases),
    disabled: raw.disabled === true,
    hostname: ropt(raw.hostname),
    os: ropt(raw.os),
    arch: ropt(raw.arch),
    health: ropt(raw.health),
    lastSeenAt: date(raw.last_seen_at),
    activeLeases: rnum(raw.active_leases),
    region,
    raw,
  };
}

function toAgentTask(raw: Raw, region: Region | undefined): AgentTask {
  return {
    id: rstr(raw.id),
    leadGrantId: rstr(raw.lead_grant_id),
    state: rstr(raw.state),
    engine: rstr(raw.engine),
    mode: ropt(raw.mode),
    repository: ropt(raw.repository),
    ref: ropt(raw.ref),
    target: ropt(raw.target),
    leaseId: ropt(raw.lease_id),
    taskId: ropt(raw.task_id),
    endReason: ropt(raw.end_reason),
    attempts: typeof raw.attempts === 'number' ? raw.attempts : undefined,
    createdAt: date(raw.created_at),
    dispatchedAt: date(raw.dispatched_at),
    endedAt: date(raw.ended_at),
    region,
    raw,
  };
}
