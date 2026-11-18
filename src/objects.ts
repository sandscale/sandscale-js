// Copyright 2026 Neural Inverse
// SPDX-License-Identifier: Apache-2.0

import type { CallOptions, Region, Transport } from './http.js';
import { date, opts } from './sandboxes.js';
import { hideSecret, withoutSecrets } from './secret.js';
import type {
  AccessKey,
  Bucket,
  BucketList,
  CreateAccessKeyOptions,
  CreatedAccessKey,
  CreateBucketOptions,
  DefaultRetention,
  LifecycleRule,
  ObjectsLimits,
  UpdateBucketOptions,
} from './models.js';

type Raw = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const rec = (v: unknown): Raw => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : {});

function retention(v: unknown): DefaultRetention | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const r = v as Raw;
  return { mode: str(r.Mode), days: num(r.Days) };
}

function toBucket(raw: Raw, region: Region | undefined): Bucket {
  const endpoints = rec(raw.Endpoints);
  const usage = raw.Usage === undefined || raw.Usage === null ? undefined : rec(raw.Usage);
  return {
    name: str(raw.Name),
    nrn: optStr(raw.Nrn),
    versioning: str(raw.Versioning),
    objectLock: raw.ObjectLock === true,
    defaultRetention: retention(raw.DefaultRetention),
    encryption: str(raw.Encryption),
    contentClass: str(raw.ContentClass),
    dataEvents: str(raw.DataEvents),
    presign: raw.Presign === true,
    allowUnsignedPayload: raw.AllowUnsignedPayload === true,
    hasPolicy: raw.HasPolicy === true,
    tags: Object.fromEntries(Object.entries(rec(raw.Tags)).filter((e): e is [string, string] => typeof e[1] === 'string')),
    createdAt: date(raw.CreatedAt),
    endpoints: { pathStyle: str(endpoints.PathStyle), virtualHosted: optStr(endpoints.VirtualHosted), signingRegion: str(endpoints.SigningRegion) },
    usage: usage && {
      keys: num(usage.Keys),
      versions: num(usage.Versions),
      bytes: num(usage.Bytes),
      uploads: num(usage.Uploads),
      reportedAt: date(usage.ReportedAt),
    },
    deleting: raw.Deleting === true,
    region,
    raw,
  };
}

function toAccessKey(raw: Raw, region: Region | undefined): AccessKey {
  return {
    accessKeyId: str(raw.AccessKeyId),
    nrn: optStr(raw.Nrn),
    principal: str(raw.Principal),
    description: str(raw.Description),
    status: str(raw.Status),
    createdAt: date(raw.CreatedAt),
    expiresAt: date(raw.ExpiresAt),
    permissions: strs(raw.Permissions),
    buckets: strs(raw.Buckets),
    prefixes: strs(raw.Prefixes),
    cidrs: strs(raw.CIDRs),
    region,
    raw,
  };
}

function ruleToWire(rule: LifecycleRule): Raw {
  const out: Raw = { ID: rule.id, Status: rule.status };
  if (rule.prefix !== undefined) out.Prefix = rule.prefix;
  if (rule.expirationDays !== undefined) out.Expiration = { Days: rule.expirationDays };
  if (rule.noncurrentVersionExpiration) {
    const n = rule.noncurrentVersionExpiration;
    out.NoncurrentVersionExpiration = { NoncurrentDays: n.noncurrentDays, ...(n.newerNoncurrentVersions !== undefined ? { NewerNoncurrentVersions: n.newerNoncurrentVersions } : {}) };
  }
  if (rule.expiredObjectDeleteMarker) out.ExpiredObjectDeleteMarker = true;
  if (rule.abortIncompleteMultipartUploadDays !== undefined) out.AbortIncompleteMultipartUpload = { DaysAfterInitiation: rule.abortIncompleteMultipartUploadDays };
  return out;
}

function ruleFromWire(raw: Raw): LifecycleRule {
  const exp = raw.Expiration === undefined ? undefined : rec(raw.Expiration);
  const non = raw.NoncurrentVersionExpiration === undefined ? undefined : rec(raw.NoncurrentVersionExpiration);
  const abort = raw.AbortIncompleteMultipartUpload === undefined ? undefined : rec(raw.AbortIncompleteMultipartUpload);
  return {
    id: str(raw.ID),
    prefix: optStr(raw.Prefix),
    status: str(raw.Status),
    expirationDays: exp ? num(exp.Days) : undefined,
    noncurrentVersionExpiration: non
      ? { noncurrentDays: num(non.NoncurrentDays), newerNoncurrentVersions: typeof non.NewerNoncurrentVersions === 'number' ? non.NewerNoncurrentVersions : undefined }
      : undefined,
    expiredObjectDeleteMarker: raw.ExpiredObjectDeleteMarker === true ? true : undefined,
    abortIncompleteMultipartUploadDays: abort ? num(abort.DaysAfterInitiation) : undefined,
  };
}

function wireRetention(r: DefaultRetention): Raw {
  return { Mode: r.mode, Days: r.days };
}

/**
 * Object storage (S3 API): buckets, lifecycle, policy and access keys, through Keystone's
 * account actions (`POST /api/v1/svc/objects/<Action>`). Quotas and plan allowance are the
 * server's. Use an access key with any S3 client for the data itself.
 */
export class Objects {
  constructor(private readonly t: Transport) {}

  async createBucket(options: CreateBucketOptions): Promise<Bucket> {
    const json: Raw = { Name: options.name };
    if (options.versioning !== undefined) json.Versioning = options.versioning;
    if (options.objectLock !== undefined) json.ObjectLock = options.objectLock;
    if (options.defaultRetention !== undefined) json.DefaultRetention = wireRetention(options.defaultRetention);
    if (options.contentClass !== undefined) json.ContentClass = options.contentClass;
    if (options.dataEvents !== undefined) json.DataEvents = options.dataEvents;
    if (options.presign !== undefined) json.Presign = options.presign;
    if (options.allowUnsignedPayload !== undefined) json.AllowUnsignedPayload = options.allowUnsignedPayload;
    if (options.tags !== undefined) json.Tags = options.tags;
    if (options.clientToken !== undefined) json.ClientToken = options.clientToken;
    const raw = await this.t.request<Raw>({ method: 'POST', path: '/api/v1/svc/objects/CreateBucket', json, ...opts(options) });
    return toBucket(raw, this.t.regionOf(options.region));
  }

  async listBuckets(options: CallOptions & { nextToken?: string; maxResults?: number } = {}): Promise<BucketList> {
    const json: Raw = {};
    if (options.nextToken !== undefined) json.NextToken = options.nextToken;
    if (options.maxResults !== undefined) json.MaxResults = options.maxResults;
    const raw = await this.t.request<Raw>({ method: 'POST', path: '/api/v1/svc/objects/ListBuckets', json, ...opts(options) });
    const region = this.t.regionOf(options.region);
    return { buckets: (Array.isArray(raw.Buckets) ? raw.Buckets : []).map((b) => toBucket(rec(b), region)), nextToken: optStr(raw.NextToken) };
  }

  /** One bucket with its usage and the month to date. */
  async getBucket(name: string, options: CallOptions = {}): Promise<Bucket> {
    const raw = await this.t.request<Raw>({ method: 'POST', path: '/api/v1/svc/objects/DescribeBucket', json: { Name: name }, ...opts(options) });
    return toBucket(raw, this.t.regionOf(options.region));
  }

  async updateBucket(name: string, options: UpdateBucketOptions = {}): Promise<Bucket> {
    const json: Raw = { Name: name };
    if (options.versioning !== undefined) json.Versioning = options.versioning;
    if (options.objectLock !== undefined) json.ObjectLock = options.objectLock;
    if (options.defaultRetention !== undefined) json.DefaultRetention = wireRetention(options.defaultRetention);
    if (options.clearDefaultRetention) json.ClearDefaultRetention = true;
    if (options.dataEvents !== undefined) json.DataEvents = options.dataEvents;
    if (options.contentClass !== undefined) json.ContentClass = options.contentClass;
    if (options.presign !== undefined) json.Presign = options.presign;
    if (options.allowUnsignedPayload !== undefined) json.AllowUnsignedPayload = options.allowUnsignedPayload;
    if (options.tags !== undefined) json.Tags = options.tags;
    const raw = await this.t.request<Raw>({ method: 'POST', path: '/api/v1/svc/objects/UpdateBucket', json, ...opts(options) });
    return toBucket(raw, this.t.regionOf(options.region));
  }

  async deleteBucket(name: string, options: CallOptions = {}): Promise<void> {
    await this.t.request({ method: 'POST', path: '/api/v1/svc/objects/DeleteBucket', json: { Name: name }, ...opts(options) });
  }

  /** Replaces the bucket's lifecycle rules. */
  async putLifecycle(name: string, rules: LifecycleRule[], options: CallOptions = {}): Promise<void> {
    await this.t.request({ method: 'POST', path: '/api/v1/svc/objects/PutBucketLifecycle', json: { Name: name, Rules: rules.map(ruleToWire) }, ...opts(options) });
  }

  async getLifecycle(name: string, options: CallOptions = {}): Promise<LifecycleRule[]> {
    const raw = await this.t.request<Raw>({ method: 'POST', path: '/api/v1/svc/objects/GetBucketLifecycle', json: { Name: name }, ...opts(options) });
    return (Array.isArray(raw.Rules) ? raw.Rules : []).map((r) => ruleFromWire(rec(r)));
  }

  async deleteLifecycle(name: string, options: CallOptions = {}): Promise<void> {
    await this.t.request({ method: 'POST', path: '/api/v1/svc/objects/DeleteBucketLifecycle', json: { Name: name }, ...opts(options) });
  }

  /** Sets the bucket policy (an S3 bucket policy document, as JSON text or an object). */
  async putPolicy(name: string, policy: string | Record<string, unknown>, options: CallOptions = {}): Promise<void> {
    const text = typeof policy === 'string' ? policy : JSON.stringify(policy);
    await this.t.request({ method: 'POST', path: '/api/v1/svc/objects/PutBucketPolicy', json: { Name: name, Policy: text }, ...opts(options) });
  }

  /** The bucket policy as JSON text. */
  async getPolicy(name: string, options: CallOptions = {}): Promise<string> {
    const raw = await this.t.request<Raw>({ method: 'POST', path: '/api/v1/svc/objects/GetBucketPolicy', json: { Name: name }, ...opts(options) });
    return str(raw.Policy);
  }

  async deletePolicy(name: string, options: CallOptions = {}): Promise<void> {
    await this.t.request({ method: 'POST', path: '/api/v1/svc/objects/DeleteBucketPolicy', json: { Name: name }, ...opts(options) });
  }

  /**
   * Creates an S3 access key. The secret access key is returned once, as the non-enumerable
   * `secretAccessKey` property of the result: it is not in `JSON.stringify`, `console.log`,
   * spread or the key's `raw`. Store it at once; Keystone cannot show it again.
   */
  async createAccessKey(options: CreateAccessKeyOptions = {}): Promise<CreatedAccessKey> {
    const json: Raw = {};
    if (options.description !== undefined) json.Description = options.description;
    if (options.expiresInDays !== undefined) json.ExpiresInDays = options.expiresInDays;
    if (options.permissions !== undefined) json.Permissions = options.permissions;
    if (options.buckets !== undefined) json.Buckets = options.buckets;
    if (options.prefixes !== undefined) json.Prefixes = options.prefixes;
    if (options.cidrs !== undefined) json.CIDRs = options.cidrs;
    const raw = await this.t.request<Raw>({ method: 'POST', path: '/api/v1/svc/objects/CreateAccessKey', json, ...opts(options) });
    const out = { accessKey: toAccessKey(rec(raw.AccessKey), this.t.regionOf(options.region)) };
    return hideSecret(out, 'secretAccessKey', raw.SecretAccessKey) as CreatedAccessKey;
  }

  /** Your access keys; `all: true` lists the organization's where the server allows it. */
  async listAccessKeys(options: CallOptions & { all?: boolean } = {}): Promise<AccessKey[]> {
    const json: Raw = {};
    if (options.all) json.All = true;
    const raw = await this.t.request<Raw>({ method: 'POST', path: '/api/v1/svc/objects/ListAccessKeys', json, ...opts(options) });
    const region = this.t.regionOf(options.region);
    return (Array.isArray(raw.AccessKeys) ? raw.AccessKeys : []).map((k) => toAccessKey(rec(withoutSecrets(rec(k), 'SecretAccessKey')), region));
  }

  /** Activates or deactivates an access key (`Active` or `Inactive`). */
  async updateAccessKey(accessKeyId: string, status: 'Active' | 'Inactive', options: CallOptions = {}): Promise<void> {
    await this.t.request({ method: 'POST', path: '/api/v1/svc/objects/UpdateAccessKey', json: { AccessKeyId: accessKeyId, Status: status }, ...opts(options) });
  }

  async deleteAccessKey(accessKeyId: string, options: CallOptions = {}): Promise<void> {
    await this.t.request({ method: 'POST', path: '/api/v1/svc/objects/DeleteAccessKey', json: { AccessKeyId: accessKeyId }, ...opts(options) });
  }

  /** The organization's object storage quotas and which features are available. */
  async limits(options: CallOptions = {}): Promise<ObjectsLimits> {
    const raw = await this.t.request<Raw>({ method: 'POST', path: '/api/v1/svc/objects/DescribeObjectsLimits', json: {}, ...opts(options) });
    return {
      enabled: raw.Enabled === true,
      reason: optStr(raw.Reason),
      region: str(raw.Region),
      quotas: (Array.isArray(raw.Quotas) ? raw.Quotas : []).map((q) => {
        const r = rec(q);
        return { quotaCode: str(r.QuotaCode), name: str(r.Name), value: num(r.Value), used: num(r.Used) };
      }),
      features: Object.fromEntries(Object.entries(rec(raw.Features)).map(([k, v]) => [k, { available: rec(v).Available === true, reason: optStr(rec(v).Reason) }])),
      raw,
    };
  }
}
