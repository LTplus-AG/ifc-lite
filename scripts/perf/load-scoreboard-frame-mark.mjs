/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The verdict mark for browser lanes is the frame mark (user decision 2026-11-13, after #10043): the first frame the
 * renderer started at or after the scene finished, never before the settled mark (`frameMarkOf`). It is recorded per
 * row as `frameMs`. The settled mark (`interactiveMs`) stays as a column with its own verdict row. A browser sample
 * without frame times has no frame mark: its cell is unverifiable, never judged on the settled mark instead.
 * Native and boot lanes have no frames; their verdict mark stays `interactiveMs`.
 */

import { frameMarkOf, metadataMarkOf } from './load-scoreboard-report-sections.mjs';

export const FRAME_KEY = 'frameMs';
export const METADATA_FRAME_KEY = 'metadataFrameMs';

const isBrowserLane = (lane) => String(lane ?? '').startsWith('browser');

/** The metric a lane's verdict (and lane summary) uses. */
export function isReopenLane(lane) {
  return /^browser-warm1?(?:-(?:early|settled))?$/.test(String(lane ?? '')) || /^browser-warm(?:-(?:early|settled))?$/.test(String(lane ?? ''));
}

export function primaryKey(lane, reopenVerdictMark = 'frame') {
  return isBrowserLane(lane) ? (reopenVerdictMark === 'metadata' && isReopenLane(lane) ? METADATA_FRAME_KEY : FRAME_KEY) : 'interactiveMs';
}

/** Samples with `frameMs` set on browser rows (null when the row has no frame mark). Other rows are unchanged. */
export function withFrameMarks(samples) {
  return samples.map((row) => (isBrowserLane(row.lane) && row[FRAME_KEY] === undefined ? { ...row, [FRAME_KEY]: frameMarkOf(row)?.frameMs ?? null } : row));
}

/** Add the metadata mark only to reopened browser samples; missing milestones remain unmeasured. */
export function withMetadataMarks(samples) {
  return samples.map((row) => {
    if (!isReopenLane(row.lane) || !row.ok) return row;
    const mark = metadataMarkOf(row);
    return mark ? { ...row, [METADATA_FRAME_KEY]: mark.metadataFrameMs, holdMs: mark.holdMs } : row;
  });
}

/** The frame-mark verdict, inconclusive (unverifiable) when any successful sample of the cell lacks frame times. */
export function frameMarkVerdict(v, rows) {
  const missing = rows.filter((r) => r.ok && !Number.isFinite(r[FRAME_KEY])).length;
  // Only "more failed loads" stays a regression: a timing verdict (gain or regression) from the samples that do have
  // frame marks is an incomplete cohort. Another inconclusive reason (host load, no A/A floor) stands; the missing
  // frame times replace only "too few successful samples", which they themselves caused.
  if (missing === 0 || v.verdict === 'regression: more failed loads' || (v.verdict.startsWith('inconclusive') && v.verdict !== 'inconclusive: too few successful samples')) return v;
  return { ...v, verdict: `inconclusive: unverifiable (${missing} sample(s) without frame times, no frame mark)`, pass: false, regression: false };
}

/** A reopen cell is unverifiable when any successful sample lacks the new trace milestone or its frame. */
export function metadataMarkVerdict(v, rows) {
  const missing = rows.filter((r) => r.ok && !Number.isFinite(r[METADATA_FRAME_KEY])).length;
  if (missing === 0 || v.verdict === 'regression: more failed loads' || (v.verdict.startsWith('inconclusive') && v.verdict !== 'inconclusive: too few successful samples')) return v;
  return { ...v, verdict: `inconclusive: unverifiable (${missing} sample(s) without the metadata mark)`, pass: false, regression: false };
}
