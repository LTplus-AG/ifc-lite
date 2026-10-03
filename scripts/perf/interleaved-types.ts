/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerBenchmarkMetrics } from '../../tests/benchmark/viewer-benchmark-page.js';

export interface IdentityLimits {
  cohortMs: number; teardownMs: number; identityMs: number; sampledTreeRssBytes: number;
  rssIntervalMs: number; digestBytes: number; oneBufferBytes: number; records: number; aaNoisePercent: number;
}
export interface CapturedIdentity {
  complete: true; sha256: string; flatMeshes: number; flatVertices: number; flatTriangles: number;
  templates: number; instanceOwners: number; occurrences: number; owners: number; digestBytes: number;
  channels: string; renderStats: unknown;
  model: { loadState: 'complete'; loadError: string | null; geometryLoadState: string | null;
    metadataLoadState: string | null; interactiveReady: boolean | null; propertiesReady: true;
    entityCount: number; propertyCount: number; propertyWitnessOwner: number | null; propertyWitness: unknown[] };
}
export interface SampleConfig {
  id: string; family: string; path: string; kind: 'AA' | 'AB'; pair: number; slot: number;
  arm: 'base' | 'candidate'; timeoutMs: number; file: string; origin: string; revision: string;
  defaultWasmPaths: string[]; hostBefore: { loadavg: string };
}
export interface SampleResult extends SampleConfig {
  status: 'started' | 'complete' | 'refused'; startedAt: string; readyAtMs?: number; finishedAt?: string;
  metrics?: ViewerBenchmarkMetrics; identity?: CapturedIdentity; colorFrame?: string | null;
  reason?: string; teardown?: string; logs?: string[]; errors?: string[];
  wasmResponses?: Array<{ url: string; status: number }>;
  runtime?: { userAgent: string; hardwareConcurrency: number; crossOriginIsolated: boolean;
    sharedArrayBuffer: boolean; browserVersion: string; workerIds: number[]; workerCount: number | null;
    renderer: string; workerPool: string; shardedLogs: string[] };
}
