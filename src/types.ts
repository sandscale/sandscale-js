// Copyright 2026 Neural Inverse
// SPDX-License-Identifier: Apache-2.0

import type { CallOptions, Region } from './http.js';
import type { SandscaleError } from './errors.js';

/** Every resource says which region it lives in, so later calls on it go there. */
export interface Regional {
  /** The region the call went to (undefined: the client's base URL, no region named). */
  region?: Region;
}

/** One region's page of a list: lists without a region read every live region. */
export interface RegionPage {
  region?: Region;
  nextCursor?: string;
  hasMore: boolean;
  /** Set when this region could not be read; the other regions' items are still returned. */
  error?: SandscaleError;
}

export interface ListResult<T> {
  data: T[];
  pages: RegionPage[];
}

export interface CreateSandboxOptions extends CallOptions {
  /** A template id of the organization, or a built-in ("builtin:base", "builtin:python", ...). */
  template?: string;
  /** Start from a snapshot instead. */
  snapshotId?: string;
  /** Size; with a template, nonzero values must match it (the server checks). */
  cpuCount?: number;
  memoryMb?: number;
  diskMb?: number;
  /** Seconds until the sandbox stops (server default 3600, at most 86400). */
  timeoutSeconds?: number;
  /** Network mode: `none` (default) or `allowlist` (the organization's egress allowlist and presets; not on every plan). */
  network?: string;
  /** An OCI image pinned by digest (`name@sha256:...`); the sandbox is placed on a worker that runs images of its own. */
  image?: string;
  /** The runtime to place the sandbox on (Sandscale organizations run on `firecracker`; the server refuses another with `runtime_not_available`). */
  runtime?: string;
  /** A cloud environment `launch-options` lists. */
  environmentId?: string;
  /** Plain environment variables. */
  env?: Record<string, string>;
  /**
   * Keystone Vault values for the sandbox's environment (`vault_env`): the server reads each as
   * the caller (Keystone Vault's capabilities and audit) and hands it to the sandbox only. The
   * values never pass through the SDK, the answer or an audit entry.
   */
  vaultEnv?: VaultEnvRef[];
  command?: string[];
  name?: string;
  labels?: Record<string, string>;
  /** `metadata.project_id` runs the sandbox in a project. */
  metadata?: Record<string, string>;
}

/** One Keystone Vault value of a sandbox's environment: variable `name` gets `field` of the secret at `path`. */
export interface VaultEnvRef {
  name: string;
  path: string;
  field: string;
}

export interface Sandbox extends Regional {
  id: string;
  status: string;
  name?: string;
  templateId?: string;
  cpuCount?: number;
  memoryMb?: number;
  timeoutSeconds?: number;
  labels?: Record<string, string>;
  statusReason?: string;
  createdAt?: Date;
  startedAt?: Date;
  terminatedAt?: Date;
  /** Whether pause and resume are possible now, as the server says. */
  suspend?: { canPause: boolean; canResume: boolean; reason?: string };
  /** The server's full answer. */
  raw: Record<string, unknown>;
}

export interface ListSandboxesOptions extends CallOptions {
  status?: string;
  projectId?: string;
  limit?: number;
  /** A cursor of one region's page; needs `region`. */
  cursor?: string;
}

export type OutputStream = 'stdout' | 'stderr';

export interface OutputChunk {
  stream: OutputStream;
  data: string;
  chunkIndex: number;
}

export interface RunOptions extends CallOptions {
  env?: Record<string, string>;
  /** /workspace (default) or a directory below it. */
  workdir?: string;
  /** Seconds the command may run (default 60). */
  timeoutSeconds?: number;
  /** Bytes piped to standard input. */
  stdin?: Uint8Array | string;
  /** Called with live output, in order, as the server releases it. */
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

export interface RunResult {
  runId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  oomKilled: boolean;
  timedOut: boolean;
  /** True when the output callbacks received live output; false when they got the final output at the end. */
  streamed: boolean;
}

export interface FileEntry {
  path: string;
  name: string;
  isDir: boolean;
  size?: number;
}

export interface Snapshot extends Regional {
  id: string;
  instanceId: string;
  status: 'creating' | 'ready' | 'failed' | string;
  label: string;
  sizeBytes: number;
  sha256?: string;
  createdAt?: Date;
  expiresAt?: Date;
  failure?: string;
  raw: Record<string, unknown>;
}
