// Copyright 2026 Neural Inverse
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  ConfigurationError,
  ConflictError,
  ConnectionError,
  EntitlementError,
  InvalidRequestError,
  KillSwitchError,
  LimitExceededError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  RegionError,
  Sandscale,
  ServerError,
  type ClientOptions,
} from '../src/index.js';
import { MockServer, errorBody, send, sse } from './mock.js';

const ORG = 'org-1';
let api: MockServer;
let sleeps: number[];

function client(extra: ClientOptions = {}): Sandscale {
  const c = new Sandscale({ apiKey: 'ssk_test', baseUrl: api.url, orgId: ORG, ...extra });
  c.transport.sleep = async (ms) => void sleeps.push(ms);
  return c;
}

const sandboxRaw = { id: 'sb-1', status: 'running', created_at: '2026-11-17T00:00:00Z', mem_mb: 512, cpu_count: 1 };

beforeEach(async () => {
  api = await new MockServer().start();
  sleeps = [];
});
afterEach(async () => api.stop());

describe('configuration', () => {
  it('requires a credential and refuses both kinds', () => {
    expect(() => new Sandscale({ baseUrl: 'https://x.test', apiKey: '' })).toThrow(ConfigurationError);
    expect(() => new Sandscale({ baseUrl: 'https://x.test', apiKey: 'a', token: 'b' })).toThrow(ConfigurationError);
  });

  it('refuses plain http except to loopback, and URLs with credentials', () => {
    expect(() => new Sandscale({ apiKey: 'k', baseUrl: 'http://api.example.com' })).toThrow(/https/);
    expect(() => new Sandscale({ apiKey: 'k', baseUrl: 'https://u:p@api.example.com' })).toThrow(/credentials/);
    expect(new Sandscale({ apiKey: 'k' }).transport.baseUrl).toBe('https://api.sandscale.dev');
  });

  it('needs an organization for the routes that name it', async () => {
    const c = new Sandscale({ apiKey: 'k', baseUrl: api.url });
    await expect(c.workspaces.list({ region: 'us' })).rejects.toThrow(ConfigurationError);
  });

  it('sends the API key, the organization and the user agent', async () => {
    api.json('GET', '/api/v1/sandbox/instances/{}', 200, sandboxRaw);
    await client().sandboxes.get('sb-1');
    const h = api.requests[0].headers;
    expect(h.authorization).toBe('Bearer ssk_test');
    expect(h['x-org-id']).toBe(ORG);
    expect(h['user-agent']).toMatch(/^sandscale-sdk-typescript\//);
  });

  it('asks a token function for the person token on every call', async () => {
    let n = 0;
    api.json('GET', '/api/v1/sandbox/instances/{}', 200, sandboxRaw);
    const c = new Sandscale({ token: async () => `tok-${++n}`, baseUrl: api.url });
    await c.sandboxes.get('sb-1');
    await c.sandboxes.get('sb-1');
    expect(api.requests.map((r) => r.headers.authorization)).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });
});

describe('errors carry the server code and message', () => {
  const cases: [number, string, unknown][] = [
    [400, 'invalid_request', InvalidRequestError],
    [401, 'invalid_token', AuthenticationError],
    [403, 'host_access_denied', PermissionDeniedError],
    [404, 'instance_not_found', NotFoundError],
    [409, 'pause_unsupported', ConflictError],
    [402, 'quota_exceeded', LimitExceededError],
    [409, 'snapshot_quota_exceeded', LimitExceededError],
    [403, 'not_entitled', EntitlementError],
    [402, 'payment_required', EntitlementError],
    [503, 'kill_switch_engaged', KillSwitchError],
    [401, 'wrong_region', RegionError],
    [500, 'internal_error', ServerError],
  ];
  for (const [status, code, cls] of cases) {
    it(`${status} ${code}`, async () => {
      api.json('POST', '/api/v1/sandbox/instances', status, errorBody(code, `server says ${code}`, { detail: { limit: 2 } }));
      const err = await client().sandboxes.create({ template: 'builtin:base' }).catch((e) => e);
      expect(err).toBeInstanceOf(cls as new () => Error);
      expect(err.code).toBe(code);
      expect(err.message).toBe(`server says ${code}`);
      expect(err.status).toBe(status);
      expect(err.requestId).toBe('req-1');
      expect(err.details).toEqual({ limit: 2 });
    });
  }

  it('reads the wrong_region answer of the bearer middleware', async () => {
    api.json('GET', '/api/v1/sandbox/instances/{}', 401, { code: 'wrong_region', region: 'eu1', error: { code: 'wrong_region', message: 'm', region: 'eu1' } });
    const err = await client().sandboxes.get('x').catch((e) => e);
    expect(err).toBeInstanceOf(RegionError);
    expect(err.region).toBe('eu1');
  });

  it('a 429 is a RateLimitError with Retry-After', async () => {
    api.json('POST', '/api/v1/sandbox/instances', 429, errorBody('rate_limited', 'slow down'), { 'Retry-After': '7' });
    const err = await client().sandboxes.create().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err).toBeInstanceOf(LimitExceededError);
    expect(err.retryAfterMs).toBe(7000);
  });
});

describe('retries', () => {
  it('retries a GET after 503 and 429, honouring Retry-After', async () => {
    let n = 0;
    api.on('GET', '/api/v1/sandbox/instances/{}', (_r, res) => {
      n++;
      if (n === 1) return send(res, 503, errorBody('provisioner_unavailable', 'busy'));
      if (n === 2) return send(res, 429, errorBody('rate_limited', 'slow'), { 'Retry-After': '2' });
      send(res, 200, sandboxRaw);
    });
    const sb = await client().sandboxes.get('sb-1');
    expect(sb.id).toBe('sb-1');
    expect(n).toBe(3);
    expect(sleeps[1]).toBe(2000);
  });

  it('never retries a call that is not safe', async () => {
    api.json('POST', '/api/v1/sandbox/instances', 503, errorBody('provisioner_unavailable', 'busy'));
    await expect(client().sandboxes.create()).rejects.toBeInstanceOf(ServerError);
    expect(api.requests).toHaveLength(1);
  });

  it('never retries a kill switch', async () => {
    api.json('GET', '/api/v1/sandbox/instances/{}', 503, errorBody('kill_switch_engaged', 'stopped'));
    await expect(client().sandboxes.get('x')).rejects.toBeInstanceOf(KillSwitchError);
    expect(api.requests).toHaveLength(1);
  });

  it('gives up after maxRetries', async () => {
    api.json('GET', '/api/v1/sandbox/instances/{}', 502, errorBody('bad_gateway', 'down'));
    await expect(client({ maxRetries: 1 }).sandboxes.get('x')).rejects.toBeInstanceOf(ServerError);
    expect(api.requests).toHaveLength(2);
  });

  it('a connection failure is a ConnectionError', async () => {
    const url = api.url;
    await api.stop();
    const c = new Sandscale({ apiKey: 'k', baseUrl: url, maxRetries: 0 });
    await expect(c.sandboxes.get('x')).rejects.toBeInstanceOf(ConnectionError);
    api = await new MockServer().start();
  });
});

describe('regions', () => {
  let eu: MockServer;
  beforeEach(async () => {
    eu = await new MockServer().start();
    api.json('GET', '/api/v1/regions', 200, {
      current: 'us1',
      regions: [
        { id: 'us1', status: 'live', api_url: api.url },
        { id: 'eu1', status: 'live', api_url: eu.url },
        { id: 'jp1', status: 'coming_soon', api_url: '' },
      ],
    });
  });
  afterEach(async () => eu.stop());

  it('sends a call to the region it names, without a credential on the region list', async () => {
    eu.json('POST', '/api/v1/sandbox/instances', 201, { id: 'sb-eu', status: 'starting' });
    const sb = await client().sandboxes.create({ template: 'builtin:base', region: 'eu' });
    expect(sb).toMatchObject({ id: 'sb-eu', region: 'eu' });
    expect(eu.requests[0].headers.authorization).toBe('Bearer ssk_test');
    expect(api.requests[0].path).toBe('/api/v1/regions');
    expect(api.requests[0].headers.authorization).toBeUndefined();
  });

  it('uses the client region when the call names none', async () => {
    eu.json('GET', '/api/v1/sandbox/instances/{}', 200, sandboxRaw);
    await client({ region: 'eu1' }).sandboxes.get('sb-1');
    expect(eu.requests).toHaveLength(1);
  });

  it('refuses unknown and unavailable regions', async () => {
    await expect(client().sandboxes.get('x', { region: 'ap' })).rejects.toMatchObject({ code: 'region_unknown' });
    await expect(client().sandboxes.get('x', { region: 'jp' })).rejects.toMatchObject({ code: 'region_unavailable' });
  });

  it('lists every live region and keeps the others when one fails', async () => {
    api.json('GET', '/api/v1/sandbox/instances', 200, { data: [{ id: 'a', status: 'running' }], next_cursor: 'c1', has_more: true });
    eu.json('GET', '/api/v1/sandbox/instances', 503, errorBody('provisioner_unavailable', 'down'));
    const list = await client({ maxRetries: 0 }).sandboxes.list();
    expect(list.data.map((s) => [s.id, s.region])).toEqual([['a', 'us1']]);
    expect(list.pages[0]).toMatchObject({ region: 'us1', nextCursor: 'c1', hasMore: true });
    expect(list.pages[1].error).toBeInstanceOf(ServerError);
  });

  it('takes explicit region URLs over the region list', async () => {
    eu.json('GET', '/api/v1/sandbox/instances/{}', 200, sandboxRaw);
    await client({ regionUrls: { eu: eu.url } }).sandboxes.get('sb-1', { region: 'eu' });
    expect(api.requests).toHaveLength(0);
  });
});

describe('sandboxes', () => {
  it('create maps the options to the server fields', async () => {
    api.json('POST', '/api/v1/sandbox/instances', 201, sandboxRaw);
    const sb = await client().sandboxes.create({
      template: 'builtin:python',
      cpuCount: 2,
      memoryMb: 1024,
      diskMb: 2048,
      timeoutSeconds: 600,
      env: { A: '1' },
      vaultEnv: [{ name: 'DB_PASSWORD', path: 'secret/data/db', field: 'password' }],
      name: 'n',
      labels: { team: 'x' },
    });
    expect(JSON.parse(api.requests[0].body)).toEqual({
      template_id: 'builtin:python',
      cpu_count: 2,
      mem_mb: 1024,
      disk_mb: 2048,
      ttl_seconds: 600,
      env: { A: '1' },
      vault_env: [{ name: 'DB_PASSWORD', path: 'secret/data/db', field: 'password' }],
      name: 'n',
      labels: { team: 'x' },
    });
    expect(sb).toMatchObject({ id: 'sb-1', status: 'running', memoryMb: 512 });
    expect(sb.createdAt?.toISOString()).toBe('2026-11-17T00:00:00.000Z');
  });

  it('list sends filters and reads the page', async () => {
    api.json('GET', '/api/v1/sandbox/instances', 200, { data: [sandboxRaw], next_cursor: null, has_more: false });
    const list = await client({ region: 'us' , regionUrls: { us: api.url } }).sandboxes.list({ status: 'running', limit: 10, cursor: 'c' });
    expect(Object.fromEntries(api.requests[0].query)).toEqual({ status: 'running', limit: '10', cursor: 'c' });
    expect(list.data).toHaveLength(1);
    expect(list.pages).toEqual([{ region: 'us', nextCursor: undefined, hasMore: false }]);
  });

  it('stop, pause, resume', async () => {
    api.on('DELETE', '/api/v1/sandbox/instances/{}', (_r, res) => void res.writeHead(204).end());
    api.json('POST', '/api/v1/sandbox/instances/{}/pause', 200, { id: 'sb-1', status: 'paused' });
    api.json('POST', '/api/v1/sandbox/instances/{}/resume', 200, { id: 'sb-1', status: 'running' });
    const c = client();
    await c.sandboxes.stop('sb-1');
    expect(await c.sandboxes.pause('sb-1')).toEqual({ id: 'sb-1', status: 'paused' });
    expect(await c.sandboxes.resume('sb-1')).toEqual({ id: 'sb-1', status: 'running' });
    expect(api.requests.map((r) => r.method)).toEqual(['DELETE', 'POST', 'POST']);
  });

  it('snapshot and listSnapshots', async () => {
    const snap = { id: 'sn-1', instance_id: 'sb-1', status: 'creating', label: 'l', size_bytes: 0, created_at: '2026-11-17T00:00:00Z' };
    api.json('POST', '/api/v1/sandbox/instances/{}/snapshot', 201, snap);
    api.json('GET', '/api/v1/sandbox/instances/{}/snapshots', 200, { snapshots: [snap] });
    const c = client();
    expect(await c.sandboxes.snapshot('sb-1', { label: 'l' })).toMatchObject({ id: 'sn-1', status: 'creating', label: 'l' });
    expect(JSON.parse(api.requests[0].body)).toEqual({ label: 'l' });
    expect((await c.sandboxes.listSnapshots('sb-1')).map((s) => s.id)).toEqual(['sn-1']);
  });

  it('writeFile, readFile and listFiles move base64 content', async () => {
    api.json('PUT', '/api/v1/sandbox/instances/{}/files', 200, {});
    api.on('GET', '/api/v1/sandbox/instances/{}/files', (req, res) =>
      req.query.get('path') === '/workspace'
        ? send(res, 200, { type: 'dir', entries: [{ name: 'a.txt', type: 'file', size_bytes: 2 }, { name: 'd', type: 'dir' }] })
        : send(res, 200, { type: 'file', content: Buffer.from('hi').toString('base64') }),
    );
    const c = client();
    await c.sandboxes.writeFile('sb-1', '/workspace/a.txt', 'hi', { mode: '0644' });
    expect(JSON.parse(api.requests[0].body)).toEqual({ path: '/workspace/a.txt', content: 'aGk=', mode: '0644' });
    expect(new TextDecoder().decode(await c.sandboxes.readFile('sb-1', '/workspace/a.txt'))).toBe('hi');
    expect(await c.sandboxes.listFiles('sb-1', '/workspace')).toEqual([
      { name: 'a.txt', path: '/workspace/a.txt', isDir: false, size: 2 },
      { name: 'd', path: '/workspace/d', isDir: true, size: undefined },
    ]);
  });

  it('run returns the exit code and output', async () => {
    api.json('POST', '/api/v1/sandbox/instances/{}/exec', 200, { run_id: 'r1', exit_code: 3, stdout: 'o', stderr: 'e', duration_ms: 5 });
    const res = await client().sandboxes.run('sb-1', 'exit 3', { env: { X: '1' }, workdir: '/workspace/p', timeoutSeconds: 5, stdin: 'in' });
    expect(JSON.parse(api.requests[0].body)).toEqual({
      command: ['sh', '-c', 'exit 3'],
      timeout_sec: 5,
      env: { X: '1' },
      workdir: '/workspace/p',
      stdin: 'aW4=',
    });
    expect(res).toMatchObject({ runId: 'r1', exitCode: 3, stdout: 'o', stderr: 'e', durationMs: 5, streamed: false });
  });

  it('run with callbacks starts without waiting and streams the run by its id', async () => {
    api.on('POST', '/api/v1/sandbox/instances/{}/exec', (req, res) => {
      expect(JSON.parse(req.body)).toMatchObject({ command: ['echo', 'hi'], wait: false });
      send(res, 202, { run_id: 'r2', status: 'queued' });
    });
    api.on('GET', '/api/v1/sandbox/instances/{}/logs', (req, res) => {
      expect(req.query.get('run_id')).toBe('r2');
      sse(res, [
        { event: 'chunk', data: { chunk_index: 0, stream: 'stdout', data: 'hi\n' } },
        { event: 'chunk', data: { chunk_index: 1, stream: 'stderr', data: 'w\n' } },
        { event: 'done', data: { run_id: 'r2', status: 'failed', exit_code: 4, oom_killed: false, timed_out: false } },
      ]);
    });
    const out: string[] = [];
    const res = await client().sandboxes.run('sb-1', ['echo', 'hi'], {
      onStdout: (d) => out.push(`out:${d}`),
      onStderr: (d) => out.push(`err:${d}`),
    });
    expect(out).toEqual(['out:hi\n', 'err:w\n']);
    expect(res).toMatchObject({ runId: 'r2', exitCode: 4, stdout: 'hi\n', stderr: 'w\n', streamed: true });
    // No run listing: the run is known by its id.
    expect(api.requests.map((r) => r.route)).toEqual([
      'POST /api/v1/sandbox/instances/{}/exec',
      'GET /api/v1/sandbox/instances/{}/logs',
    ]);
  });

  it('run reads the run when the stream end carries no result', async () => {
    api.json('POST', '/api/v1/sandbox/instances/{}/exec', 202, { run_id: 'r3', status: 'queued' });
    api.on('GET', '/api/v1/sandbox/instances/{}/logs', (_r, res) => sse(res, [{ event: 'done', data: {} }]));
    api.json('GET', '/api/v1/sandbox/runs/{}', 200, { id: 'r3', status: 'timed_out', exit_code: 124, duration_ms: 9 });
    const res = await client().sandboxes.run('sb-1', ['sleep', '9'], { onStdout: () => undefined });
    expect(res).toMatchObject({ runId: 'r3', exitCode: 124, timedOut: true, durationMs: 9, streamed: true });
  });

  it('run delivers the final output once when the server answers with the result', async () => {
    api.json('POST', '/api/v1/sandbox/instances/{}/exec', 200, { run_id: 'a', exit_code: 0, stdout: 'x', stderr: '' });
    const out: string[] = [];
    const res = await client().sandboxes.run('sb-1', ['true'], { onStdout: (d) => out.push(d) });
    expect(res.streamed).toBe(false);
    expect(out).toEqual(['x']);
    expect(api.requests).toHaveLength(1);
  });

  it('logs ends with a typed error when the server withholds output', async () => {
    api.on('GET', '/api/v1/sandbox/instances/{}/logs', (_r, res) =>
      sse(res, [
        { event: 'chunk', data: { chunk_index: 0, stream: 'stdout', data: 'a' } },
        { event: 'error', data: { code: 'dlp_unavailable', message: 'scan failed' } },
      ]),
    );
    const got: string[] = [];
    const err = await (async () => {
      for await (const c of client().sandboxes.logs('sb-1', 'r1')) got.push(c.data);
    })().catch((e) => e);
    expect(got).toEqual(['a']);
    expect(err).toBeInstanceOf(ServerError);
    expect(err.code).toBe('dlp_unavailable');
  });

  it('logs resumes after a dropped stream from the next chunk', async () => {
    let n = 0;
    api.on('GET', '/api/v1/sandbox/instances/{}/logs', (req, res) => {
      n++;
      if (n === 1) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`event: chunk\ndata: ${JSON.stringify({ chunk_index: 4, stream: 'stdout', data: 'a' })}\n\n`);
        return void res.end(); // ends without "done": a dropped stream
      }
      expect(req.query.get('from_chunk')).toBe('5');
      sse(res, [{ event: 'chunk', data: { chunk_index: 5, stream: 'stdout', data: 'b' } }, { event: 'done', data: {} }]);
    });
    const got: string[] = [];
    for await (const c of client().sandboxes.logs('sb-1', 'r1')) got.push(c.data);
    expect(got).toEqual(['a', 'b']);
  });
});

describe('workspaces and build hosts', () => {
  const ws = { id: 'ws-1', name: 'dev', status: 'stopped', health: 'healthy', created_at: '2026-11-17T00:00:00Z' };
  const build = { id: 'b-1', workspace_id: 'ws-1', state: 'pending', desired_state: 'running', build_number: 2 };
  const connect = { ssh_host: 'ws-1.ws.sandscale.dev', ssh_command: 'sandscale ssh dev', ssh_ready: true, links: [] };
  const lease = { id: 'l-1', pool_id: 'p-1', state: 'active', workspace_id: 'ws-1', size: { name: 'small', cpu_cores: 2, memory_gb: 4 } };

  it('workspaces list, get, start, stop and connectInfo', async () => {
    api.json('GET', `/api/v1/orgs/${ORG}/workspaces`, 200, { workspaces: [ws], next_cursor: 'n' });
    api.json('GET', `/api/v1/orgs/${ORG}/workspaces/{}`, 200, ws);
    api.json('POST', `/api/v1/orgs/${ORG}/workspaces/{}/start`, 202, build);
    api.json('POST', `/api/v1/orgs/${ORG}/workspaces/{}/stop`, 202, { ...build, desired_state: 'stopped' });
    api.json('GET', `/api/v1/orgs/${ORG}/workspaces/{}/connect`, 200, connect);
    const c = client({ regionUrls: { us: api.url } });
    const list = await c.workspaces.list({ region: 'us', limit: 5, all: true });
    expect(list.data[0]).toMatchObject({ id: 'ws-1', name: 'dev', region: 'us' });
    expect(list.pages[0]).toMatchObject({ nextCursor: 'n', hasMore: true });
    expect(Object.fromEntries(api.requests[0].query)).toEqual({ limit: '5', all: 'true' });
    expect((await c.workspaces.get('ws-1')).status).toBe('stopped');
    expect(await c.workspaces.start('ws-1')).toMatchObject({ id: 'b-1', state: 'pending', desiredState: 'running', buildNumber: 2 });
    expect((await c.workspaces.stop('ws-1')).desiredState).toBe('stopped');
    expect(await c.workspaces.connectInfo('ws-1')).toMatchObject({ sshHost: 'ws-1.ws.sandscale.dev', sshReady: true });
  });

  it('build hosts listPools, list, start, stop, get and connectInfo', async () => {
    api.json('GET', `/api/v1/orgs/${ORG}/build/pools`, 200, { pools: [{ id: 'p-1', name: 'linux', backend: 'keystone_cloud', sizes: [{ name: 'small', cpu_cores: 2, memory_gb: 4 }] }] });
    api.json('GET', `/api/v1/orgs/${ORG}/build/leases`, 200, { leases: [lease] });
    api.json('POST', `/api/v1/orgs/${ORG}/build/pools/{}/leases`, 201, { ...lease, state: 'provisioning' });
    api.json('POST', `/api/v1/orgs/${ORG}/build/leases/{}/release`, 200, { ...lease, state: 'released' });
    api.json('GET', `/api/v1/orgs/${ORG}/build/leases/{}`, 200, lease);
    api.json('GET', `/api/v1/orgs/${ORG}/workspaces/{}/connect`, 200, connect);
    const c = client({ regionUrls: { us: api.url } });
    expect((await c.buildHosts.listPools({ region: 'us' })).data[0].sizes).toEqual([{ name: 'small', cpuCores: 2, memoryGb: 4 }]);
    expect((await c.buildHosts.list({ region: 'us', scope: 'mine', state: 'active' })).data[0].id).toBe('l-1');
    const started = await c.buildHosts.start('p-1', { size: 'small', ttlSeconds: 3600, purpose: 'ci' });
    expect(JSON.parse(api.requests[2].body)).toEqual({ size: 'small', ttl_seconds: 3600, purpose: 'ci' });
    expect(started.state).toBe('provisioning');
    expect((await c.buildHosts.stop('l-1')).state).toBe('released');
    const info = await c.buildHosts.connectInfo('l-1');
    expect(info.kind).toBe('workspace');
    expect(info.workspace?.sshHost).toBe('ws-1.ws.sandscale.dev');
  });

  it('build hosts connectInfo of a lab lease and sshCertificate', async () => {
    api.json('GET', `/api/v1/orgs/${ORG}/build/leases/{}`, 200, { id: 'l-2', pool_id: 'p', state: 'active', workspace_id: null, lab_host_id: 'h-1', host: { status: 'ready', ready: true, ssh_user: 'nib-1' } });
    api.json('POST', `/api/v1/orgs/${ORG}/build/leases/{}/ssh/certificate`, 200, { certificate: 'ssh-ed25519-cert-v01@openssh.com AAA', serial: '1', key_id: 'k', principals: ['nib-1'], valid_after: '2026-11-17T00:00:00Z', valid_before: '2026-11-17T01:00:00Z', ssh: { user: 'nib-1' } });
    const c = client();
    expect(await c.buildHosts.connectInfo('l-2')).toMatchObject({ kind: 'lab', sshRelayPath: `/api/v1/orgs/${ORG}/build/leases/l-2/ssh`, sshUser: 'nib-1' });
    const cert = await c.buildHosts.sshCertificate('l-2', 'ssh-ed25519 AAAA me');
    expect(JSON.parse(api.requests[1].body)).toEqual({ public_key: 'ssh-ed25519 AAAA me' });
    expect(cert).toMatchObject({ serial: '1', principals: ['nib-1'], ssh: { user: 'nib-1' } });
  });
});

describe('Sandscale regions', () => {
  function recordingClient(extra: ClientOptions = {}) {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/api/v1/regions')) {
        return new Response(JSON.stringify({ regions: [{ id: 'us1', status: 'live', api_url: 'https://api.us1.region.example.test' }, { id: 'eu1', status: 'coming_soon' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [], id: 'sb', status: 'running' }), { status: 200 });
    }) as typeof fetch;
    return { c: new Sandscale({ apiKey: 'k', fetch: fetchImpl, ...extra }), urls };
  }

  it('sends a region to its Sandscale API, never to a Keystone host', async () => {
    const { c, urls } = recordingClient();
    await c.sandboxes.get('sb', { region: 'eu' });
    await c.sandboxes.get('sb', { region: 'us1' });
    await c.sandboxes.get('sb');
    expect(urls).toEqual([
      'https://api.eu.sandscale.dev/api/v1/sandbox/instances/sb',
      'https://api.us.sandscale.dev/api/v1/sandbox/instances/sb',
      'https://api.sandscale.dev/api/v1/sandbox/instances/sb',
    ]);
    await expect(c.sandboxes.get('sb', { region: 'ap' })).rejects.toMatchObject({ code: 'region_unknown' });
  });

  it('lists the live Sandscale regions through their own hosts', async () => {
    const { c, urls } = recordingClient();
    const list = await c.sandboxes.list();
    expect(list.pages.map((p) => p.region)).toEqual(['us']);
    expect(urls).toEqual(['https://api.sandscale.dev/api/v1/regions', 'https://api.us.sandscale.dev/api/v1/sandbox/instances']);
    expect(urls.some((u) => u.includes('region.example.test'))).toBe(false);
  });

  it('keeps wrong_region a typed RegionError', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ code: 'wrong_region', region: 'eu1', error: { code: 'wrong_region', message: 'm', region: 'eu1' } }), { status: 401 })) as unknown as typeof fetch;
    const err = await new Sandscale({ apiKey: 'k', fetch: fetchImpl }).sandboxes.get('sb', { region: 'us' }).catch((e) => e);
    expect(err).toBeInstanceOf(RegionError);
    expect(err.region).toBe('eu1');
  });
});
