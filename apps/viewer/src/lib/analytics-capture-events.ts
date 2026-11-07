/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// posthog-js _runBeforeSend requires token; distinct_id is ingestion identity.
// No page, referrer, device metadata or arbitrary SDK property is needed here.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function captureSdkProperty(key: string, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (key === '$lib') return value === 'web';
  if (key === 'token') return /^phc_[A-Za-z0-9]{16,128}$/.test(value);
  return (key === 'distinct_id' || key === '$session_id') && UUID.test(value);
}

// Gaussian capture diagnostics (#8568). Content-free by construction: only
// closed vocabularies, buckets and session counters. Never a file name, path,
// URL, coordinate, count of a specific capture or any decoded value. The
// contract is enforced at compile time by the property types and again at
// PostHog's before_send boundary by `scrubCaptureEvent`. Dependency-free, like
// ./analytics-export-events.ts, so it is unit-testable without posthog-js.

export const CAPTURE_LOAD_OUTCOMES = ['completed', 'failed', 'cancelled', 'refused'] as const;
export const CAPTURE_FORMATS = ['gaussian-ply', 'splat'] as const;
/** Fixed failure ids; `refused` ones end before decoding, `failed` ones after. */
export const CAPTURE_FAILURE_CODES = [
  'gaussian_disabled', 'gaussian_invalid_input', 'gaussian_limit_capture_bytes', 'gaussian_limit_capture_splats',
  'gaussian_limit_sh_degree', 'gaussian_limit_scene_splats', 'gaussian_webgpu_unavailable',
  'gaussian_renderer_initializing', 'gaussian_renderer_lost', 'gaussian_renderer_disposed',
  'gaussian_renderer_blocked', 'gaussian_load_failed',
] as const;
export const CAPTURE_SIZE_BUCKETS = ['lt_10mb', '10_50mb', '50_200mb', '200_500mb', 'gt_500mb'] as const;
export const CAPTURE_SPLAT_BUCKETS = ['unknown', 'lt_100k', '100k_500k', '500k_1m', 'gt_1m'] as const;
export const CAPTURE_DEVICE_EVENTS = ['lost', 'recovered', 'recovery_failed'] as const;

export type CaptureLoadOutcome = (typeof CAPTURE_LOAD_OUTCOMES)[number];
export type CaptureFormat = (typeof CAPTURE_FORMATS)[number];
export type CaptureFailureCode = (typeof CAPTURE_FAILURE_CODES)[number];

export interface CaptureLoadProperties {
  outcome: CaptureLoadOutcome;
  /** Present for `failed` and `refused` only. */
  code?: CaptureFailureCode;
  format: CaptureFormat;
  size_bucket: (typeof CAPTURE_SIZE_BUCKETS)[number];
  splat_bucket: (typeof CAPTURE_SPLAT_BUCKETS)[number];
}

export interface CaptureDeviceProperties {
  phase: (typeof CAPTURE_DEVICE_EVENTS)[number];
  /** Session totals while captures were loaded. */
  loss_count: number;
  recovery_count: number;
}

export const CAPTURE_LOAD_EVENT = 'gaussian_capture_load';
export const CAPTURE_DEVICE_EVENT = 'gaussian_capture_device';

/** Coarse file size: never the exact byte count, which can fingerprint a file. */
export function captureSizeBucket(bytes: number): CaptureLoadProperties['size_bucket'] {
  const mb = bytes / 1_000_000;
  return mb < 10 ? 'lt_10mb' : mb < 50 ? '10_50mb' : mb < 200 ? '50_200mb' : mb <= 500 ? '200_500mb' : 'gt_500mb';
}

/** Coarse splat count from the header; `unknown` when admission could not read one. */
export function captureSplatBucket(count: number | undefined): CaptureLoadProperties['splat_bucket'] {
  if (count === undefined || !Number.isFinite(count) || count <= 0) return 'unknown';
  return count < 100_000 ? 'lt_100k' : count < 500_000 ? '100k_500k' : count <= 1_000_000 ? '500k_1m' : 'gt_1m';
}

const ENUMS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  [CAPTURE_LOAD_EVENT]: {
    outcome: CAPTURE_LOAD_OUTCOMES, code: CAPTURE_FAILURE_CODES, format: CAPTURE_FORMATS,
    size_bucket: CAPTURE_SIZE_BUCKETS, splat_bucket: CAPTURE_SPLAT_BUCKETS,
  },
  [CAPTURE_DEVICE_EVENT]: { phase: CAPTURE_DEVICE_EVENTS },
};
const COUNTERS: Readonly<Record<string, readonly string[]>> = {
  [CAPTURE_LOAD_EVENT]: [],
  [CAPTURE_DEVICE_EVENT]: ['loss_count', 'recovery_count'],
};

/** Runtime allowlist at PostHog's before_send boundary: undeclared keys and out-of-vocabulary values are dropped. */
export function scrubCaptureEvent<T extends { event?: string; properties?: Record<string, unknown> } | null>(event: T): T {
  const name = event?.event;
  if (!event?.properties || !name || !Object.prototype.hasOwnProperty.call(ENUMS, name)) return event;
  const enums = ENUMS[name];
  const counters = COUNTERS[name];
  for (const [key, value] of Object.entries(event.properties)) {
    if (captureSdkProperty(key, value)) continue;
    const allowed = Object.prototype.hasOwnProperty.call(enums, key) ? enums[key] : undefined;
    const valid = allowed ? typeof value === 'string' && allowed.includes(value)
      : counters.includes(key) && Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 100;
    if (!valid) delete event.properties[key];
  }
  return event;
}
