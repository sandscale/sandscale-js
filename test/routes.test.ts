// Copyright 2026 Neural Inverse
// SPDX-License-Identifier: Apache-2.0

// The routes this SDK calls. The test fails when the SDK calls a route not listed here and, when
// SANDSCALE_ROUTE_INVENTORY names the server's route inventory files (colon separated; the
// source repository sets it), when the server stops mounting one of them. Without it that one
// check is skipped.

import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sandscale } from '../src/index.js';
import { MockServer, send, sse } from './mock.js';

export const ROUTES = [
  'GET /api/v1/regions',
  'POST /api/v1/sandbox/instances',
  'GET /api/v1/sandbox/instances',
  'GET /api/v1/sandbox/instances/{}',
  'DELETE /api/v1/sandbox/instances/{}',
  'POST /api/v1/sandbox/instances/{}/pause',
  'POST /api/v1/sandbox/instances/{}/resume',
  'POST /api/v1/sandbox/instances/{}/keep-awake',
  'POST /api/v1/sandbox/instances/{}/prepare',
  'POST /api/v1/sandbox/instances/{}/snapshot',
  'GET /api/v1/sandbox/instances/{}/snapshots',
  'POST /api/v1/sandbox/instances/{}/exec',
  'GET /api/v1/sandbox/runs/{}',
  'GET /api/v1/sandbox/instances/{}/logs',
  'PUT /api/v1/sandbox/instances/{}/files',
  'GET /api/v1/sandbox/instances/{}/files',
  'GET /api/v1/orgs/{}/workspaces',
  'GET /api/v1/orgs/{}/workspaces/{}',
  'POST /api/v1/orgs/{}/workspaces/{}/start',
  'POST /api/v1/orgs/{}/workspaces/{}/stop',
  'GET /api/v1/orgs/{}/workspaces/{}/connect',
  'GET /api/v1/orgs/{}/build/pools',
  'POST /api/v1/orgs/{}/build/pools/{}/leases',
  'GET /api/v1/orgs/{}/build/leases',
  'GET /api/v1/orgs/{}/build/leases/{}',
  'POST /api/v1/orgs/{}/build/leases/{}/release',
  'POST /api/v1/orgs/{}/build/leases/{}/ssh/certificate',
];

const INVENTORY_FILES = (process.env.SANDSCALE_ROUTE_INVENTORY ?? '').split(':').filter(Boolean);

function normalise(route: string): string {
  return route.replace(/\{[^}/]*\}/g, '{}');
}

describe('route contract', () => {
  it.skipIf(INVENTORY_FILES.length === 0 || !INVENTORY_FILES.every(existsSync))('the server mounts every route the SDK calls', () => {
    const mounted = new Set<string>();
    for (const f of INVENTORY_FILES) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = /^(?:\S+ )?((?:GET|POST|PUT|PATCH|DELETE) \/\S*)/.exec(line);
        if (m) mounted.add(normalise(m[1]));
      }
    }
    const missing = ROUTES.filter((r) => !mounted.has(r));
    expect(missing, `routes the SDK calls that the server no longer mounts: ${missing.join(', ')}`).toEqual([]);
  });

  let api: MockServer;
  beforeAll(async () => {
    api = await new MockServer().start();
    const box = { id: 'x', status: 'running' };
    const lease = { id: 'l', pool_id: 'p', state: 'active', workspace_id: 'w' };
    for (const route of ROUTES) {
      const [method, pattern] = route.split(' ');
      api.on(method, pattern, (_req, res) => {
        if (route === 'GET /api/v1/regions') return send(res, 200, { regions: [{ id: 'us1', status: 'live', api_url: api.url }] });
        if (route.endsWith('/logs')) return sse(res, [{ event: 'done', data: {} }]);
        if (route.endsWith('/files') && method === 'GET') return send(res, 200, { type: 'file', content: '' });
        if (route.includes('/build/')) return send(res, 200, route.endsWith('/pools') ? { pools: [] } : route.endsWith('/leases') && method === 'GET' ? { leases: [] } : lease);
        if (route.endsWith('/snapshots')) return send(res, 200, { snapshots: [] });
        if (route.endsWith('/exec')) return send(res, 202, { run_id: 'r', status: 'queued' });
        if (route === 'GET /api/v1/sandbox/runs/{}') return send(res, 200, { id: 'r', status: 'succeeded', exit_code: 0 });
        if (route === 'DELETE /api/v1/sandbox/instances/{}') return void res.writeHead(204).end();
        send(res, 200, method === 'GET' && route.endsWith('/instances') ? { data: [] } : box);
      });
    }
  });
  afterAll(async () => api.stop());

  it('the SDK calls exactly the listed routes', async () => {
    const c = new Sandscale({ apiKey: 'k', baseUrl: api.url, orgId: 'o' });
    await c.sandboxes.create({ region: 'us' });
    await c.sandboxes.list();
    await c.sandboxes.get('x');
    await c.sandboxes.stop('x');
    await c.sandboxes.pause('x');
    await c.sandboxes.resume('x');
    await c.sandboxes.keepAwake('x', 60, { reason: 'dev server' });
    c.sandboxes.prepare('x');
    await new Promise((r) => setTimeout(r, 50)); // the hint is fire-and-forget
    await c.sandboxes.snapshot('x');
    await c.sandboxes.listSnapshots('x');
    await c.sandboxes.run('x', ['true']);
    await c.sandboxes.run('x', ['true'], { onStdout: () => undefined });
    for await (const _ of c.sandboxes.logs('x', 'r')) void _;
    await c.sandboxes.writeFile('x', '/workspace/a', 'a');
    await c.sandboxes.readFile('x', '/workspace/a');
    await c.workspaces.list();
    await c.workspaces.get('w');
    await c.workspaces.start('w');
    await c.workspaces.stop('w');
    await c.workspaces.connectInfo('w');
    await c.buildHosts.listPools();
    await c.buildHosts.list();
    await c.buildHosts.start('p');
    await c.buildHosts.get('l');
    await c.buildHosts.stop('l');
    await c.buildHosts.connectInfo('l');
    await c.buildHosts.sshCertificate('l', 'ssh-ed25519 AAAA');
    const called = new Set(api.requests.map((r) => r.route.replace(/\/orgs\/[^/]+/, '/orgs/{}')));
    expect([...called].sort()).toEqual([...ROUTES].sort());
  });
});
