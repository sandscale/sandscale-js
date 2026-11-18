// Copyright 2026 Neural Inverse
// SPDX-License-Identifier: Apache-2.0

import { Account } from './account.js';
import { AgentCloud, BuildHosts, LabHosts, Workspaces } from './compute.js';
import { Transport, type ClientOptions } from './http.js';
import { Objects } from './objects.js';
import { Policy, Snapshots, Templates, Traces, Webhooks } from './sandbox_admin.js';
import { Sandboxes } from './sandboxes.js';

/**
 * The Sandscale client. Every call goes to Sandscale's public API (https://api.sandscale.dev by
 * default) as the API key's or the signed-in person's own identity; the server decides what is
 * allowed, the SDK only carries the answer.
 *
 *     const sandscale = new Sandscale({ apiKey: process.env.SANDSCALE_API_KEY, region: 'eu' });
 *     const box = await sandscale.sandboxes.create({ template: 'builtin:python' });
 *     const run = await sandscale.sandboxes.run(box.id, 'python -V', { region: box.region, onStdout: process.stdout.write.bind(process.stdout) });
 */
export class Sandscale {
  readonly sandboxes: Sandboxes;
  readonly workspaces: Workspaces;
  readonly buildHosts: BuildHosts;
  /** The organization's snapshots (take one with `sandboxes.snapshot`). */
  readonly snapshots: Snapshots;
  readonly templates: Templates;
  /** The organization's sandbox policy: limits, egress allowlist and presets. */
  readonly policy: Policy;
  readonly webhooks: Webhooks;
  /** Run traces and the OpenTelemetry export. */
  readonly traces: Traces;
  /** Object storage: buckets, lifecycle, policy and access keys. */
  readonly objects: Objects;
  readonly labHosts: LabHosts;
  /** Background coding-agent tasks (need the person's own sign-in token). */
  readonly agentCloud: AgentCloud;
  /** Billing, usage, regions and API keys. */
  readonly account: Account;
  /** The transport, for the region and organization in use. */
  readonly transport: Transport;

  constructor(options: ClientOptions = {}) {
    this.transport = new Transport(options);
    this.sandboxes = new Sandboxes(this.transport);
    this.workspaces = new Workspaces(this.transport);
    this.buildHosts = new BuildHosts(this.transport, this.workspaces);
    this.snapshots = new Snapshots(this.transport);
    this.templates = new Templates(this.transport);
    this.policy = new Policy(this.transport);
    this.webhooks = new Webhooks(this.transport);
    this.traces = new Traces(this.transport);
    this.objects = new Objects(this.transport);
    this.labHosts = new LabHosts(this.transport);
    this.agentCloud = new AgentCloud(this.transport);
    this.account = new Account(this.transport);
  }
}

export { Sandboxes } from './sandboxes.js';
export type { RunEnd } from './sandboxes.js';
export { Workspaces, BuildHosts, LabHosts, AgentCloud } from './compute.js';
export { Snapshots, Templates, Policy, Webhooks, Traces, verifyWebhookSignature } from './sandbox_admin.js';
export { Objects } from './objects.js';
export { Account } from './account.js';
export { hideSecret } from './secret.js';
export type * from './models.js';
export type { Workspace, WorkspaceBuild, ConnectInfo, ListWorkspacesOptions, Lease, Pool, StartLeaseOptions, LeaseConnectInfo, SSHCertificate } from './compute.js';
export { Transport, DEFAULT_BASE_URL, SANDSCALE_REGION_URLS } from './http.js';
export type { ClientOptions, CallOptions, Region, TokenSource } from './http.js';
export * from './errors.js';
export type * from './types.js';
export { VERSION } from './version.js';
