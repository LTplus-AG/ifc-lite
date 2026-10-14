/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DETERMINISTIC_FRAME_METRICS, FRAME_BUDGET_MS } from './frame-stats.js';
import { metadataCompletionSpan } from '../metadata-render-readiness.js';

export const FRAME_FIXTURES = [
  { name: 'AC20-FZK-Haus', path: 'tests/models/ara3d/AC20-FZK-Haus.ifc' },
  { name: 'Snowdon', path: 'tests/models/various/01_Snowdon_Towers_Sample_Structural(1).ifc' },
] as const;
export const FRAME_SCENARIOS = ['streaming-load', 'orbit', 'hover'] as const;
/** Attempts per fixture: a GPU-contaminated one is replaced by a fresh browser at most twice. */
export const MAX_ATTEMPTS = 3;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid frame evidence object');
  return value as Record<string, unknown>;
}

/** Admission only: valid rows remain informational until repeatability is proved.
 * A six-group artifact can still contain a partial run, duplicate metrics, NaN
 * serialised as null, or a recovered device that re-uploaded the entire scene.
 */
export function requireFrameEvidence(input: unknown): void {
  const result = object(input);
  if (result.family !== 'browser-frames' || result.rig !== 'deterministic-begin-frame'
    || result.schema !== 2 || result.frameBudgetMs !== FRAME_BUDGET_MS
    || typeof result.browser !== 'string' || !result.browser.startsWith('chrome-headless-shell ')) {
    throw new Error('unsupported deterministic frame evidence');
  }
  if (!Array.isArray(result.samples) || result.samples.length !== FRAME_FIXTURES.length) {
    throw new Error('missing fixture health evidence');
  }
  // Every replaced attempt is retained, and only GPU contamination justifies a
  // replacement: a retry can neither hide a real failure nor drop its receipt.
  if (!Array.isArray(result.refusedAttempts)) throw new Error('missing refused-attempt evidence');
  const refused = new Map<string, number[]>();
  for (const value of result.refusedAttempts) {
    const attempt = object(value), health = object(attempt.gpuHealth);
    if (typeof attempt.fixture !== 'string' || health.contaminated !== true) {
      throw new Error('a refused attempt must be retained GPU-contaminated evidence');
    }
    refused.set(attempt.fixture, [...refused.get(attempt.fixture) ?? [], Number(attempt.attempt)]);
  }
  const fixtures = new Set<string>(FRAME_FIXTURES.map(fixture => fixture.name));
  for (const value of result.samples) {
    const sample = object(value), health = object(sample.gpuHealth);
    if (typeof sample.fixture !== 'string' || !fixtures.delete(sample.fixture)) throw new Error('duplicate or unexpected fixture health');
    const attempt = sample.attempt, prior = refused.get(sample.fixture) ?? [];
    if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > MAX_ATTEMPTS
      || prior.length !== attempt - 1 || prior.some((n, i) => n !== i + 1)) {
      throw new Error(`attempt receipts do not account for ${sample.fixture} attempt ${String(attempt)}`);
    }
    refused.delete(sample.fixture);
    if (sample.completed !== true || sample.error !== null || sample.readinessError !== null || !Array.isArray(sample.pageErrors) || sample.pageErrors.length !== 0) {
      throw new Error('incomplete or page-error-contaminated frame sample');
    }
    const readiness = object(sample.readiness);
    const metadata = metadataCompletionSpan(typeof readiness.loadPath === 'string' ? readiness.loadPath : undefined);
    const done = readiness.done;
    if (readiness.ended !== true || readiness.invalid !== undefined || !Array.isArray(readiness.failed) || readiness.failed.length
      || !Array.isArray(done) || ![metadata, 'geometry.streamComplete', 'scene.finalize'].every(name => done.includes(name))) {
      throw new Error('missing or failed canonical metadata/render readiness');
    }
    if (health.source !== 'counters+console' || health.contaminated !== false
      || health.deviceLost !== 0 || health.deviceReplacements !== 0
      || typeof health.devicesCreated !== 'number' || !Number.isSafeInteger(health.devicesCreated) || health.devicesCreated < 1) {
      throw new Error('missing health witnesses or GPU-contaminated frame sample');
    }
  }
  if (refused.size) throw new Error(`refused attempts for no admitted sample: ${[...refused.keys()].join(', ')}`);
  const expected = new Set(FRAME_FIXTURES.flatMap(fixture => FRAME_SCENARIOS.flatMap(scenario =>
    DETERMINISTIC_FRAME_METRICS.map(metric => `${fixture.name}/${scenario}/${metric}`))));
  const values = new Map<string, number>();
  if (!Array.isArray(result.rows)) throw new Error('missing frame rows');
  for (const value of result.rows) {
    const row = object(value), key = `${String(row.fixture)}/${String(row.scenario)}/${String(row.metric)}`;
    if (!expected.delete(key)) throw new Error(`unexpected or duplicate frame metric: ${key}`);
    if (typeof row.value !== 'number' || !Number.isFinite(row.value) || row.value < 0) {
      throw new Error(`invalid frame metric value: ${key}`);
    }
    values.set(key, row.value);
  }
  if (expected.size) throw new Error(`missing frame metrics: ${[...expected].join(', ')}`);
  for (const fixture of FRAME_FIXTURES) for (const scenario of FRAME_SCENARIOS) {
    const value = (metric: string) => values.get(`${fixture.name}/${scenario}/${metric}`)!;
    if (value('frames') < 1 || value('rendered_frames') + value('idle_frames') !== value('frames')
      || value('frames_without_raf') > value('frames')
      || (scenario !== 'hover' && value('rendered_frames') < 1)) {
      throw new Error(`empty or inconsistent frame scenario: ${fixture.name}/${scenario}`);
    }
  }
}
