/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ring-chart geometry and colours for manual validation (#6401), DOM-free
 * so the panel's SVG and the document block's print path draw the same
 * ring from the same numbers.
 *
 * Segment order is fixed — pass, warning, fail, not checked — so a colour
 * always means the same state and the ring reads clockwise from "good" to
 * "still to do". A warning is its own segment, never folded into pass.
 */

import type { ManualCounts } from './checklist-summary.js';

export type RingBucket = 'pass' | 'warning' | 'fail' | 'unanswered';
export const RING_BUCKETS: readonly RingBucket[] = ['pass', 'warning', 'fail', 'unanswered'];

/** Status colours, shared by the panel and the print path. Every use pairs
 *  the colour with an icon or a text label, never colour alone. Pass /
 *  warning / fail were run through the dataviz palette validator (light
 *  surface): lightness band and normal-vision separation pass; the
 *  protan green/amber pair sits in the 6-8 band, which is why segments are
 *  separated by a surface gap and every ring has a labelled legend. "Not
 *  checked" is a deliberately neutral grey track, not a status hue. */
export const RING_COLORS: Readonly<Record<RingBucket, string>> = {
  pass: '#16a34a',
  warning: '#e0a100',
  fail: '#dc2626',
  unanswered: '#94a3b8',
};

export interface RingSegment {
  bucket: RingBucket;
  count: number;
  /** Visible arc length along the circumference. */
  length: number;
  /** Where the arc starts, measured clockwise from 12 o'clock. */
  offset: number;
}

/**
 * Arcs for a ring of `radius`, with a `gap` of surface between adjacent
 * non-empty segments. An empty checklist (total 0) yields no segments; the
 * caller draws the bare track. A single non-empty bucket is a full circle
 * with no gap.
 */
export function ringSegments(counts: ManualCounts, radius: number, gap = 2): RingSegment[] {
  if (counts.total <= 0) return [];
  const circumference = 2 * Math.PI * radius;
  const present = RING_BUCKETS.filter((b) => counts[b] > 0);
  const useGap = present.length > 1 ? gap : 0;
  const out: RingSegment[] = [];
  let start = 0;
  for (const bucket of present) {
    const span = (counts[bucket] / counts.total) * circumference;
    out.push({ bucket, count: counts[bucket], length: Math.max(span - useGap, 0.5), offset: start });
    start += span;
  }
  return out;
}

/** Share of checks that passed, 0-100, floor-rounded; 0 for an empty checklist. */
export function passPercent(counts: ManualCounts): number {
  return counts.total > 0 ? Math.floor((counts.pass / counts.total) * 100) : 0;
}
