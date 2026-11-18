// Copyright 2026 Neural Inverse
// SPDX-License-Identifier: Apache-2.0

import { enc, type CallOptions, type Transport } from './http.js';
import { date, opts } from './sandboxes.js';
import { hideSecret, withoutSecrets } from './secret.js';
import type {
  ApiKey,
  ApiKeyList,
  Billing,
  ChangePlanOptions,
  Checkout,
  CreateApiKeyOptions,
  CreatedApiKey,
  CreditBalance,
  PlanOffer,
  PlanState,
  RegionInfo,
  RotateApiKeyOptions,
  Usage,
} from './models.js';

type Raw = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const rec = (v: unknown): Raw => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : {});

function toOffer(raw: Raw): PlanOffer {
  return {
    plan: str(raw.plan),
    name: str(raw.name),
    monthlyMinor: num(raw.monthly_minor),
    annualMonthlyMinor: num(raw.annual_monthly_minor),
    currency: str(raw.currency),
    perSeat: raw.per_seat === true,
    includedVcpuHours: num(raw.included_vcpu_hours),
    maxConcurrentBoxes: num(raw.max_concurrent_boxes),
    maxVcpuPerBox: num(raw.max_vcpu_per_box),
    networkEgress: raw.network_egress === true,
    maxLeaseHours: num(raw.max_lease_hours),
    objectStorageGb: num(raw.object_storage_gb),
    overageAllowed: raw.overage_allowed === true,
    overageMinorPerVcpuHour: num(raw.overage_minor_per_vcpu_hour),
    features: strs(raw.features),
    raw,
  };
}

function toState(raw: Raw): PlanState {
  return {
    plan: str(raw.plan),
    interval: optStr(raw.interval),
    paidSeats: num(raw.paid_seats),
    overageEnabled: raw.overage_enabled === true,
    subscriptionStatus: optStr(raw.subscription_status),
    currentPeriodEnd: date(raw.current_period_end),
    cancelAtPeriodEnd: raw.cancel_at_period_end === true,
    pendingPlan: optStr(raw.pending_plan),
    pendingInterval: optStr(raw.pending_interval),
    pendingEffectiveAt: date(raw.pending_effective_at),
    raw,
  };
}

function toBalance(raw: Raw): CreditBalance {
  return {
    month: str(raw.month),
    resetsAt: date(raw.resets_at),
    includedVcpuHours: str(raw.included_vcpu_hours),
    usedVcpuHours: str(raw.used_vcpu_hours),
    remainingVcpuHours: str(raw.remaining_vcpu_hours),
    overageVcpuHours: str(raw.overage_vcpu_hours),
    raw,
  };
}

function toApiKey(raw: Raw): ApiKey {
  return {
    id: str(raw.id),
    name: str(raw.name),
    keyPrefix: str(raw.key_prefix),
    scopes: strs(raw.scopes),
    expiresAt: date(raw.expires_at),
    lastUsedAt: date(raw.last_used_at),
    revokedAt: date(raw.revoked_at),
    createdAt: date(raw.created_at),
    state: str(raw.state),
    raw: withoutSecrets(raw, 'key'),
  };
}

function toCreatedKey(raw: Raw): CreatedApiKey {
  const key = {
    ...toApiKey(raw),
    rotatedFrom: optStr(raw.rotated_from),
    previousExpiresAt: date(raw.previous_expires_at),
  };
  return hideSecret(key, 'key', raw.key) as CreatedApiKey;
}

/**
 * The account of your organization: Sandscale billing, usage across regions, the regions and your
 * API keys. The server decides every plan, price and limit; these calls only carry your request
 * and its answer. Billing needs an organization id (`orgId`); plan changes and API keys need your
 * own sign-in token, not an API key.
 */
export class Account {
  constructor(private readonly t: Transport) {}

  private org(): string {
    return enc(this.t.requireOrg());
  }

  /** The plan state, the offer in force, the credit balance and the price book. */
  async billing(options: CallOptions = {}): Promise<Billing> {
    const raw = await this.t.request<Raw>({ method: 'GET', path: `/api/v1/orgs/${this.org()}/sandscale/billing`, ...opts(options) });
    return {
      state: toState(rec(raw.state)),
      offer: toOffer(rec(raw.offer)),
      balance: toBalance(rec(raw.balance)),
      plans: (Array.isArray(raw.plans) ? raw.plans : []).map((p) => toOffer(rec(p))),
      raw,
    };
  }

  /**
   * Changes the plan of a live subscription: an upgrade applies at once (prorated), a downgrade
   * at the period end, Team seats as the server's rules say. 409 `checkout_required` without a
   * subscription: start one with {@link checkout}. Returns the plan state.
   */
  async changePlan(options: ChangePlanOptions): Promise<PlanState> {
    const json: Raw = { plan: options.plan };
    if (options.interval !== undefined) json.interval = options.interval;
    if (options.seats !== undefined) json.seats = options.seats;
    const raw = await this.t.request<Raw>({ method: 'POST', path: `/api/v1/orgs/${this.org()}/sandscale/billing/plan`, json, ...opts(options) });
    return toState(rec(raw.state ?? raw));
  }

  /** Withdraws a waiting downgrade (409 `no_pending_change` without one). */
  async cancelPendingPlanChange(options: CallOptions = {}): Promise<PlanState> {
    const raw = await this.t.request<Raw>({ method: 'DELETE', path: `/api/v1/orgs/${this.org()}/sandscale/billing/plan/pending`, ...opts(options) });
    return toState(rec(raw?.state ?? raw ?? {}));
  }

  /** Turns pay-as-you-go overage on or off (409 `overage_not_in_plan` on Free). Needs a signed-in person. */
  async setOverage(enabled: boolean, options: CallOptions = {}): Promise<PlanState> {
    const raw = await this.t.request<Raw>({ method: 'PUT', path: `/api/v1/orgs/${this.org()}/sandscale/billing/overage`, json: { enabled }, ...opts(options) });
    return toState(rec(raw.state ?? raw));
  }

  /** Starts a Checkout session for a paid plan; open the returned `url` to pay. */
  async checkout(options: ChangePlanOptions): Promise<Checkout> {
    const json: Raw = { plan: options.plan };
    if (options.interval !== undefined) json.interval = options.interval;
    if (options.seats !== undefined) json.seats = options.seats;
    const raw = await this.t.request<Raw>({ method: 'POST', path: `/api/v1/orgs/${this.org()}/sandscale/billing/checkout`, json, ...opts(options) });
    return { id: str(raw.id), url: str(raw.url), plan: str(raw.plan), interval: str(raw.interval), seats: num(raw.seats), expiresAt: date(raw.expires_at), raw };
  }

  /** Usage of the month across every region: vCPU seconds used and left, and the boxes running. */
  async usage(options: CallOptions = {}): Promise<Usage> {
    const raw = await this.t.request<Raw>({ method: 'GET', path: '/api/v1/sandscale/usage', ...opts(options) });
    return {
      month: str(raw.month),
      vcpuSecondsUsed: num(raw.vcpu_seconds_used),
      vcpuSecondsLeft: num(raw.vcpu_seconds_left),
      runningBoxes: num(raw.running_boxes),
      runningByRegion: Object.fromEntries(Object.entries(rec(raw.running_by_region)).filter((e): e is [string, number] => typeof e[1] === 'number')),
      raw,
    };
  }

  /** The regions the server lists (public). */
  async regions(options: CallOptions = {}): Promise<RegionInfo[]> {
    const raw = await this.t.request<{ regions?: Raw[] }>({ method: 'GET', path: '/api/v1/regions', ...opts(options) });
    return (raw.regions ?? []).map((r) => ({ id: str(r.id), status: str(r.status), apiUrl: optStr(r.api_url), raw: r }));
  }

  async listApiKeys(options: CallOptions = {}): Promise<ApiKeyList> {
    const raw = await this.t.request<{ api_keys?: Raw[]; limits?: { max_days?: number; max_active?: number } }>({
      method: 'GET',
      path: '/api/v1/account/api-keys',
      ...opts(options),
    });
    return { apiKeys: (raw.api_keys ?? []).map(toApiKey), limits: { maxDays: raw.limits?.max_days, maxActive: raw.limits?.max_active } };
  }

  /**
   * Creates a personal API key. The key itself is the non-enumerable `key` property of the
   * result, shown once: it is not in `JSON.stringify`, `console.log` or `raw`.
   */
  async createApiKey(options: CreateApiKeyOptions): Promise<CreatedApiKey> {
    const expires = options.expiresAt instanceof Date ? options.expiresAt.toISOString() : options.expiresAt;
    const json: Raw = { name: options.name, expires_at: expires };
    if (options.scopes !== undefined) json.scopes = options.scopes;
    const raw = await this.t.request<Raw>({ method: 'POST', path: '/api/v1/account/api-keys', json, ...opts(options) });
    return toCreatedKey(raw);
  }

  /** Replaces a key with a new one; the old one keeps working for `overlapSeconds`. */
  async rotateApiKey(id: string, options: RotateApiKeyOptions = {}): Promise<CreatedApiKey> {
    const json: Raw | undefined = options.overlapSeconds !== undefined ? { overlap_seconds: options.overlapSeconds } : undefined;
    const raw = await this.t.request<Raw>({ method: 'POST', path: `/api/v1/account/api-keys/${enc(id)}/rotate`, json, ...opts(options) });
    return toCreatedKey(raw);
  }

  async deleteApiKey(id: string, options: CallOptions = {}): Promise<void> {
    await this.t.request({ method: 'DELETE', path: `/api/v1/account/api-keys/${enc(id)}`, ...opts(options) });
  }
}
