/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure logic of the native GPU count driver (#6993, native-count-driver.mts):
 * the exact query, the sample plan, the per-sample witness verdict, the
 * cross-sample repeat summary and receipt hashing. No browser here, so every
 * refusal is testable (native-count-evidence.test.ts).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { metadataCompletionSpan } from '../../tests/benchmark/metadata-render-readiness.js';
import type { LoadTraceSnapshotJson } from '../../tests/benchmark/load-trace-metrics.js';
import type { GpuHealth } from '../../tests/benchmark/gpu-health.js';

/** The literal URL query #6993 acceptance names; never rebuilt from parts. */
export const NATIVE_COUNT_QUERY = '?perfTrace=1&geomWorkers=4&meshCache=0&perf.benchmarkUploads=1'
  + '&perf.batchSizing=%7B%22targetMs%22%3A8000%2C%22minJobs%22%3A64%2C%22maxJobs%22%3A64%7D';

export const NATIVE_COUNT_FIXTURES = [
  { key: 'FZK', path: 'tests/models/ara3d/AC20-FZK-Haus.ifc' },
  { key: 'Snowdon', path: 'tests/models/various/01_Snowdon_Towers_Sample_Structural(1).ifc' },
] as const;
export const SAMPLES_PER_FIXTURE = 2;

/** The canonical input route the driver exercises (never `?model=` autoload). */
export const LOAD_ROUTE = 'input[type=file] -> useIfcLoader.loadFile';

export interface CountSettings {
  perfTrace: 1;
  geomWorkers: number;
  meshCache: 0;
  benchmarkUploads: 1;
  batchSizing: { targetMs: number; minJobs: number; maxJobs: number };
}

const QUERY_KEYS = ['perfTrace', 'geomWorkers', 'meshCache', 'perf.benchmarkUploads', 'perf.batchSizing'];

/** Decode a count query, refusing anything that is not a pinned count cohort. */
export function decodeCountQuery(query: string): CountSettings {
  if (!query.startsWith('?')) throw new Error('query must start with "?"');
  const params = new URLSearchParams(query.slice(1));
  const keys = [...params.keys()];
  const unexpected = keys.filter((key) => !QUERY_KEYS.includes(key));
  if (unexpected.length) throw new Error(`unexpected query parameter(s): ${unexpected.join(', ')}`);
  for (const key of QUERY_KEYS) {
    const count = keys.filter((k) => k === key).length;
    if (count !== 1) throw new Error(`query must carry ${key} exactly once (found ${count})`);
  }
  const exact = (key: string, value: string) => {
    if (params.get(key) !== value) throw new Error(`${key} must be ${value}, got ${params.get(key)}`);
  };
  exact('perfTrace', '1'); exact('meshCache', '0'); exact('perf.benchmarkUploads', '1');
  const workers = params.get('geomWorkers') ?? '';
  if (!/^([1-9]|1[0-6])$/.test(workers)) throw new Error(`geomWorkers must pin 1-16 workers, got ${workers}`);
  let sizing: unknown;
  try { sizing = JSON.parse(params.get('perf.batchSizing') ?? ''); }
  catch (cause) { throw new Error('perf.batchSizing is not JSON', { cause }); }
  const field = (name: string) => {
    const value: unknown = sizing && typeof sizing === 'object' ? Reflect.get(sizing, name) : undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new Error(`perf.batchSizing.${name} must be a positive integer`);
    return value;
  };
  const batchSizing = { targetMs: field('targetMs'), minJobs: field('minJobs'), maxJobs: field('maxJobs') };
  if (batchSizing.minJobs !== batchSizing.maxJobs) throw new Error('perf.batchSizing must pin minJobs === maxJobs for a count cohort');
  return { perfTrace: 1, geomWorkers: Number(workers), meshCache: 0, benchmarkUploads: 1, batchSizing };
}

export interface PlannedSample { index: number; fixture: string; path: string; iteration: number; url: string; route: string }

/** Every sample in run order: each fixture's fresh loads back to back, as the prior receipt. */
export function nativeCountPlan(origin: string): PlannedSample[] {
  const plan: PlannedSample[] = [];
  for (const fixture of NATIVE_COUNT_FIXTURES) {
    for (let iteration = 1; iteration <= SAMPLES_PER_FIXTURE; iteration++) {
      plan.push({ index: plan.length, fixture: fixture.key, path: fixture.path, iteration, url: `${origin}/${NATIVE_COUNT_QUERY}`, route: LOAD_ROUTE });
    }
  }
  return plan;
}

export const GPU_VECTOR_KEYS = ['gpu.buffers', 'gpu.bufferBytes', 'gpu.staticUpload.count', 'gpu.staticUpload.bytes'] as const;
const TRANSFER_KEY = /^msg\.[^.]+\.out\.transferBytes$/;

export interface SampleObservation {
  trace: LoadTraceSnapshotJson | null;
  countersSettled: boolean;
  gpuHealth: GpuHealth | null;
  pageErrors: readonly string[];
  interactionErrors: Readonly<Record<string, string>>;
  /** Driver-level refusals (admission, adapter, session) carried into the verdict. */
  refusals: readonly string[];
}

export interface SampleVerdict {
  healthy: boolean;
  refusals: string[];
  witnesses: { metadataSpan: string; metadata: boolean; geometry: boolean; rootEnded: boolean; finalize: boolean };
  gpuVector: Record<string, number> | null;
  transferVector: Record<string, number> | null;
  flushCount: number;
  allFlushesCountMode: boolean;
  finalize: Record<string, unknown> | null;
}

/** A sample is healthy only with every witness; anything missing is a named refusal. */
export function assessCountSample(observation: SampleObservation): SampleVerdict {
  const refusals = [...observation.refusals];
  const trace = observation.trace;
  const finished = (name: string) => trace?.spans.find((span) => span.name === name && span.end !== null);
  const loadPath = typeof trace?.attrs?.loadPath === 'string' ? trace.attrs.loadPath : undefined;
  const metadataSpan = metadataCompletionSpan(loadPath);
  const witnesses = {
    metadataSpan, metadata: !!finished(metadataSpan), geometry: !!finished('geometry.streamComplete'),
    rootEnded: trace !== null && trace.end !== null, finalize: !!finished('scene.finalize'),
  };
  if (!trace) refusals.push('no load trace');
  if (!witnesses.metadata) refusals.push(`metadata completion span ${metadataSpan} not finished`);
  if (!witnesses.geometry) refusals.push('geometry.streamComplete not finished');
  if (!witnesses.rootEnded) refusals.push('load root span not ended');
  if (!witnesses.finalize) refusals.push('scene.finalize not finished');
  const failed = trace?.spans.filter((span) => span.name === 'parser.failed' || span.attrs?.error === true).map((span) => span.name) ?? [];
  if (trace?.attrs?.error === true) failed.push('load');
  if (failed.length) refusals.push(`failed spans: ${failed.join(', ')}`);

  const flushes = trace?.spans.filter((span) => span.name === 'scene.flushPending') ?? [];
  const allFlushesCountMode = flushes.length > 0 && flushes.every((span) => span.attrs?.uploadMode === 'count');
  if (!allFlushesCountMode) refusals.push(flushes.length ? 'a scene flush ran outside count upload mode' : 'no scene.flushPending span recorded');
  if (!observation.countersSettled) refusals.push('structural counters did not settle');

  const counters = trace?.counters;
  let gpuVector: Record<string, number> | null = null;
  if (counters && GPU_VECTOR_KEYS.every((key) => Number.isFinite(counters[key]))) {
    gpuVector = Object.fromEntries(GPU_VECTOR_KEYS.map((key) => [key, counters[key]]));
  } else refusals.push(`GPU allocation/static-upload vector incomplete (needs ${GPU_VECTOR_KEYS.join(', ')})`);
  const transferEntries = Object.entries(counters ?? {}).filter(([key, value]) => TRANSFER_KEY.test(key) && Number.isFinite(value)).sort(([a], [b]) => a.localeCompare(b));
  const transferVector = transferEntries.length ? Object.fromEntries(transferEntries) : null;
  if (!transferVector) refusals.push('no sender transfer counters (msg.*.out.transferBytes)');

  const health = observation.gpuHealth;
  if (!health) refusals.push('GPU health not read');
  else {
    if (health.deviceLost > 0) refusals.push(`GPU device lost ${health.deviceLost}x`);
    if (health.deviceReplacements === null) refusals.push('no GPU session counters: device replacement unwitnessed');
    else if (health.deviceReplacements > 0) refusals.push(`GPU device replaced ${health.deviceReplacements}x`);
  }
  if (observation.pageErrors.length) refusals.push(`${observation.pageErrors.length} page error(s)`);
  for (const [name, reason] of Object.entries(observation.interactionErrors)) refusals.push(`interaction ${name} not measured: ${reason}`);

  const finalizeSpan = finished('scene.finalize');
  return {
    healthy: refusals.length === 0, refusals, witnesses, gpuVector, transferVector,
    flushCount: flushes.length, allFlushesCountMode, finalize: finalizeSpan?.attrs ?? null,
  };
}

export interface FixtureSummary {
  fixture: string;
  samples: number;
  healthy: number;
  /** Null until SAMPLES_PER_FIXTURE healthy samples exist; then whether both vectors repeat exactly. */
  repeat: boolean | null;
  gpuVectors: (Record<string, number> | null)[];
  transferVectors: (Record<string, number> | null)[];
}

const canonical = (value: Record<string, number> | null) => JSON.stringify(value === null ? null : Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

/** Repeat is judged over healthy samples only; an unhealthy sample never pools in. */
export function summarizeCountSamples(samples: readonly { fixture: string; verdict: SampleVerdict }[]): FixtureSummary[] {
  return NATIVE_COUNT_FIXTURES.map(({ key }) => {
    const mine = samples.filter((sample) => sample.fixture === key);
    const healthy = mine.filter((sample) => sample.verdict.healthy).map((sample) => sample.verdict);
    const repeat = healthy.length < SAMPLES_PER_FIXTURE ? null
      : healthy.every((v) => canonical(v.gpuVector) === canonical(healthy[0].gpuVector) && canonical(v.transferVector) === canonical(healthy[0].transferVector));
    return {
      fixture: key, samples: mine.length, healthy: healthy.length, repeat,
      gpuVectors: mine.map((s) => s.verdict.gpuVector), transferVectors: mine.map((s) => s.verdict.transferVector),
    };
  });
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Hash a repo fixture and bind it to the manifest digest; a mismatch is a refusal, not a note. */
export function fixtureReceipt(root: string, fixture: { key: string; path: string }, manifest: { files: { path: string; sha256: string }[] }) {
  const sha256 = sha256File(join(root, fixture.path));
  const manifestPath = fixture.path.replace(/^tests\/models\//, '');
  const manifestSha256 = manifest.files.find((file) => file.path === manifestPath)?.sha256 ?? null;
  if (manifestSha256 !== sha256) throw new Error(`fixture ${fixture.key} (${fixture.path}) sha256 ${sha256} does not match manifest ${manifestSha256}`);
  return { key: fixture.key, path: fixture.path, sha256, manifestSha256 };
}
