/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Alert threshold and regression-issue decision for the real-GPU nightly
 * trend (#6975). Pure. No threshold ships with the repository: a thresholds
 * file is admitted only when it names seven consecutive admitted nights of
 * the trend (frame-gpu-night-history.ts) under one profile, and no maximum
 * sits below a value those nights actually measured. Until such a file
 * exists every verdict is `uncalibrated` and nothing alerts.
 */

import { nightHistoryWindow } from './frame-gpu-night-history.js';
import type { NightTrendRow } from './frame-gpu-night-trend.js';

export interface NightThresholds {
  version: 1;
  profileSha256: string;
  /** Raw receipts of the seven calibration nights, oldest first. */
  calibrationReceipts: string[];
  /** `<fixture>/<scenario>/<metric>` → highest acceptable nightly median. */
  maxima: Record<string, number>;
}

export interface Breach { metric: string; value: number | null; max: number }

export type NightVerdict =
  | { state: 'uncalibrated'; night: string; calendar: { nights: number; ready: boolean; reason: string } }
  | { state: 'missing'; night: string }
  | { state: 'refused' | 'failed'; night: string; receiptSha256: string; reasons: string[] }
  | { state: 'profile-changed'; night: string; receiptSha256: string }
  | { state: 'ok'; night: string; receiptSha256: string }
  | { state: 'regression'; night: string; receiptSha256: string; breaches: Breach[] };

const HASH = /^[a-f0-9]{64}$/;

/** Admit a reviewed thresholds file against the trend it claims to be calibrated on. */
export function admitThresholds(trend: readonly NightTrendRow[], input: unknown): NightThresholds {
  if (!input || typeof input !== 'object' || Reflect.get(input, 'version') !== 1) throw new Error('invalid thresholds version');
  const thresholds = input as NightThresholds;
  if (typeof thresholds.profileSha256 !== 'string' || !HASH.test(thresholds.profileSha256)) throw new Error('invalid threshold profile');
  const receipts = thresholds.calibrationReceipts;
  if (!Array.isArray(receipts) || receipts.length !== 7 || !receipts.every((receipt) => typeof receipt === 'string' && HASH.test(receipt))) {
    throw new Error('thresholds must name exactly seven calibration receipts');
  }
  const maxima = Object.entries(thresholds.maxima ?? {});
  if (maxima.length === 0) throw new Error('thresholds set no maximum');
  const last = trend.find((row) => row.receiptSha256 === receipts[6]);
  if (!last) throw new Error('calibration receipt is not in the trend');
  const window = nightHistoryWindow(trend, last.night);
  if (!window.calendarReady) throw new Error(`calibration nights are not seven consecutive admitted nights: ${window.reason}`);
  if (window.consecutive.some((row, index) => row.receiptSha256 !== receipts[index])) {
    throw new Error('calibration receipts are not the seven consecutive nights ending at the last one');
  }
  if (window.consecutive[0].profileSha256 !== thresholds.profileSha256) throw new Error('thresholds name a different profile than their calibration nights');
  const nights = window.consecutive as NightTrendRow[];
  for (const [metric, max] of maxima) {
    if (!Number.isFinite(max) || max <= 0) throw new Error(`invalid maximum for ${metric}`);
    for (const night of nights) {
      const value = night.metrics[metric];
      if (value === undefined) throw new Error(`calibration night ${night.night} did not measure ${metric}`);
      if (value > max) throw new Error(`${metric} maximum ${max} is below calibration night ${night.night} (${value})`);
    }
  }
  return thresholds;
}

/** Verdict for one scheduled night. Only an admitted night under the calibrated profile can alert. */
export function evaluateNight(trend: readonly NightTrendRow[], night: string, thresholds: NightThresholds | null): NightVerdict {
  if (!thresholds) {
    const calendar = nightHistoryWindow(trend, night);
    return { state: 'uncalibrated', night, calendar: { nights: calendar.consecutive.length, ready: calendar.calendarReady, reason: calendar.reason } };
  }
  // The first attempt of a night is the scheduled one; a retry never replaces it.
  const row = trend.find((candidate) => candidate.night === night);
  if (!row) return { state: 'missing', night };
  const receiptSha256 = row.receiptSha256;
  if (row.status !== 'ok') return { state: row.status, night, receiptSha256, reasons: row.reasons };
  if (row.profileSha256 !== thresholds.profileSha256) return { state: 'profile-changed', night, receiptSha256 };
  const breaches: Breach[] = [];
  for (const [metric, max] of Object.entries(thresholds.maxima)) {
    const value = row.metrics[metric];
    if (value === undefined || value > max) breaches.push({ metric, value: value ?? null, max });
  }
  return breaches.length ? { state: 'regression', night, receiptSha256, breaches } : { state: 'ok', night, receiptSha256 };
}

export const REGRESSION_ISSUE_TITLE = 'perf: real-GPU nightly frame regression (#6975)';

export type IssueAction =
  | { action: 'create'; title: string; body: string }
  | { action: 'comment'; issue: number; body: string };

/** Open one regression issue, then comment on it for every later regressing night. */
export function regressionIssueAction(verdict: NightVerdict, openIssue: number | null): IssueAction | null {
  if (verdict.state !== 'regression') return null;
  const body = [
    `Real-GPU night ${verdict.night} exceeded its calibrated maximum (receipt \`${verdict.receiptSha256}\`).`,
    '',
    '| metric | nightly median | maximum |',
    '|---|---:|---:|',
    ...verdict.breaches.map((breach) => `| \`${breach.metric}\` | ${breach.value ?? 'not measured'} | ${breach.max} |`),
    '',
    'Raised by `scripts/perf/frame-gpu-night-trend.mts evaluate --report-issue`. Part of #6975.',
  ].join('\n');
  return openIssue === null ? { action: 'create', title: REGRESSION_ISSUE_TITLE, body } : { action: 'comment', issue: openIssue, body };
}
