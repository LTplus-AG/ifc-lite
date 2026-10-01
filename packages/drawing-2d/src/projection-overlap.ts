/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { DrawingLine, Line2D } from './types.js';
import { EPSILON, point2DLerp } from './math.js';
import { mergeCollinearLines } from './line-merger.js';

/** #6615: splitting a spanning mesh into two depth bands must not draw its
 * footprint twice. Subtract only SAME-ENTITY retained edges from overhead;
 * different overhead contours and other federation entities remain intact. */
export function removeCoveredOverhead(lines: DrawingLine[]): DrawingLine[] {
  const retained = new Map<string, Line2D[]>();
  const key = (line: DrawingLine) => `${line.modelIndex}:${line.entityId}`;
  for (const line of lines) {
    if (line.visibility !== 'visible') continue;
    const group = retained.get(key(line)) ?? [];
    group.push(line.line); retained.set(key(line), group);
  }
  for (const [entity, group] of retained) {
    // Reuse the shared merger, with zero gap: no invented coverage across gaps.
    retained.set(entity, mergeCollinearLines(group, { gapTolerance: 0 }));
  }
  return lines.flatMap(line => {
    const coverage = retained.get(key(line));
    if (line.visibility !== 'hidden' || !coverage) return [line];
    const { start, end } = line.line;
    const dx = end.x - start.x, dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length <= EPSILON) return [line];
    const tolerance = EPSILON / length;
    const intervals: Array<[number,number]> = [];
    for (const other of coverage) {
      const distance = (p: Line2D['start']) => Math.abs(dx*(p.y-start.y)-dy*(p.x-start.x))/length;
      if (distance(other.start)>EPSILON || distance(other.end)>EPSILON) continue;
      const parameter = (p: Line2D['start']) => ((p.x-start.x)*dx+(p.y-start.y)*dy)/(length*length);
      const a = parameter(other.start), b = parameter(other.end);
      const lo = Math.max(0,Math.min(a,b)), hi = Math.min(1,Math.max(a,b));
      if (hi-lo>tolerance) intervals.push([lo,hi]);
    }
    if (!intervals.length) return [line];
    intervals.sort((a,b)=>a[0]-b[0]);
    const uncovered: Array<[number,number]> = [];
    let cursor = 0;
    for (const [lo,hi] of intervals) {
      if (lo-cursor>tolerance) uncovered.push([cursor,lo]);
      cursor = Math.max(cursor,hi);
    }
    if (1-cursor>tolerance) uncovered.push([cursor,1]);
    const depthAt = (t:number) => line.depth+((line.depthEnd??line.depth)-line.depth)*t;
    return uncovered.map(([lo,hi]) => ({ ...line,
      line:{start:point2DLerp(start,end,lo),end:point2DLerp(start,end,hi)},
      depth:depthAt(lo),depthEnd:depthAt(hi),
    }));
  });
}
