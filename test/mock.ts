// Copyright 2026 Neural Inverse
// SPDX-License-Identifier: Apache-2.0

// A local HTTP server that answers like the Sandscale API, for the SDK's tests.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Recorded {
  method: string;
  path: string;
  /** The route pattern that answered, e.g. "GET /api/v1/sandbox/instances/{}". */
  route: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: string;
}

export type Handler = (req: Recorded, res: ServerResponse) => void | Promise<void>;

export class MockServer {
  readonly requests: Recorded[] = [];
  private readonly routes: { method: string; pattern: string; re: RegExp; handler: Handler }[] = [];
  private server?: Server;
  url = '';

  /** Registers a handler; "{}" in the pattern matches one path segment. Later registrations win. */
  on(method: string, pattern: string, handler: Handler): this {
    const re = new RegExp(`^${pattern.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\}/g, '[^/]+')}$`);
    this.routes.unshift({ method, pattern, re, handler });
    return this;
  }

  json(method: string, pattern: string, status: number, body: unknown, headers: Record<string, string> = {}): this {
    return this.on(method, pattern, (_req, res) => send(res, status, body, headers));
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const route = this.routes.find((r) => r.method === method && r.re.test(url.pathname));
    const recorded: Recorded = {
      method,
      path: url.pathname,
      route: route ? `${method} ${route.pattern}` : `${method} ${url.pathname} (unrouted)`,
      query: url.searchParams,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    this.requests.push(recorded);
    if (!route) return send(res, 404, { error: { code: 'not_found', message: `no mock for ${method} ${url.pathname}` } });
    await route.handler(recorded, res);
  }
}

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(text);
}

export function sse(res: ServerResponse, events: { event: string; data: unknown }[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
  res.end();
}

export function errorBody(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message, request_id: 'req-1', ...extra } };
}
