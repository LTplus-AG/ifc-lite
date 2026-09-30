/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ring-chart geometry and colours for validation reports (#6401, #6552), DOM-free
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

/**
 * The ring as a standalone SVG string, for the print path (svg2pdf): the
 * same track, segments and order the panel's `ManualValidationRing` draws.
 * No text inside — the page prints the counts beside it as words.
 */
export function ringSvg(counts: ManualCounts, size: number): string {
  const stroke = Math.max(2, Math.round(size / 8));
  const radius = (size - stroke) / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * radius;
  const circle = (color: string, extra: string): string =>
    `<circle cx="${c}" cy="${c}" r="${radius}" fill="none" stroke="${color}" stroke-width="${stroke}"${extra}/>`;
  const point = (offset: number): string => {
    const angle = offset / radius - Math.PI / 2;
    return `${c + radius * Math.cos(angle)} ${c + radius * Math.sin(angle)}`;
  };
  const segments = ringSegments(counts, radius, Math.max(1, size / 40)).map((seg) => {
    if (seg.length >= circumference) return circle(RING_COLORS[seg.bucket], '');
    // Explicit clockwise arcs retain SVG/PDF order without relying on a
    // PDF reader's dash phase or svg2pdf's circle-path orientation.
    const arc = `M ${point(seg.offset)} A ${radius} ${radius} 0 ${seg.length > Math.PI * radius ? 1 : 0} 1 ${point(seg.offset + seg.length)}`;
    return `<path d="${arc}" fill="none" stroke="${RING_COLORS[seg.bucket]}" stroke-width="${stroke}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + circle(RING_COLORS.unanswered, ' stroke-opacity="0.25"')
    + segments.join('') + '</svg>';
}
