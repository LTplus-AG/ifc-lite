/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Central perf-flag registry (#6962, perf charter #6954).
 *
 * Every runtime perf toggle the viewer ships is declared here, with an owner,
 * the condition under which it is deleted, and every way it can be set: a
 * `globalThis.__IFC_LITE_*` global (console / benchmark), a URL param, a
 * sticky localStorage key, the benchmark env var that injects it, and for a
 * ramp an optional PostHog feature-flag key.
 *
 * The existing global names, URL params and sticky keys are the bindings, so
 * every old spelling keeps working. `__IFC_LITE_*` globals are read only via
 * `readPerfFlagRaw` (`@ifc-lite/data`); geometry reads its three locally with
 * the bindings it exports (`GEOMETRY_PERF_FLAG_BINDINGS`), spread below.
 *
 * `scripts/check-perf-flags.mjs` (CI, node-tests) parses `PERF_FLAGS` and
 * fails on a ramp older than four weeks, a flag with no owner or removal
 * condition, or a `__IFC_LITE_*` read outside the registry and the reader.
 * Keep every metadata field a plain string literal so that lint can read it.
 *
 * Ramp steps (1% -> 25% -> 100%) are proposed in a thread and applied in
 * PostHog only after maintainer sign-off; the code only reads the result.
 */

import { readPerfFlagRaw, readPerfFlagUrlParam, type PerfFlagGlobalName } from '@ifc-lite/data';
import { GEOMETRY_PERF_FLAG_BINDINGS } from '@ifc-lite/geometry';
import { readAnalyticsFeatureFlag } from '../analytics.js';

/** A kill switch guards a default-on path; a ramp rolls a new path out. */
export type PerfFlagKind = 'kill-switch' | 'ramp';

/** JSON-compatible value a flag resolves to when nothing overrides it. */
export type PerfFlagDefault = number | boolean | string | null;

export interface PerfFlagBindings {
  /** `globalThis` property; read via `readPerfFlagRaw`. */
  readonly global?: PerfFlagGlobalName;
  /** URL query param. For a global-backed flag it applies when the global is unset. */
  readonly urlParam?: string;
  /** localStorage key a sticky URL override persists to. */
  readonly stickyKey?: string;
  /** `tests/benchmark/viewer-benchmark-page.ts` env var that injects the global. */
  readonly benchmarkEnv?: string;
  /** PostHog feature flag consulted for a ramp when nothing else is set. */
  readonly posthogKey?: string;
}

export interface PerfFlagDefinition {
  readonly id: string;
  readonly kind: PerfFlagKind;
  /** GitHub handle accountable for removing the flag. */
  readonly owner: string;
  /** Observable condition under which the flag and its old path are deleted. */
  readonly removalCondition: string;
  /** ISO date the flag entered the code (or this registry, if older history is squashed). */
  readonly introducedAt: string;
  readonly default: PerfFlagDefault;
  readonly bindings: PerfFlagBindings;
}

export const PERF_FLAGS = [
  {
    id: 'batchSizing',
    kind: 'kill-switch',
    owner: '@louistrue',
    removalCondition: 'Delete once adaptive batch sizing has run a release with no watchdog-stall report needing a field override (#1097).',
    introducedAt: '2026-06-13',
    default: null,
    bindings: { ...GEOMETRY_PERF_FLAG_BINDINGS.batchSizing, benchmarkEnv: 'VIEWER_BENCHMARK_BATCH_SIZING' },
  },
  {
    id: 'visibilityFilter',
    kind: 'kill-switch',
    owner: '@louistrue',
    removalCondition: 'Delete when load-time type filtering is driven by the viewer type-visibility state instead of a global (#1097).',
    introducedAt: '2026-06-13',
    default: null,
    bindings: { ...GEOMETRY_PERF_FLAG_BINDINGS.visibilityFilter, benchmarkEnv: 'VIEWER_BENCHMARK_VISIBILITY_FILTER' },
  },
  {
    id: 'shardScan',
    kind: 'kill-switch',
    owner: '@louistrue',
    removalCondition: 'Delete the serial pre-pass path once the sharded scan has shipped two releases with no field regression.',
    introducedAt: '2026-10-05',
    default: true,
    bindings: { ...GEOMETRY_PERF_FLAG_BINDINGS.shardScan, benchmarkEnv: 'VIEWER_BENCHMARK_SHARD_SCAN' },
  },
  {
    id: 'contribCull',
    kind: 'kill-switch',
    owner: '@louistrue',
    removalCondition: 'Delete the override once contribution culling thresholds have been stable for two releases (#1682).',
    introducedAt: '2026-07-11',
    default: 0.5,
    bindings: { global: '__IFC_LITE_CONTRIB_CULL', urlParam: 'perf.contribCull', benchmarkEnv: 'VIEWER_BENCHMARK_CONTRIB_CULL' },
  },
  {
    id: 'chunks',
    kind: 'kill-switch',
    owner: '@louistrue',
    removalCondition: 'Delete the unchunked scene path once spatial chunking has shipped two releases with no field regression (#1682).',
    introducedAt: '2026-07-11',
    default: 32,
    bindings: { global: '__IFC_LITE_CHUNKS', urlParam: 'perf.chunks', benchmarkEnv: 'VIEWER_BENCHMARK_CHUNKS' },
  },
  {
    id: 'gpuBudgetMb',
    kind: 'kill-switch',
    owner: '@louistrue',
    removalCondition: 'Delete the 0 kill switch once GPU residency eviction has shipped two releases with no field regression (#1682).',
    introducedAt: '2026-07-11',
    default: 2048,
    bindings: { global: '__IFC_LITE_GPU_BUDGET_MB', urlParam: 'perf.gpuBudgetMb', benchmarkEnv: 'VIEWER_BENCHMARK_GPU_BUDGET' },
  },
  {
    id: 'hostBudgetMb',
    kind: 'kill-switch',
    owner: '@louistrue',
    removalCondition: 'Delete the 0 kill switch once host residency eviction has shipped two releases with no field regression (#1682).',
    introducedAt: '2026-07-11',
    default: 3072,
    bindings: { global: '__IFC_LITE_HOST_BUDGET_MB', urlParam: 'perf.hostBudgetMb', benchmarkEnv: 'VIEWER_BENCHMARK_HOST_BUDGET' },
  },
  {
    id: 'lodPx',
    kind: 'kill-switch',
    owner: '@louistrue',
    removalCondition: 'Delete the 0 kill switch once LOD1 has shipped two releases with no visual-regression report (#1682).',
    introducedAt: '2026-07-11',
    default: 48,
    bindings: { global: '__IFC_LITE_LOD_PX', urlParam: 'perf.lodPx', benchmarkEnv: 'VIEWER_BENCHMARK_LOD_PX' },
  },
  {
    id: 'quantized',
    kind: 'kill-switch',
    owner: '@louistrue',
    removalCondition: 'Delete the f32-only path toggle once quantized vertices have shipped two releases with no precision report (#1682).',
    introducedAt: '2026-07-11',
    default: true,
    bindings: { global: '__IFC_LITE_QUANTIZED', urlParam: 'perf.quantized', benchmarkEnv: 'VIEWER_BENCHMARK_QUANTIZED' },
  },
  {
    id: 'geomTier',
    kind: 'kill-switch',
    owner: '@louistrue',
    removalCondition: 'Delete when the automatic tessellation tier needs no manual override in field reports for two releases.',
    introducedAt: '2026-10-05',
    default: 'auto',
    bindings: { urlParam: 'geomTier', stickyKey: 'ifc-lite-geom-tier' },
  },
  {
    id: 'geomWorkers',
    kind: 'kill-switch',
    owner: '@louistrue',
    removalCondition: 'Delete when the worker-count heuristic needs no manual override in field reports for two releases.',
    introducedAt: '2026-10-05',
    default: 'auto',
    bindings: { urlParam: 'geomWorkers', stickyKey: 'ifc-lite-geom-workers' },
  },
  {
    id: 'meshCache',
    kind: 'kill-switch',
    owner: '@louistrue',
    removalCondition: 'Delete the kill switch once the mesh-only cache tier has shipped two releases with no stale-cache report.',
    introducedAt: '2026-10-05',
    default: '1',
    bindings: { urlParam: 'meshCache', stickyKey: 'ifc-lite-mesh-cache' },
  },
  {
    id: 'perfMem',
    kind: 'kill-switch',
    owner: '@louistrue',
    removalCondition: 'Delete when memory phase records reach field telemetry and the console log is no longer needed.',
    introducedAt: '2026-10-05',
    default: '0',
    bindings: { urlParam: 'perfMem' },
  },
  {
    id: 'perfTrace',
    kind: 'kill-switch',
    owner: '@louistrue',
    removalCondition: 'Keep while the load-trace span API (#6956) is the benchmark and DevTools timing source; delete with it.',
    introducedAt: '2026-10-06',
    default: false,
    bindings: { global: '__IFC_LITE_PERF_TRACE', urlParam: 'perfTrace' },
  },
] as const satisfies readonly PerfFlagDefinition[];

export type PerfFlagId = (typeof PERF_FLAGS)[number]['id'];

const BY_ID: ReadonlyMap<string, PerfFlagDefinition> = new Map(PERF_FLAGS.map((flag) => [flag.id, flag]));

export function getPerfFlagDefinition(id: PerfFlagId): PerfFlagDefinition {
  const flag = BY_ID.get(id);
  if (!flag) throw new Error(`unknown perf flag: ${id}`);
  return flag;
}

function readSticky(key: string): string | null {
  try {
    const storage = (globalThis as { localStorage?: Pick<Storage, 'getItem'> }).localStorage;
    return typeof storage?.getItem === 'function' ? storage.getItem(key) : null;
  } catch (error) {
    console.warn(`[perf-flags] could not read sticky override ${key}`, error);
    return null;
  }
}

/**
 * Raw override of a flag, or `undefined` when nothing sets it (the flag's own
 * config module then applies its default). Precedence: global, URL param,
 * sticky key, then for a ramp the PostHog feature flag. Never blocks: a ramp
 * whose PostHog flags have not loaded yet reads as its default.
 */
export function readPerfFlag(id: PerfFlagId): unknown {
  return resolvePerfFlag(getPerfFlagDefinition(id));
}

/** `readPerfFlag` for any definition; the feature-flag source is injectable for tests. */
export function resolvePerfFlag(
  flag: PerfFlagDefinition,
  readFeatureFlag: (key: string) => unknown = readAnalyticsFeatureFlag,
): unknown {
  const { global, urlParam, stickyKey, posthogKey } = flag.bindings;
  if (global) {
    const value = readPerfFlagRaw({ global, urlParam });
    if (value !== undefined) return value;
  } else if (urlParam) {
    const raw = readPerfFlagUrlParam(urlParam);
    if (raw !== null) return raw;
  }
  if (stickyKey) {
    const raw = readSticky(stickyKey);
    if (raw !== null) return raw;
  }
  if (flag.kind === 'ramp' && posthogKey) return readFeatureFlag(posthogKey) ?? undefined;
  return undefined;
}

const MAX_STATE_LENGTH = 64;

function compactState(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > MAX_STATE_LENGTH ? `${text.slice(0, MAX_STATE_LENGTH - 1)}…` : text;
}

/**
 * Boolean flags accept `1`/`0` (and their URL spellings) as on/off, so compare
 * those as the boolean they mean: `?perf.quantized=1` is the default, not an arm.
 */
function effectiveState(value: unknown, fallback: PerfFlagDefault): unknown {
  if (typeof fallback !== 'boolean') return value;
  if (value === 1 || value === '1' || value === true) return true;
  if (value === 0 || value === '0' || value === false) return false;
  return value;
}

/**
 * Every flag whose current state differs from its default, as a compact
 * `{ id: value }` record (values stringified, capped at 64 chars). Meant to be
 * attached to field telemetry (#6961) so verdicts can be split by arm; an
 * empty record means the session ran every default.
 */
export function activePerfFlags(): Record<string, string> {
  const active: Record<string, string> = {};
  for (const flag of PERF_FLAGS) {
    const value = readPerfFlag(flag.id);
    if (value === undefined || value === null) continue;
    const state = compactState(effectiveState(value, flag.default));
    if (state !== compactState(flag.default)) active[flag.id] = state;
  }
  return active;
}
