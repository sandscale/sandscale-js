// Copyright 2026 Neural Inverse
// SPDX-License-Identifier: Apache-2.0

// Runs against the real Sandscale API only when SANDSCALE_API_KEY is set (it starts and stops
// one small sandbox, which uses credits). SANDSCALE_BASE_URL, SANDSCALE_ORG_ID and
// SANDSCALE_REGION are honoured. Nothing secret is printed.

import { describe, expect, it } from 'vitest';
import { Sandscale } from '../src/index.js';

const enabled = Boolean(process.env.SANDSCALE_API_KEY);

describe.skipIf(!enabled)('integration (SANDSCALE_API_KEY)', () => {
  it('starts a sandbox, runs a command with live output, reads a file and stops it', async () => {
    const sandscale = new Sandscale({ region: process.env.SANDSCALE_REGION || undefined });
    const box = await sandscale.sandboxes.create({ template: 'builtin:base', timeoutSeconds: 300 });
    try {
      const out: string[] = [];
      const run = await sandscale.sandboxes.run(box.id, 'echo hello && echo oops >&2 && exit 3', {
        region: box.region,
        onStdout: (d) => out.push(d),
        onStderr: (d) => out.push(d),
      });
      expect(run.exitCode).toBe(3);
      expect(run.stdout).toContain('hello');
      expect(out.join('')).toContain('hello');
      await sandscale.sandboxes.writeFile(box.id, '/workspace/hello.txt', 'hi', { region: box.region });
      expect(new TextDecoder().decode(await sandscale.sandboxes.readFile(box.id, '/workspace/hello.txt', { region: box.region }))).toBe('hi');
      const list = await sandscale.sandboxes.list({ region: box.region });
      expect(list.data.some((s) => s.id === box.id)).toBe(true);
    } finally {
      await sandscale.sandboxes.stop(box.id, { region: box.region });
    }
  }, 300_000);
});
