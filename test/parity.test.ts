// Copyright 2026 Neural Inverse
// SPDX-License-Identifier: Apache-2.0

// Parity with the server's Sandscale API: every call of the SDK's later services against a mock
// server answering the shapes the server documents (docs/sandbox, docs/cloud, the OpenAPI spec).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EntitlementError,
  Sandscale,
  SandboxWakingError,
  ServerError,
  ServiceUnavailableError,
  verifyWebhookSignature,
} from '../src/index.js';
import { MockServer, errorBody, send } from './mock.js';

const ORG = 'org-1';
let api: MockServer;
let sleeps: number[];

function client(): Sandscale {
  const c = new Sandscale({ apiKey: 'ssk_test', baseUrl: api.url, orgId: ORG, regionUrls: { us: api.url } });
  c.transport.sleep = async (ms) => void sleeps.push(ms);
  return c;
}
const body = (i = 0): Record<string, unknown> => JSON.parse(api.requests[i].body) as Record<string, unknown>;

beforeEach(async () => {
  api = await new MockServer().start();
  sleeps = [];
});
const seen = new Set<string>();
afterEach(async () => {
  for (const r of api.requests) if (!r.route.endsWith('(unrouted)') && !r.route.includes('/api/v1/regions')) seen.add(r.route);
  await api.stop();
});

describe('sandboxes.create', () => {
  it('sends network, image, runtime and environment', async () => {
    api.json('POST', '/api/v1/sandbox/instances', 201, { id: 'sb', status: 'running' });
    await client().sandboxes.create({ network: 'allowlist', image: 'ghcr.io/x/y@sha256:abc', runtime: 'firecracker', environmentId: 'env-1' });
    expect(body()).toEqual({ network: 'allowlist', image: 'ghcr.io/x/y@sha256:abc', runtime: 'firecracker', environment_id: 'env-1' });
  });
});

describe('ports, preview links and SSH', () => {
  const exposure = {
    id: 'ex-1', instance_id: 'sb', port: 8080, protocol: 'tcp', status: 'open', created_by: 'u', created_at: '2026-11-18T00:00:00Z',
    expires_at: '2026-11-18T01:00:00Z', connect_path: '/api/v1/sandbox/instances/sb/ports/ex-1/connect', subprotocol: 'keystone-port-forward.v1',
  };
  const link = { id: 'l-1', instance_id: 'sb', exposure_id: 'ex-1', port: 8080, visibility: 'team', url: 'https://k3x.preview.sandscale.app/', status: 'active', created_by: 'u', created_at: '2026-11-18T00:00:00Z', expires_at: '2026-11-18T01:00:00Z' };

  it('exposes, lists and closes a port', async () => {
    api.json('POST', '/api/v1/sandbox/instances/{}/ports', 201, exposure);
    api.json('GET', '/api/v1/sandbox/instances/{}/ports', 200, { ports: [exposure] });
    api.json('DELETE', '/api/v1/sandbox/instances/{}/ports/{}', 204, undefined);
    const c = client();
    const e = await c.sandboxes.exposePort('sb', 8080, { ttlSeconds: 600 });
    expect(body()).toEqual({ port: 8080, ttl_seconds: 600 });
    expect(e).toMatchObject({ id: 'ex-1', port: 8080, status: 'open', connectPath: exposure.connect_path, subprotocol: 'keystone-port-forward.v1' });
    expect(e.expiresAt).toEqual(new Date('2026-11-18T01:00:00Z'));
    expect((await c.sandboxes.listPorts('sb'))[0].id).toBe('ex-1');
    await c.sandboxes.closePort('sb', 8080);
    expect(api.requests[2].path).toBe('/api/v1/sandbox/instances/sb/ports/8080');
  });

  it('creates, lists and revokes preview links', async () => {
    api.json('POST', '/api/v1/sandbox/instances/{}/ports/{}/preview-links', 201, link);
    api.json('GET', '/api/v1/sandbox/instances/{}/preview-links', 200, { preview_links: [link] });
    api.json('DELETE', '/api/v1/sandbox/instances/{}/preview-links/{}', 204, undefined);
    const c = client();
    const l = await c.sandboxes.createPreviewLink('sb', 'ex-1', { visibility: 'team', ttlSeconds: 300 });
    expect(body()).toEqual({ visibility: 'team', ttl_seconds: 300 });
    expect(l).toMatchObject({ id: 'l-1', exposureId: 'ex-1', visibility: 'team', url: link.url, status: 'active' });
    expect(await c.sandboxes.listPreviewLinks('sb')).toHaveLength(1);
    await c.sandboxes.revokePreviewLink('sb', 'l-1');
    expect(api.requests[2].method).toBe('DELETE');
  });

  it('reads SSH info and a certificate', async () => {
    const info = { host: 'sb.ssh', user: 'sandbox', known_hosts: 'sb ssh-ed25519 AAAA', host_key_sha256: 'SHA256:x', certificate_path: '/c', connect_path: '/c2', subprotocol: 'keystone-ssh.v1', cert_ttl_seconds: 600 };
    api.json('GET', '/api/v1/sandbox/instances/{}/ssh', 200, info);
    api.json('POST', '/api/v1/sandbox/instances/{}/ssh/certificate', 200, { ...info, certificate: 'ssh-ed25519-cert-v01@openssh.com AAAA', serial: '7', key_id: 'u:sb:7', valid_before: '2026-11-18T00:10:00Z' });
    const c = client();
    expect(await c.sandboxes.sshInfo('sb')).toMatchObject({ host: 'sb.ssh', knownHosts: 'sb ssh-ed25519 AAAA', certTtlSeconds: 600 });
    const cert = await c.sandboxes.sshCertificate('sb', 'ssh-ed25519 AAAA');
    expect(body(1)).toEqual({ public_key: 'ssh-ed25519 AAAA' });
    expect(cert).toMatchObject({ serial: '7', keyId: 'u:sb:7', subprotocol: 'keystone-ssh.v1' });
    expect(cert.validBefore).toEqual(new Date('2026-11-18T00:10:00Z'));
  });
});

describe('snapshots and templates', () => {
  const snap = { id: 's-1', instance_id: 'sb', status: 'ready', label: 'before', size_bytes: 10, created_at: '2026-11-18T00:00:00Z' };

  it('lists, gets and deletes organization snapshots with the usage', async () => {
    api.json('GET', '/api/v1/sandbox/snapshots', 200, { snapshots: [snap], usage: { count: 1, bytes: 10 } });
    api.json('GET', '/api/v1/sandbox/snapshots/{}', 200, snap);
    api.json('DELETE', '/api/v1/sandbox/snapshots/{}', 204, undefined);
    const c = client();
    const list = await c.snapshots.list({ region: 'us', limit: 5 });
    expect(api.requests[0].query.get('limit')).toBe('5');
    expect(list.data[0]).toMatchObject({ id: 's-1', status: 'ready', sizeBytes: 10 });
    expect(list.usage).toEqual({ count: 1, bytes: 10 });
    expect((await c.snapshots.get('s-1')).label).toBe('before');
    await c.snapshots.delete('s-1');
    expect(api.requests[2].method).toBe('DELETE');
  });

  it('creates, lists, gets, deletes templates and reads the build status', async () => {
    const tpl = { id: 't-1', name: 'py', version: '0.1.0', status: 'building', disk_size_mb: 2048, mem_size_mb: 512, cpu_count: 1, image: 'img@sha256:1', created_at: '2026-11-18T00:00:00Z' };
    api.json('POST', '/api/v1/sandbox/templates', 201, tpl);
    api.json('GET', '/api/v1/sandbox/templates', 200, { data: [tpl], has_more: false });
    api.json('GET', '/api/v1/sandbox/templates/{}', 200, tpl);
    api.json('DELETE', '/api/v1/sandbox/templates/{}', 204, undefined);
    api.json('GET', '/api/v1/sandbox/templates/{}/build-status', 200, { status: 'building', progress_percent: 50 });
    const c = client();
    const t = await c.templates.create({ name: 'py', image: 'img@sha256:1', diskMb: 2048, memoryMb: 512, cpuCount: 1, region: 'us' });
    expect(body()).toEqual({ name: 'py', image: 'img@sha256:1', disk_size_mb: 2048, mem_size_mb: 512, cpu_count: 1 });
    expect(t).toMatchObject({ id: 't-1', status: 'building', diskSizeMb: 2048, image: 'img@sha256:1' });
    expect((await c.templates.list({ region: 'us' })).data).toHaveLength(1);
    expect((await c.templates.get('t-1')).name).toBe('py');
    expect(await c.templates.buildStatus('t-1')).toEqual({ status: 'building', progressPercent: 50 });
    await c.templates.delete('t-1');
  });
});

describe('policy', () => {
  const policy = {
    max_concurrent: 5, max_exec_time_sec: 300, max_mem_mb: 4096, max_cpu: 4, max_disk_mb: null, max_workspaces_per_user: null,
    max_cpu_cores_per_user: null, max_memory_gb_per_user: null, egress_allowlist: ['pypi.org'], allowed_providers: [], egress_presets: ['npm'],
  };

  it('reads the policy', async () => {
    api.json('GET', '/api/v1/sandbox/policy', 200, policy);
    const p = await client().policy.get();
    expect(p).toMatchObject({ maxConcurrent: 5, maxExecTimeSeconds: 300, maxMemoryMb: 4096, maxDiskMb: null, egressAllowlist: ['pypi.org'], egressPresets: ['npm'] });
    expect(p.hibernation).toBeUndefined();
  });

  it('sends only the members set, with the egress allowlist and presets', async () => {
    api.json('PUT', '/api/v1/sandbox/policy', 200, { ...policy, egress_allowlist: ['pypi.org', 'github.com'], egress_presets: ['npm', 'pypi'] });
    const p = await client().policy.set({ egressAllowlist: ['pypi.org', 'github.com'], egressPresets: ['npm', 'pypi'], maxExecTimeSeconds: 600 });
    expect(body()).toEqual({ egress_allowlist: ['pypi.org', 'github.com'], egress_presets: ['npm', 'pypi'], max_exec_time_sec: 600 });
    expect(p.egressPresets).toEqual(['npm', 'pypi']);
  });

  it('reads and sets the hibernation setting', async () => {
    api.json('GET', '/api/v1/sandbox/policy', 200, { ...policy, hibernation: 'default' });
    api.json('PUT', '/api/v1/sandbox/policy', 200, { ...policy, hibernation: 'off' });
    const c = client();
    expect((await c.policy.get()).hibernation).toBe('default');
    expect((await c.policy.set({ hibernation: 'off' })).hibernation).toBe('off');
    expect(body(1)).toEqual({ hibernation: 'off' });
  });
});

describe('webhooks', () => {
  const wh = { id: 'w-1', org_id: ORG, url: 'https://example.com/hook', events: ['run.completed'], secret: '********', active: true, created_at: '2026-11-18T00:00:00Z', updated_at: '2026-11-18T00:00:00Z' };

  it('lists, creates (secret shown once, hidden from output) and deletes', async () => {
    api.json('GET', '/api/v1/sandbox/webhooks', 200, { webhooks: [wh] });
    api.json('POST', '/api/v1/sandbox/webhooks', 201, { ...wh, secret: 'whsec_once', secret_shown_once: true });
    api.json('DELETE', '/api/v1/sandbox/webhooks/{}', 204, undefined);
    const c = client();
    const [listed] = await c.webhooks.list();
    expect(listed).toMatchObject({ id: 'w-1', url: wh.url, events: ['run.completed'], active: true });
    expect(JSON.stringify(listed)).not.toContain('********');
    const created = await c.webhooks.create({ url: wh.url, events: ['run.completed'] });
    expect(body(1)).toEqual({ url: wh.url, events: ['run.completed'] });
    expect(created.secret).toBe('whsec_once');
    expect(JSON.stringify(created)).not.toContain('whsec_once');
    expect(Object.keys(created)).not.toContain('secret');
    expect(JSON.stringify(created.raw)).not.toContain('whsec_once');
    await c.webhooks.delete('w-1');
  });

  it('verifies the signature of a delivery', async () => {
    const secret = 'whsec_once';
    const payload = JSON.stringify({ id: 'e-1', type: 'run.completed' });
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
    const sig = `sha256=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    expect(await verifyWebhookSignature(sig, payload, secret)).toBe(true);
    expect(await verifyWebhookSignature(sig, new TextEncoder().encode(payload), secret)).toBe(true);
    expect(await verifyWebhookSignature(sig, payload + ' ', secret)).toBe(false);
    expect(await verifyWebhookSignature(sig, payload, 'other')).toBe(false);
    expect(await verifyWebhookSignature(sig.slice(0, -2), payload, secret)).toBe(false);
    expect(await verifyWebhookSignature('sha256=zz', payload, secret)).toBe(false);
    expect(await verifyWebhookSignature('md5=abc', payload, secret)).toBe(false);
    expect(await verifyWebhookSignature(undefined, payload, secret)).toBe(false);
  });
});

describe('run traces', () => {
  const summary = { trace_id: 'a'.repeat(32), start_time: '2026-11-18T00:00:00Z', end_time: '2026-11-18T00:01:00Z', duration_ms: 60000, spans: 2, errors: 1, sandboxes: ['sb'], vcpu_hours: 0.1, usd: 0.02, status: 'error' };
  const span = {
    trace_id: summary.trace_id, span_id: 'b'.repeat(16), kind: 'command', name: 'pytest', status: 'error', start_time: '2026-11-18T00:00:01Z', duration_ms: 900, audit_entry_id: 'au-1',
    command: { run_id: 'r-1', argv: ['pytest'], exit_code: 1, output_bytes: 42, oom_killed: false, timed_out: false },
    files: [{ path: '/workspace/a.py', sha256: 'f'.repeat(64), size_bytes: 3 }], box: { sandbox_id: 'sb', vcpu: 2, memory_mb: 512, region: 'us1' }, cost: { vcpu_hours: 0.01, usd: 0.001 }, dlp_rules: ['aws_key'],
  };

  it('lists and reads traces', async () => {
    api.json('GET', '/api/v1/sandbox/traces', 200, { data: [summary], has_more: false });
    api.json('GET', '/api/v1/sandbox/traces/{}', 200, { ...summary, span_list: [span], hidden_spans: 1, truncated: false, events: [{ id: 'e', ts: '2026-11-18T00:00:02Z', source: 'edr', type: 'alert', severity: 'high' }] });
    const c = client();
    const list = await c.traces.list({ region: 'us', sandboxId: 'sb', from: new Date('2026-11-17T00:00:00Z'), limit: 10 });
    expect(api.requests[0].query.get('sandbox_id')).toBe('sb');
    expect(api.requests[0].query.get('from')).toBe('2026-11-17T00:00:00.000Z');
    expect(list.data[0]).toMatchObject({ traceId: summary.trace_id, spans: 2, errors: 1, status: 'error', vcpuHours: 0.1 });
    const t = await c.traces.get(summary.trace_id);
    expect(t.hiddenSpans).toBe(1);
    expect(t.spanList[0]).toMatchObject({ kind: 'command', command: { exitCode: 1, argv: ['pytest'] }, dlpRules: ['aws_key'], cost: { usd: 0.001 }, box: { sandboxId: 'sb', vcpu: 2 } });
    expect(t.spanList[0].files[0].path).toBe('/workspace/a.py');
    expect(t.events[0]).toMatchObject({ source: 'edr', severity: 'high' });
  });

  it('manages the OTLP export', async () => {
    const exp = { enabled: true, protocol: 'otlp_http', endpoint: 'https://otel.example.com', header_names: ['DD-API-KEY'], state: 'active', consecutive_failures: 0, exported_spans: 7, updated_at: '2026-11-18T00:00:00Z' };
    api.json('GET', '/api/v1/sandbox/trace-export', 200, exp);
    api.json('PUT', '/api/v1/sandbox/trace-export', 200, exp);
    api.json('DELETE', '/api/v1/sandbox/trace-export', 204, undefined);
    api.json('POST', '/api/v1/sandbox/trace-export/test', 200, { ok: false, error: 'endpoint refused the span' });
    const c = client();
    expect(await c.traces.getExport()).toMatchObject({ enabled: true, headerNames: ['DD-API-KEY'], exportedSpans: 7 });
    const set = await c.traces.setExport({ protocol: 'otlp_http', endpoint: 'https://otel.example.com', headers: { 'DD-API-KEY': 'super-secret' } });
    expect(body(1)).toEqual({ protocol: 'otlp_http', endpoint: 'https://otel.example.com', headers: { 'DD-API-KEY': 'super-secret' } });
    expect(JSON.stringify(set)).not.toContain('super-secret');
    await c.traces.deleteExport();
    expect(await c.traces.testExport()).toEqual({ ok: false, traceId: undefined, error: 'endpoint refused the span' });
  });
});

describe('object storage', () => {
  const bucket = {
    Name: 'logs', Region: 'us1', Versioning: 'Enabled', ObjectLock: false, Encryption: 'sse', KeyRef: '', ContentClass: 'standard', DataEvents: 'off', Presign: true,
    AllowUnsignedPayload: false, HasPolicy: false, Tags: { env: 'prod' }, CreatedAt: '2026-11-18T00:00:00Z', Endpoints: { PathStyle: 'https://s3.us1.example.com', SigningRegion: 'us-east-1' },
    Usage: { Keys: 3, Versions: 3, Bytes: 100, Uploads: 0, ReportedAt: '2026-11-18T00:00:00Z' },
  };

  it('manages buckets', async () => {
    api.json('POST', '/api/v1/svc/objects/CreateBucket', 200, bucket);
    api.json('POST', '/api/v1/svc/objects/ListBuckets', 200, { Buckets: [bucket], NextToken: 'n' });
    api.json('POST', '/api/v1/svc/objects/DescribeBucket', 200, bucket);
    api.json('POST', '/api/v1/svc/objects/UpdateBucket', 200, { ...bucket, Versioning: 'Suspended' });
    api.json('POST', '/api/v1/svc/objects/DeleteBucket', 200, {});
    const c = client();
    const b = await c.objects.createBucket({ name: 'logs', versioning: 'Enabled', tags: { env: 'prod' }, defaultRetention: { mode: 'GOVERNANCE', days: 30 }, clientToken: 'tok' });
    expect(body()).toEqual({ Name: 'logs', Versioning: 'Enabled', Tags: { env: 'prod' }, DefaultRetention: { Mode: 'GOVERNANCE', Days: 30 }, ClientToken: 'tok' });
    expect(b).toMatchObject({ name: 'logs', versioning: 'Enabled', tags: { env: 'prod' }, endpoints: { pathStyle: 'https://s3.us1.example.com', signingRegion: 'us-east-1' }, usage: { keys: 3, bytes: 100 } });
    const list = await c.objects.listBuckets({ maxResults: 10 });
    expect(list).toMatchObject({ nextToken: 'n' });
    expect(list.buckets[0].name).toBe('logs');
    expect((await c.objects.getBucket('logs')).name).toBe('logs');
    expect(body(2)).toEqual({ Name: 'logs' });
    const u = await c.objects.updateBucket('logs', { versioning: 'Suspended', clearDefaultRetention: true });
    expect(body(3)).toEqual({ Name: 'logs', Versioning: 'Suspended', ClearDefaultRetention: true });
    expect(u.versioning).toBe('Suspended');
    await c.objects.deleteBucket('logs');
    expect(api.requests[4].path).toBe('/api/v1/svc/objects/DeleteBucket');
  });

  it('manages lifecycle and policy', async () => {
    api.json('POST', '/api/v1/svc/objects/PutBucketLifecycle', 200, {});
    api.json('POST', '/api/v1/svc/objects/GetBucketLifecycle', 200, { Rules: [{ ID: 'r', Prefix: 'tmp/', Status: 'Enabled', Expiration: { Days: 7 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }] });
    api.json('POST', '/api/v1/svc/objects/DeleteBucketLifecycle', 200, {});
    api.json('POST', '/api/v1/svc/objects/PutBucketPolicy', 200, {});
    api.json('POST', '/api/v1/svc/objects/GetBucketPolicy', 200, { Policy: '{"Version":"2012-10-17"}' });
    api.json('POST', '/api/v1/svc/objects/DeleteBucketPolicy', 200, {});
    const c = client();
    await c.objects.putLifecycle('logs', [{ id: 'r', prefix: 'tmp/', status: 'Enabled', expirationDays: 7, abortIncompleteMultipartUploadDays: 1 }]);
    expect(body()).toEqual({ Name: 'logs', Rules: [{ ID: 'r', Status: 'Enabled', Prefix: 'tmp/', Expiration: { Days: 7 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }] });
    expect(await c.objects.getLifecycle('logs')).toEqual([
      { id: 'r', prefix: 'tmp/', status: 'Enabled', expirationDays: 7, noncurrentVersionExpiration: undefined, expiredObjectDeleteMarker: undefined, abortIncompleteMultipartUploadDays: 1 },
    ]);
    await c.objects.deleteLifecycle('logs');
    await c.objects.putPolicy('logs', { Version: '2012-10-17' });
    expect(body(3)).toEqual({ Name: 'logs', Policy: '{"Version":"2012-10-17"}' });
    expect(await c.objects.getPolicy('logs')).toBe('{"Version":"2012-10-17"}');
    await c.objects.deletePolicy('logs');
  });

  it('creates an access key whose secret is shown once and never printed', async () => {
    const key = { AccessKeyId: 'AKIA1', Principal: 'u', Description: 'ci', Status: 'Active', CreatedAt: '2026-11-18T00:00:00Z', Permissions: ['read'], Buckets: ['logs'], Prefixes: [], CIDRs: [] };
    api.json('POST', '/api/v1/svc/objects/CreateAccessKey', 200, { AccessKey: key, SecretAccessKey: 'wJalrXUtnFEMI-secret' });
    api.json('POST', '/api/v1/svc/objects/ListAccessKeys', 200, { AccessKeys: [{ ...key, SecretAccessKey: 'leak' }], CanManageAll: false });
    api.json('POST', '/api/v1/svc/objects/UpdateAccessKey', 200, {});
    api.json('POST', '/api/v1/svc/objects/DeleteAccessKey', 200, {});
    const c = client();
    const created = await c.objects.createAccessKey({ description: 'ci', expiresInDays: 30, permissions: ['read'], buckets: ['logs'], cidrs: ['10.0.0.0/8'] });
    expect(body()).toEqual({ Description: 'ci', ExpiresInDays: 30, Permissions: ['read'], Buckets: ['logs'], CIDRs: ['10.0.0.0/8'] });
    expect(created.accessKey).toMatchObject({ accessKeyId: 'AKIA1', status: 'Active', buckets: ['logs'] });
    expect(created.secretAccessKey).toBe('wJalrXUtnFEMI-secret');
    for (const text of [JSON.stringify(created), JSON.stringify(created.accessKey), JSON.stringify({ ...created })]) expect(text).not.toContain('wJalrXUtnFEMI-secret');
    const keys = await c.objects.listAccessKeys({ all: true });
    expect(JSON.stringify(keys)).not.toContain('leak');
    await c.objects.updateAccessKey('AKIA1', 'Inactive');
    expect(body(2)).toEqual({ AccessKeyId: 'AKIA1', Status: 'Inactive' });
    await c.objects.deleteAccessKey('AKIA1');
  });

  it('reads the limits', async () => {
    api.json('POST', '/api/v1/svc/objects/DescribeObjectsLimits', 200, { Enabled: true, Region: 'us1', Quotas: [{ QuotaCode: 'storage', Name: 'Storage', Value: 100, Used: 5 }], Features: { versioning: { Available: true } } });
    const l = await client().objects.limits();
    expect(l).toMatchObject({ enabled: true, region: 'us1', quotas: [{ quotaCode: 'storage', value: 100, used: 5 }], features: { versioning: { available: true } } });
  });
});

describe('workspaces', () => {
  const ws = { id: 'w-1', name: 'dev', status: 'stopped', template_id: 't', owner_id: 'u' };
  const build = { id: 'b-1', workspace_id: 'w-1', state: 'pending', build_number: 1 };

  it('creates, updates, rebuilds and deletes', async () => {
    api.json('POST', '/api/v1/orgs/{}/workspaces', 201, { workspace: ws, build });
    api.json('PATCH', '/api/v1/orgs/{}/workspaces/{}', 200, { ...ws, name: 'renamed' });
    api.json('POST', '/api/v1/orgs/{}/workspaces/{}/rebuild', 202, build);
    api.json('DELETE', '/api/v1/orgs/{}/workspaces/{}', 204, undefined);
    const c = client();
    const created = await c.workspaces.create({ name: 'dev', templateId: 't', repository: 'github.com/acme/app', ttlSeconds: 3600, parameters: { a: 'b' } });
    expect(body()).toEqual({ name: 'dev', template_id: 't', repository: 'github.com/acme/app', ttl_seconds: 3600, parameters: { a: 'b' } });
    expect(created.workspace.id).toBe('w-1');
    expect(created.build).toMatchObject({ id: 'b-1', state: 'pending', buildNumber: 1 });
    expect((await c.workspaces.update('w-1', { name: 'renamed', idleTimeoutSeconds: 600 })).name).toBe('renamed');
    expect(body(1)).toEqual({ name: 'renamed', idle_timeout_seconds: 600 });
    expect((await c.workspaces.rebuild('w-1', { templateVersionId: 'v2' })).id).toBe('b-1');
    expect(body(2)).toEqual({ template_version_id: 'v2' });
    await c.workspaces.delete('w-1');
    expect(api.requests[3].path).toBe(`/api/v1/orgs/${ORG}/workspaces/w-1`);
  });

  it('builds the open-in-IDE link', async () => {
    api.json('GET', '/api/v1/orgs/{}/workspaces/{}/open', 200, { ide: 'vscode', kind: 'deeplink', url: 'vscode://x', ssh_host: 'h', folder: '/home/u', requires: ['config-ssh'] });
    const l = await client().workspaces.openLink('w-1', 'vscode');
    expect(api.requests[0].query.get('ide')).toBe('vscode');
    expect(l).toMatchObject({ ide: 'vscode', kind: 'deeplink', url: 'vscode://x', sshHost: 'h', requires: ['config-ssh'] });
  });

  it('lists, creates and verifies backups', async () => {
    const backup = { id: 'bk-1', workspace_id: 'w-1', type: 'snapshot', status: 'completed', size: 100, checksum: 'abc', created_at: '2026-11-18T00:00:00Z' };
    api.json('GET', '/api/v1/orgs/{}/workspaces/{}/backups', 200, { backups: [backup], count: 1 });
    api.json('POST', '/api/v1/orgs/{}/workspaces/{}/backups', 201, backup);
    api.json('POST', '/api/v1/orgs/{}/backups/{}/verify', 200, { backup_id: 'bk-1', valid: true, checksum_match: true, verified_at: '2026-11-18T00:01:00Z' });
    const c = client();
    expect((await c.workspaces.listBackups('w-1', { limit: 5 }))[0]).toMatchObject({ id: 'bk-1', size: 100, checksum: 'abc' });
    expect(api.requests[0].query.get('limit')).toBe('5');
    expect((await c.workspaces.createBackup('w-1')).status).toBe('completed');
    expect(await c.workspaces.verifyBackup('bk-1')).toMatchObject({ backupId: 'bk-1', valid: true, checksumMatch: true, errors: [] });
  });

  it('lists and shares apps', async () => {
    api.json('GET', '/api/v1/orgs/{}/workspaces/{}/apps', 200, { apps: [{ slug: 'web', display_name: 'Web', port: 3000, share: 'owner', effective_share: 'owner', can_open: true, share_levels: ['owner', 'members'] }], policy: {} });
    api.json('PATCH', '/api/v1/orgs/{}/workspaces/{}/apps/{}/share', 200, { slug: 'web', share: 'members', effective_share: 'members' });
    const c = client();
    expect((await c.workspaces.listApps('w-1'))[0]).toMatchObject({ slug: 'web', displayName: 'Web', port: 3000, canOpen: true, shareLevels: ['owner', 'members'] });
    expect(await c.workspaces.shareApp('w-1', 'web', 'members')).toMatchObject({ slug: 'web', share: 'members', effectiveShare: 'members' });
    expect(body(1)).toEqual({ share: 'members' });
  });
});

describe('build hosts and lab hosts', () => {
  const lease = { id: 'l-1', pool_id: 'p-1', state: 'active', created_at: '2026-11-18T00:00:00Z' };

  it('renews, kills and reads runs, artifacts and caches', async () => {
    api.json('POST', '/api/v1/orgs/{}/build/leases/{}/renew', 200, lease);
    api.json('POST', '/api/v1/orgs/{}/build/leases/{}/kill', 200, { ...lease, state: 'ended', end_reason: 'killed' });
    api.json('GET', '/api/v1/orgs/{}/build/leases/{}/runs', 200, { runs: [{ id: 'r-1', lease_id: 'l-1', argv: ['make'], command: 'make', state: 'finished', exit_code: 0, duration_ms: 12, started_at: '2026-11-18T00:00:00Z' }] });
    api.json('GET', '/api/v1/orgs/{}/build/leases/{}/runs/{}', 200, { id: 'r-1', lease_id: 'l-1', argv: ['make'], command: 'make', state: 'finished', exit_code: 0 });
    api.json('GET', '/api/v1/orgs/{}/build/leases/{}/artifacts', 200, { artifacts: [{ id: 'a-1', lease_id: 'l-1', name: 'out.tgz', size_bytes: 5, sha256: 'ab', created_at: '2026-11-18T00:00:00Z' }] });
    api.json('GET', '/api/v1/orgs/{}/build/leases/{}/artifacts/{}', 200, { id: 'a-1', lease_id: 'l-1', name: 'out.tgz', size_bytes: 5, sha256: 'ab' });
    api.on('GET', '/api/v1/orgs/{}/build/leases/{}/artifacts/{}/content', (_r, res) => void res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(Buffer.from([1, 2, 3])));
    api.json('DELETE', '/api/v1/orgs/{}/build/leases/{}/artifacts/{}', 204, undefined);
    const cache = { name: 'npm', scope: 'pool', max_bytes: 1000, used_bytes: 10, entries: [{ id: 'c-1', cache: 'npm', key: 'k', scope: 'pool', size_bytes: 10, sha256: 'ab' }] };
    api.json('GET', '/api/v1/orgs/{}/build/leases/{}/caches', 200, { caches: [cache] });
    api.json('GET', '/api/v1/orgs/{}/build/pools/{}/caches', 200, { caches: [cache] });
    api.json('DELETE', '/api/v1/orgs/{}/build/pools/{}/caches/{}', 204, undefined);
    const c = client();
    expect((await c.buildHosts.renew('l-1', 3600)).id).toBe('l-1');
    expect(body()).toEqual({ ttl_seconds: 3600 });
    expect((await c.buildHosts.kill('l-1', { reason: 'abuse' })).state).toBe('ended');
    expect(body(1)).toEqual({ reason: 'abuse' });
    expect((await c.buildHosts.listRuns('l-1'))[0]).toMatchObject({ id: 'r-1', argv: ['make'], exitCode: 0, durationMs: 12 });
    expect((await c.buildHosts.getRun('l-1', 'r-1')).state).toBe('finished');
    expect((await c.buildHosts.listArtifacts('l-1'))[0]).toMatchObject({ id: 'a-1', name: 'out.tgz', sizeBytes: 5 });
    expect((await c.buildHosts.getArtifact('l-1', 'a-1')).sha256).toBe('ab');
    expect([...(await c.buildHosts.downloadArtifact('l-1', 'a-1'))]).toEqual([1, 2, 3]);
    await c.buildHosts.deleteArtifact('l-1', 'a-1');
    expect((await c.buildHosts.listCaches('l-1'))[0]).toMatchObject({ name: 'npm', maxBytes: 1000, usedBytes: 10, entries: [{ id: 'c-1', key: 'k', sizeBytes: 10 }] });
    expect((await c.buildHosts.listPoolCaches('p-1'))).toHaveLength(1);
    await c.buildHosts.purgePoolCache('p-1', 'npm');
    expect(api.requests.at(-1)!.path).toBe(`/api/v1/orgs/${ORG}/build/pools/p-1/caches/npm`);
  });

  it('lists, reads and revokes lab hosts', async () => {
    const host = { id: 'h-1', name: 'mac1', status: 'online', labels: { os: 'mac' }, pool_ids: ['p-1'], max_leases: 2, disabled: false, hostname: 'mac1.lan', os: 'darwin', arch: 'arm64', health: 'ok', active_leases: 1 };
    api.json('GET', '/api/v1/orgs/{}/build/lab-hosts', 200, { lab_hosts: [host] });
    api.json('GET', '/api/v1/orgs/{}/build/lab-hosts/{}', 200, host);
    api.json('POST', '/api/v1/orgs/{}/build/lab-hosts/{}/revoke', 200, { ...host, status: 'revoked', disabled: true });
    const c = client();
    expect((await c.labHosts.list({ region: 'us' })).data[0]).toMatchObject({ id: 'h-1', labels: { os: 'mac' }, poolIds: ['p-1'], activeLeases: 1 });
    expect((await c.labHosts.get('h-1')).hostname).toBe('mac1.lan');
    const r = await c.labHosts.revoke('h-1', { reason: 'lost' });
    expect(body(2)).toEqual({ reason: 'lost' });
    expect(r).toMatchObject({ status: 'revoked', disabled: true });
  });
});

describe('Agent Cloud tasks (Keystone lead routes)', () => {
  const task = { id: 'lt-1', lead_grant_id: 'g-1', state: 'queued', engine: 'claude_code', mode: 'edit', repository: 'github.com/acme/app', attempts: 0, created_at: '2026-11-18T00:00:00Z' };

  it('creates, lists, gets and cancels under the current grant', async () => {
    api.json('POST', '/api/v1/orgs/{}/build/leads/{}/tasks', 201, task);
    api.json('GET', '/api/v1/orgs/{}/build/leads/{}/tasks', 200, { tasks: [task] });
    api.json('GET', '/api/v1/orgs/{}/build/leads/{}/tasks/{}', 200, task);
    api.json('POST', '/api/v1/orgs/{}/build/leads/{}/tasks/{}/stop', 200, { ...task, state: 'cancelled', end_reason: 'stopped_by_lead' });
    const c = client();
    const t = await c.agentCloud.createTask({ repository: 'github.com/acme/app', brief: 'fix the flaky test', engine: 'claude_code', mode: 'edit', governanceMode: 'enforce', target: 'pool', poolId: 'p-1' });
    expect(api.requests[0].path).toBe(`/api/v1/orgs/${ORG}/build/leads/current/tasks`);
    expect(body()).toEqual({ repository: 'github.com/acme/app', brief: 'fix the flaky test', engine: 'claude_code', mode: 'edit', governance_mode: 'enforce', target: 'pool', pool_id: 'p-1' });
    expect(t).toMatchObject({ id: 'lt-1', state: 'queued', engine: 'claude_code', leadGrantId: 'g-1' });
    expect((await c.agentCloud.listTasks({ state: 'open', limit: 5 }))[0].id).toBe('lt-1');
    expect(api.requests[1].query.get('state')).toBe('open');
    expect((await c.agentCloud.getTask('lt-1', { grantId: 'g-1' })).state).toBe('queued');
    expect(api.requests[2].path).toBe(`/api/v1/orgs/${ORG}/build/leads/g-1/tasks/lt-1`);
    const cancelled = await c.agentCloud.cancelTask('lt-1');
    expect(cancelled).toMatchObject({ state: 'cancelled', endReason: 'stopped_by_lead' });
  });

  it('is refused for an API key with the server person_required code', async () => {
    api.json('POST', '/api/v1/orgs/{}/build/leads/{}/tasks', 403, errorBody('person_required', 'only a person may lead'));
    const err = await client().agentCloud.createTask({ repository: 'r', brief: 'b', engine: 'codex' }).catch((e) => e);
    expect(err.code).toBe('person_required');
    expect(err.status).toBe(403);
  });
});

describe('account', () => {
  const offer = { plan: 'pro', name: 'Pro', monthly_minor: 2500, annual_monthly_minor: 2000, currency: 'USD', per_seat: false, included_vcpu_hours: 750, max_concurrent_boxes: 20, max_vcpu_per_box: 8, network_egress: true, max_lease_hours: 4, object_storage_gb: 50, overage_allowed: true, overage_minor_per_vcpu_hour: 6, features: ['workspaces'] };
  const state = { plan: 'pro', interval: 'month', paid_seats: 1, overage_enabled: false, cancel_at_period_end: false, current_period_end: '2026-12-01T00:00:00Z' };

  it('reads the billing page', async () => {
    api.json('GET', '/api/v1/orgs/{}/sandscale/billing', 200, { state, offer, balance: { month: '2026-11', resets_at: '2026-12-01T00:00:00Z', included_vcpu_hours: '750', used_vcpu_hours: '10', remaining_vcpu_hours: '740', overage_vcpu_hours: '0' }, plans: [offer] });
    const b = await client().account.billing();
    expect(api.requests[0].path).toBe(`/api/v1/orgs/${ORG}/sandscale/billing`);
    expect(b.state).toMatchObject({ plan: 'pro', interval: 'month', paidSeats: 1, overageEnabled: false });
    expect(b.offer).toMatchObject({ plan: 'pro', monthlyMinor: 2500, includedVcpuHours: 750, overageMinorPerVcpuHour: 6 });
    expect(b.balance).toMatchObject({ month: '2026-11', remainingVcpuHours: '740' });
    expect(b.plans).toHaveLength(1);
  });

  it('changes the plan, switches overage, withdraws a downgrade and starts a checkout (the server decides)', async () => {
    api.json('POST', '/api/v1/orgs/{}/sandscale/billing/plan', 200, state);
    api.json('PUT', '/api/v1/orgs/{}/sandscale/billing/overage', 200, { state: { ...state, overage_enabled: true }, offer });
    api.json('DELETE', '/api/v1/orgs/{}/sandscale/billing/plan/pending', 200, state);
    api.json('POST', '/api/v1/orgs/{}/sandscale/billing/checkout', 201, { id: 'cs_1', url: 'https://checkout.example.com/cs_1', plan: 'team', interval: 'year', seats: 3, expires_at: '2026-11-18T01:00:00Z' });
    const c = client();
    expect((await c.account.changePlan({ plan: 'team', interval: 'year', seats: 3 })).plan).toBe('pro');
    expect(body()).toEqual({ plan: 'team', interval: 'year', seats: 3 });
    expect((await c.account.setOverage(true)).overageEnabled).toBe(true);
    expect(body(1)).toEqual({ enabled: true });
    expect((await c.account.cancelPendingPlanChange()).plan).toBe('pro');
    const co = await c.account.checkout({ plan: 'team', interval: 'year', seats: 3 });
    expect(co).toMatchObject({ id: 'cs_1', url: 'https://checkout.example.com/cs_1', seats: 3 });
  });

  it('maps the server refusals of plan calls to typed errors', async () => {
    api.json('PUT', '/api/v1/orgs/{}/sandscale/billing/overage', 409, errorBody('overage_not_in_plan', 'the plan has no overage'));
    api.json('POST', '/api/v1/orgs/{}/sandscale/billing/plan', 409, errorBody('checkout_required', 'start a checkout'));
    const c = client();
    expect(await c.account.setOverage(true).catch((e) => e)).toBeInstanceOf(EntitlementError);
    const err = await c.account.changePlan({ plan: 'pro' }).catch((e) => e);
    expect(err.code).toBe('checkout_required');
    expect(err.status).toBe(409);
  });

  it('reads usage and regions', async () => {
    api.json('GET', '/api/v1/sandscale/usage', 200, { month: '2026-11', vcpu_seconds_used: 100, vcpu_seconds_left: 900, running_boxes: 2, running_by_region: { us1: 1, eu1: 1 } });
    api.json('GET', '/api/v1/regions', 200, { regions: [{ id: 'us1', status: 'live', api_url: 'https://api.us.sandscale.dev' }] });
    const c = client();
    expect(await c.account.usage()).toMatchObject({ month: '2026-11', vcpuSecondsUsed: 100, vcpuSecondsLeft: 900, runningBoxes: 2, runningByRegion: { us1: 1, eu1: 1 } });
    expect(await c.account.regions()).toMatchObject([{ id: 'us1', status: 'live', apiUrl: 'https://api.us.sandscale.dev' }]);
  });

  it('creates, rotates and deletes API keys; the key is shown once and never printed', async () => {
    const key = { id: 'k-1', name: 'ci', key_prefix: 'ssk_ab', scopes: ['sandbox:use'], expires_at: '2026-12-18T00:00:00Z', created_at: '2026-11-18T00:00:00Z', state: 'active' };
    api.json('GET', '/api/v1/account/api-keys', 200, { api_keys: [key], limits: { max_days: 90, max_active: 10 } });
    api.json('POST', '/api/v1/account/api-keys', 201, { ...key, key: 'ssk_live_secret_1' });
    api.json('POST', '/api/v1/account/api-keys/{}/rotate', 200, { ...key, id: 'k-2', key: 'ssk_live_secret_2', rotated_from: 'k-1', previous_expires_at: '2026-11-18T00:05:00Z' });
    api.json('DELETE', '/api/v1/account/api-keys/{}', 204, undefined);
    const c = client();
    const list = await c.account.listApiKeys();
    expect(list.limits).toEqual({ maxDays: 90, maxActive: 10 });
    expect(list.apiKeys[0]).toMatchObject({ id: 'k-1', keyPrefix: 'ssk_ab', state: 'active' });
    const created = await c.account.createApiKey({ name: 'ci', scopes: ['sandbox:use'], expiresAt: new Date('2026-12-18T00:00:00Z') });
    expect(body(1)).toEqual({ name: 'ci', expires_at: '2026-12-18T00:00:00.000Z', scopes: ['sandbox:use'] });
    expect(created.key).toBe('ssk_live_secret_1');
    expect(JSON.stringify(created)).not.toContain('ssk_live_secret_1');
    expect(JSON.stringify(created.raw)).not.toContain('ssk_live_secret_1');
    const rotated = await c.account.rotateApiKey('k-1', { overlapSeconds: 300 });
    expect(body(2)).toEqual({ overlap_seconds: 300 });
    expect(rotated).toMatchObject({ id: 'k-2', rotatedFrom: 'k-1', key: 'ssk_live_secret_2' });
    expect(JSON.stringify(rotated)).not.toContain('ssk_live_secret_2');
    await c.account.deleteApiKey('k-1');
    expect(api.requests[3].method).toBe('DELETE');
  });
});

describe('keepAwake and prepare', () => {
  it('keepAwake retries a waking sandbox after Retry-After, then succeeds', async () => {
    let n = 0;
    api.on('POST', '/api/v1/sandbox/instances/{}/keep-awake', (_r, res) => {
      n++;
      if (n === 1) return send(res, 503, errorBody('sandbox_waking', 'resuming'), { 'Retry-After': '2' });
      send(res, 200, { id: 'sb', keep_awake: true, ttl_seconds: 60 });
    });
    const r = await client().sandboxes.keepAwake('sb', 60, { reason: 'waiting' });
    expect(r.keep_awake).toBe(true);
    expect(n).toBe(2);
    expect(sleeps).toEqual([2000]);
    expect(body(0)).toEqual({ ttl_seconds: 60, reason: 'waiting' });
  });

  it('keepAwake raises SandboxWakingError after its retries', async () => {
    api.json('POST', '/api/v1/sandbox/instances/{}/keep-awake', 503, errorBody('sandbox_waking', 'resuming'), { 'Retry-After': '1' });
    await expect(client().sandboxes.keepAwake('sb', 60)).rejects.toBeInstanceOf(SandboxWakingError);
    expect(api.requests).toHaveLength(4);
  });

  it('prepare never throws, even for a waking sandbox', async () => {
    api.json('POST', '/api/v1/sandbox/instances/{}/prepare', 503, errorBody('sandbox_waking', 'resuming'));
    client().sandboxes.prepare('sb');
    await new Promise((r) => setTimeout(r, 50));
    expect(api.requests).toHaveLength(1);
  });
});

describe('error codes become typed errors', () => {
  it('maps sandbox_waking to a retryable SandboxWakingError with Retry-After', async () => {
    api.json('POST', '/api/v1/sandbox/instances/{}/exec', 503, errorBody('sandbox_waking', 'the sandbox is resuming'), { 'Retry-After': '2' });
    const err = await client().sandboxes.run('sb', ['true']).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxWakingError);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err).toBeInstanceOf(ServerError);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(2000);
    expect(err.code).toBe('sandbox_waking');
    expect(api.requests).toHaveLength(1); // a mutation is never retried by the SDK
  });

  it('retries a safe call that meets sandbox_waking', async () => {
    let n = 0;
    api.on('GET', '/api/v1/sandbox/instances/{}', (_r, res) => {
      n++;
      if (n === 1) return send(res, 503, errorBody('sandbox_waking', 'resuming'), { 'Retry-After': '1' });
      send(res, 200, { id: 'sb', status: 'running' });
    });
    expect((await client().sandboxes.get('sb')).status).toBe('running');
    expect(sleeps).toEqual([1000]);
  });

  it('sorts plan refusals as entitlement errors and a stale entitlement as retryable', async () => {
    api.json('POST', '/api/v1/sandbox/instances', 402, errorBody('network_not_in_plan', 'network is not in the Free plan'));
    const e1 = await client().sandboxes.create({ network: 'allowlist' }).catch((e) => e);
    expect(e1).toBeInstanceOf(EntitlementError);
    expect(e1.code).toBe('network_not_in_plan');
    api.json('POST', '/api/v1/sandbox/instances', 503, errorBody('entitlement_unavailable', 'another region is stale'), { 'Retry-After': '30' });
    const e2 = await client().sandboxes.create().catch((e) => e);
    expect(e2).toBeInstanceOf(ServiceUnavailableError);
    expect(e2).not.toBeInstanceOf(EntitlementError);
    expect(e2.retryAfterMs).toBe(30000);
  });

  it('403 feature_not_in_plan and public_preview_not_in_plan are entitlement errors', async () => {
    api.json('POST', '/api/v1/orgs/{}/workspaces', 403, errorBody('feature_not_in_plan', 'workspaces are not in the Free plan'));
    expect(await client().workspaces.create({ name: 'a' }).catch((e) => e)).toBeInstanceOf(EntitlementError);
    api.json('POST', '/api/v1/sandbox/instances/{}/ports/{}/preview-links', 403, errorBody('public_preview_not_in_plan', 'upgrade'));
    expect(await client().sandboxes.createPreviewLink('sb', 1, { visibility: 'public' }).catch((e) => e)).toBeInstanceOf(EntitlementError);
  });
});

describe('route contract', () => {
  // The server's route inventory files, colon separated (the source repository sets it).
  const files = (process.env.SANDSCALE_ROUTE_INVENTORY ?? '').split(':').filter(Boolean);
  it.skipIf(files.length === 0 || !files.every(existsSync))('the server mounts every route these services call', () => {
    const mounted = new Set<string>();
    for (const f of files) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = /^(?:\S+ )?((?:GET|POST|PUT|PATCH|DELETE) \/\S*)/.exec(line);
        if (m) mounted.add(m[1].replace(/\{[^}/]*\}/g, '{}'));
      }
    }
    expect(seen.size).toBeGreaterThan(60);
    const missing = [...seen].filter((r) => !mounted.has(r));
    expect(missing, `routes called that the server does not mount: ${missing.join(', ')}`).toEqual([]);
  });
});
