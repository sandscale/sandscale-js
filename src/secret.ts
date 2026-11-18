// Copyright 2026 Neural Inverse
// SPDX-License-Identifier: Apache-2.0

/**
 * Some answers carry a secret the server shows once (a webhook signing secret, an object storage
 * secret access key, an API key). The SDK never logs anything, and it keeps these values out of
 * accidental output too: the property is defined non-enumerable, so `JSON.stringify`, `console.log`,
 * object spread and `Object.entries` leave it out, and it is removed from the `raw` copy of the
 * answer. Read it by name, once, and store it where it belongs.
 */
export function hideSecret<T extends object>(target: T, name: string, value: unknown): T {
  Object.defineProperty(target, name, { value: typeof value === 'string' ? value : '', enumerable: false, writable: false, configurable: false });
  return target;
}

/** A shallow copy of a raw answer without the named secret members. */
export function withoutSecrets(raw: Record<string, unknown>, ...names: string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...raw };
  for (const n of names) delete copy[n];
  return copy;
}
