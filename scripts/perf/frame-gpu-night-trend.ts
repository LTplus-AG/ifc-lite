/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Real-GPU nightly trend file (#6975). One JSONL row per scheduled night,
 * derived from the frame rig's raw run directory. Pure: the CLI
 * (frame-gpu-night-trend.mts) supplies the bytes and file times.
 *
 * A night is `ok` only when every sample completed AND carries the strict
 * admission witnesses the rig records under --require-host-idle,
 * --require-physical-display and --require-gpu-timing. A run made without
 * those flags is retained as `failed`, never silently admitted. Refused and
 * failed nights keep their row so they interrupt the seven-night calendar
 * (frame-gpu-night-history.ts) instead of disappearing.
 */

import { decodeNightHistory, type NightAttempt } from './frame-gpu-night-history.js';
import { decodeNightProfile, sha256 } from './frame-gpu-night-profile.js';
import { isPhysicalConsole, type PhysicalSessionReceipt } from './frame-gpu-session.js';
import { summarizeSamples, type SampleRecord } from './frame-gpu-summary.js';

export interface NightTrendRow extends NightAttempt {
  /** When the row was written; at most {@link MAX_APPEND_DELAY_MS} after the run finished. */
  appendedAt: string;
  sourceHead: string;
  fixture: string;
  samples: { ok: number; total: number };
  /** Why the night is not `ok`; empty for an admitted night. */
  reasons: string[];
  /** `<fixture>/<scenario>/<metric>` → median over the night's samples. Empty unless `ok`. */
  metrics: Record<string, number>;
}

export interface NightRunInput {
  /** Exact bytes of the rig's runs.jsonl: the raw receipt this row hashes. */
  runsJsonl: Uint8Array;
  /** The rig's source-revisions.json, as written before any browser work. */
  sourceRevisions: unknown;
  /** Exact bytes of the immutable night profile (frame-gpu-night-profile.ts). */
  profile: Uint8Array;
  startedAt: string;
  finishedAt: string;
  appendedAt: string;
}

/** A row written a day after its run is a backfill, not a nightly result. */
export const MAX_APPEND_DELAY_MS = 24 * 3_600_000;
const SOFTWARE_ADAPTER = /swiftshader|software|llvmpipe/i;
const REQUIRED_GPU_ROWS = ['orbit', 'hover'].map((scenario) => `${scenario}/gpu_pass_total_ms_p50`);

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {};

/** Strict-admission witnesses of one completed sample; empty when admitted. */
export function sampleAdmissionGaps(sample: SampleRecord): string[] {
  const meta = record(sample.meta);
  const gaps: string[] = [];
  for (const phase of ['hostBefore', 'hostAfter']) {
    if (record(meta[phase]).quiet !== true) gaps.push(`${phase}: no quiet host admission (--require-host-idle)`);
  }
  const before = meta.sessionBefore as PhysicalSessionReceipt | undefined;
  const after = meta.sessionAfter as PhysicalSessionReceipt | undefined;
  if (!before || !after || !isPhysicalConsole(before) || !isPhysicalConsole(after)
    || before.currentSession !== after.currentSession) gaps.push('no continuous physical-console session (--require-physical-display)');
  const foreground = record(meta.foreground);
  if (foreground.interruptions !== 0 || foreground.visibility !== 'visible' || foreground.focused !== true) {
    gaps.push('foreground was not held for the whole measurement');
  }
  const vendor = record(meta.adapter).vendor;
  if (typeof vendor !== 'string' || !vendor || SOFTWARE_ADAPTER.test(JSON.stringify(meta.adapter))) {
    gaps.push('no hardware adapter identity');
  }
  const timing = record(meta.gpuTiming);
  for (const scenario of ['orbit', 'hover']) {
    const snapshot = record(timing[scenario]);
    if (snapshot.mode !== 'gpu-queries' || snapshot.errors !== 0) gaps.push(`${scenario}: no valid per-pass GPU timing (--require-gpu-timing)`);
  }
  const present = new Set(sample.rows.map((row) => `${row.scenario}/${row.metric}`));
  for (const key of REQUIRED_GPU_ROWS) if (!present.has(key)) gaps.push(`missing ${key}`);
  return gaps;
}

function decodeSamples(bytes: Uint8Array): SampleRecord[] {
  const lines = Buffer.from(bytes).toString('utf8').split('\n').filter((line) => line.trim());
  if (lines.length === 0) throw new Error('runs.jsonl holds no samples');
  return lines.map((line, index) => {
    const sample = JSON.parse(line) as SampleRecord;
    if (!sample || typeof sample.ok !== 'boolean' || !Array.isArray(sample.rows)) throw new Error(`invalid sample on line ${index + 1}`);
    return sample;
  });
}

/** Derive one night's trend row. Throws on input that cannot be a nightly run at all. */
export function nightTrendRow(input: NightRunInput): NightTrendRow {
  const profile = decodeNightProfile(JSON.parse(Buffer.from(input.profile).toString('utf8')) as unknown);
  const revisions = record(input.sourceRevisions);
  if (revisions.base !== null) throw new Error('a nightly trend run measures one build; drop --dist-base');
  if (revisions.branch !== profile.sourceHead) throw new Error('run source revision does not match the night profile');
  const started = Date.parse(input.startedAt), finished = Date.parse(input.finishedAt), appended = Date.parse(input.appendedAt);
  if (![started, finished, appended].every(Number.isFinite) || finished < started || appended < finished) {
    throw new Error('invalid run interval');
  }
  if (appended - finished > MAX_APPEND_DELAY_MS) throw new Error('run finished more than 24 h before this append; backfill is refused');

  const samples = decodeSamples(input.runsJsonl);
  const reasons: string[] = [];
  let refused = false;
  for (const sample of samples) {
    if (sample.side !== 'branch') throw new Error('a nightly trend run measures one build; drop --dist-base');
    if (!sample.ok) {
      const error = sample.error ?? 'sample failed';
      if (/admission|refused/i.test(error)) refused = true;
      reasons.push(`pair ${sample.pair}: ${error}`);
      continue;
    }
    for (const gap of sampleAdmissionGaps(sample)) reasons.push(`pair ${sample.pair}: ${gap}`);
  }
  const fixtures = new Set(samples.flatMap((sample) => sample.rows.map((row) => row.fixture)));
  const status: NightAttempt['status'] = reasons.length === 0 ? 'ok' : refused ? 'refused' : 'failed';
  const metrics: Record<string, number> = {};
  if (status === 'ok') {
    for (const row of summarizeSamples(samples)) {
      if (row.branch) metrics[`${row.fixture}/${row.scenario}/${row.metric}`] = row.branch.median;
    }
  }
  const [row] = decodeNightHistory([{
    night: new Date(started).toISOString().slice(0, 10),
    startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(),
    profileSha256: sha256(input.profile), status, receiptSha256: sha256(input.runsJsonl),
  }]);
  return {
    ...row, appendedAt: new Date(appended).toISOString(), sourceHead: profile.sourceHead,
    fixture: fixtures.size === 1 ? [...fixtures][0] : [...fixtures].sort().join('+'),
    samples: { ok: samples.filter((sample) => sample.ok).length, total: samples.length }, reasons, metrics,
  };
}

/** Decode the append-only trend file; refuses rows the calendar decoder refuses. */
export function decodeNightTrend(text: string): NightTrendRow[] {
  const rows = text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as NightTrendRow);
  decodeNightHistory(rows);
  for (const row of rows) {
    if (!row.metrics || typeof row.metrics !== 'object' || !Array.isArray(row.reasons)) throw new Error('invalid trend row');
    if (row.status === 'ok' && row.reasons.length !== 0) throw new Error('an ok night cannot carry refusal reasons');
    if (row.status !== 'ok' && Object.keys(row.metrics).length !== 0) throw new Error('only an ok night carries metrics');
  }
  return rows;
}

/**
 * Append in chronological order only. A receipt already in the file, or a run
 * that started before the last recorded one, is a backfill or a replay.
 */
export function appendNightTrend(text: string, row: NightTrendRow): string {
  const rows = decodeNightTrend(text);
  decodeNightTrend(JSON.stringify(row));
  if (rows.some((existing) => existing.receiptSha256 === row.receiptSha256)) throw new Error('raw receipt is already in the trend');
  const last = rows.at(-1);
  if (last && Date.parse(row.startedAt) <= Date.parse(last.startedAt)) throw new Error('trend rows are append-only in run order; backfill is refused');
  return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${JSON.stringify(row)}\n`;
}
