<!-- Copyright 2026 Neural Inverse -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @sandscale/sdk

TypeScript SDK for [Sandscale](https://sandscale.dev): sandboxes, workspaces and build hosts
over the Sandscale API (`https://api.sandscale.dev`). No runtime dependencies (it uses
`fetch`); Node.js 22 or later.

The server decides everything: permissions, plan limits, quotas, entitlements, kill switches
and regions. The SDK sends your request as you (your API key or your own sign-in token) and
hands back the server's answer, including its error code and message.

```bash
npm install @sandscale/sdk
```

Documentation: https://sandscale.dev/docs. Source and issues: https://github.com/sandscale/sandscale-js. Licensed under Apache-2.0.

## Quick start

```ts
import { Sandscale } from '@sandscale/sdk';

const sandscale = new Sandscale({ apiKey: process.env.SANDSCALE_API_KEY });

const box = await sandscale.sandboxes.create({ template: 'builtin:python', timeoutSeconds: 600 });
const run = await sandscale.sandboxes.run(box.id, 'python -c "print(6*7)"', {
  region: box.region,
  onStdout: (text) => process.stdout.write(text),
  onStderr: (text) => process.stderr.write(text),
});
console.log('exit code', run.exitCode);
await sandscale.sandboxes.stop(box.id, { region: box.region });
```

## Authentication

| Option | Environment | |
|---|---|---|
| `apiKey` | `SANDSCALE_API_KEY` | A Sandscale API key. |
| `token` | | The person's own sign-in access token, or a function returning a current one (called before every request, so it can refresh). |
| `orgId` | `SANDSCALE_ORG_ID` | Sent as `X-Org-ID`; required by workspace and build host calls, whose routes name the organization. |
| `baseUrl` | `SANDSCALE_BASE_URL` | Default `https://api.sandscale.dev`. `https` only (plain `http` only to a loopback host). |

Credentials are held in memory and sent only to the configured API origin and the region
origins the server lists; redirects are refused so a credential never follows one.

## Regions

One account works in every Sandscale region. Pass `region: 'us' | 'eu'` on the client (the
default for every call) or on any call:

| Region | API |
|---|---|
| none | `https://api.sandscale.dev`, the front door: it routes to the request's region, US by default |
| `us` | `https://api.us.sandscale.dev` |
| `eu` | `https://api.eu.sandscale.dev` (when Sandscale opens in eu1) |

A region id such as `us1` names the same region. `regionUrls` sets origins explicitly. Against
another `baseUrl` (a self-hosted Keystone) a region is looked up in that server's public region
list (`GET /api/v1/regions`).

Resources carry the `region` they were read from; pass it to later calls on them. Lists
without a region read every Sandscale region the front door reports live and merge the results;
`pages` says, per region, the next cursor or the error that region answered, so one unavailable
region does not hide the others.

## API

| Area | Methods |
|---|---|
| `sandboxes` | `create`, `get`, `list`, `run` (live stdout and stderr, exit code), `logs`, `writeFile`, `readFile`, `listFiles`, `pause`, `resume`, `snapshot`, `listSnapshots`, `stop`, `exposePort`, `listPorts`, `closePort`, `createPreviewLink`, `listPreviewLinks`, `revokePreviewLink`, `sshInfo`, `sshCertificate` |
| `snapshots` | `list` (with the quota used), `get`, `delete` |
| `templates` | `create`, `list`, `get`, `delete`, `buildStatus` |
| `policy` | `get`, `set` (limits, egress allowlist, presets) |
| `webhooks` | `list`, `create`, `delete`, `verifyWebhookSignature` |
| `traces` | `list`, `get`, `getExport`, `setExport`, `deleteExport`, `testExport` |
| `objects` | `createBucket`, `listBuckets`, `getBucket`, `updateBucket`, `deleteBucket`, `putLifecycle`, `getLifecycle`, `deleteLifecycle`, `putPolicy`, `getPolicy`, `deletePolicy`, `createAccessKey`, `listAccessKeys`, `updateAccessKey`, `deleteAccessKey`, `limits` |
| `workspaces` | `list`, `get`, `start`, `stop`, `connectInfo`, `create`, `update`, `delete`, `rebuild`, `openLink`, `listBackups`, `createBackup`, `verifyBackup`, `listApps`, `shareApp` |
| `buildHosts` | `listPools`, `list`, `get`, `start` (take a lease of a pool), `stop` (release it), `connectInfo`, `sshCertificate`, `renew`, `kill`, `listRuns`, `getRun`, `listArtifacts`, `getArtifact`, `downloadArtifact`, `deleteArtifact`, `listCaches`, `listPoolCaches`, `purgePoolCache` |
| `labHosts` | `list`, `get`, `revoke` |
| `agentCloud` | `createTask`, `listTasks`, `getTask`, `cancelTask` |
| `account` | `billing`, `changePlan`, `cancelPendingPlanChange`, `setOverage`, `checkout`, `usage`, `regions`, `listApiKeys`, `createApiKey`, `rotateApiKey`, `deleteApiKey` |

`sandboxes.create` takes `template` (an organization template or a built-in such as
`builtin:base`), `snapshotId`, `cpuCount`, `memoryMb`, `diskMb`, `timeoutSeconds`, `env`,
`vaultEnv` (Keystone Vault values: `[{ name, path, field }]`, read by the server as you and
given to the sandbox only), `name`, `labels`, `metadata`, `network` (`none`, or `allowlist` on a
plan that has network), `image` (an OCI image pinned by digest), `runtime` and `environmentId`.

`sandboxes.run` waits for the command and returns `{ runId, exitCode, stdout, stderr,
durationMs, oomKilled, timedOut, streamed }`. With `onStdout`/`onStderr` it starts the command
without waiting (`wait: false`): the server answers with the run's id, and the output arrives
live from that run's log stream, after the organization's DLP rules. The server may redact it,
or end the stream with `dlp_unavailable`, raised as a `ServerError`. The exit code comes from
the stream's end. A server that answers with the finished result instead (a sandbox without live
output) gets the callbacks the final output once (`streamed: false`).

## More examples

```ts
// Ports and preview links
const port = await sandscale.sandboxes.exposePort(box.id, 8080, { ttlSeconds: 3600 });
const link = await sandscale.sandboxes.createPreviewLink(box.id, port.id, { visibility: 'team' });
console.log(link.url);
const cert = await sandscale.sandboxes.sshCertificate(box.id, publicKey); // cert.knownHosts, cert.certificate

// Organization snapshots, templates, policy
const { data, usage } = await sandscale.snapshots.list();
await sandscale.templates.create({ name: 'py-ci', image: 'ghcr.io/acme/py@sha256:...' });
await sandscale.policy.set({ egressAllowlist: ['pypi.org'], egressPresets: ['npm'] });

// Webhooks: the signing secret is shown once, as a non-enumerable property
const hook = await sandscale.webhooks.create({ url: 'https://example.com/hook', events: ['run.completed'] });
store(hook.secret); // never log it
// in your handler, with the raw body and the X-Keystone-Signature header:
const ok = await verifyWebhookSignature(req.headers['x-keystone-signature'], rawBody, secret);

// Run traces and OpenTelemetry export
const { data: runs } = await sandscale.traces.list({ limit: 10 });
const trace = await sandscale.traces.get(runs[0].traceId);
await sandscale.traces.setExport({ protocol: 'otlp_http', endpoint: 'https://otel.example.com', headers: { 'DD-API-KEY': process.env.DD_KEY! } });

// Object storage: the secret access key is returned once
const bucket = await sandscale.objects.createBucket({ name: 'artifacts', versioning: 'Enabled' });
await sandscale.objects.putLifecycle(bucket.name, [{ id: 'tmp', prefix: 'tmp/', status: 'Enabled', expirationDays: 7 }]);
const key = await sandscale.objects.createAccessKey({ buckets: ['artifacts'], expiresInDays: 90 });
console.log(key.accessKey.accessKeyId); // key.secretAccessKey is not in JSON.stringify or console.log

// Workspaces
const { workspace } = await sandscale.workspaces.create({ name: 'dev', templateId: 'tpl-1', repository: 'github.com/acme/app' });
const open = await sandscale.workspaces.openLink(workspace.id, 'vscode');
const backup = await sandscale.workspaces.createBackup(workspace.id);
await sandscale.workspaces.verifyBackup(backup.id);
await sandscale.workspaces.shareApp(workspace.id, 'web', 'members');

// Build hosts and lab hosts
await sandscale.buildHosts.renew(lease.id, 3600);
const runsOnLease = await sandscale.buildHosts.listRuns(lease.id);
const { data: labs } = await sandscale.labHosts.list();

// Agent Cloud: Keystone's lead routes refuse API keys, so sign in as the person (token)
const person = new Sandscale({ token: () => currentAccessToken(), orgId });
const task = await person.agentCloud.createTask({ repository: 'github.com/acme/app', brief: 'Fix the flaky test', engine: 'claude_code' });
await person.agentCloud.cancelTask(task.id);

// Account: the server decides every plan, price and limit
const billing = await sandscale.account.billing();
await sandscale.account.setOverage(true);
const used = await sandscale.account.usage();
const created = await sandscale.account.createApiKey({ name: 'ci', expiresAt: new Date(Date.now() + 30 * 864e5) }); // created.key shown once
```

Secrets the server shows once (webhook signing secret, object storage secret access key,
API key) are non-enumerable properties of the result and are removed from `raw`; the SDK never
logs anything. Webhook test, redeliver and delivery log are not served yet (they come with the
signed compute webhooks) and are not in this SDK; `policy.set({ hibernation: 'on' | 'off' | 'default' })` sets hibernation between tool calls;
`keepAwake` retries a waking sandbox (`SandboxWakingError`) before raising.

## Errors

Every API error is a `SandscaleError` with the server's `status`, `code`, `message`,
`requestId` and `details`. Subclasses let you catch a family:

| Class | When |
|---|---|
| `InvalidRequestError` | 400, 413, 422 |
| `AuthenticationError` | 401 |
| `PermissionDeniedError` | 403 |
| `NotFoundError` | 404 |
| `ConflictError` | 409 (paused, ended, busy) |
| `LimitExceededError` | 402, or a quota or limit code (`quota_exceeded`, `snapshot_quota_exceeded`, `port_exposure_limit`) |
| `RateLimitError` | 429, with `retryAfterMs` |
| `EntitlementError` | `not_entitled`, `payment_required`, `entitlement_*` (not `entitlement_unavailable`), `plan_*`, `*_not_in_plan` |
| `RegionError` | `wrong_region` (with `region`), `region_*` |
| `KillSwitchError` | `kill_switch_*`, `*_kill_switch*` |
| `ServerError` | 5xx; `retryable` is true for 502, 503 and 504, `retryAfterMs` carries Retry-After |
| `ServiceUnavailableError` | 503 (a `ServerError`), including `entitlement_unavailable` |
| `SandboxWakingError` | 503 `sandbox_waking`: the sandbox is resuming; retry after `retryAfterMs` |
| `ConnectionError` | no answer: connection failure or timeout |

`ConfigurationError` (not a `SandscaleError`) is thrown before any request when the client
cannot be configured safely.

## Retries

Only safe calls (`GET`) are retried, at most `maxRetries` times (default 2), after a
connection error, 429, 502, 503 or 504, with exponential backoff and full jitter (at most 8 s),
or the server's `Retry-After` (at most 60 s). Kill switch, entitlement and region refusals are
never retried. Calls that change something (`POST`, `PUT`, `DELETE`) are sent once.

## Known gaps

- **Cross-region credentials.** Until the global plane syncs API keys and sign-in sessions to
  every region, a credential of one region is refused in another with `wrong_region`
  (`RegionError`, with `region`).
- **Vault environment on sandboxes** needs a server that supports `vault_env`. A server from before it ignores the
  field, so the sandbox starts without those variables.

## Tests

```bash
npm ci && npm test            # unit tests against a local mock server, route contract
SANDSCALE_API_KEY=... npm test # also the integration test (starts and stops one sandbox)
```

`test/routes.test.ts` fails when the server stops mounting a route this SDK calls (checked against the
server route inventory when the tests run inside the Keystone source tree, skipped elsewhere) or when the SDK calls a route it does not list.
