/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The footprint and its quality, in one place. Sources are tried in order:
 * the caller's rings, the ground storey's floor slab outlines, its external
 * walls' axes chained into a ring, the hull of those axes, and (after
 * candidate selection) the hull of the candidates. Every source tried that
 * could not be read, or only in part, and every condition met (voids filled,
 * a courtyard ring, a partial outline, a hull) is recorded in one
 * {@link QualityLog} that only ever grows: a fallback may supply the geometry
 * but cannot upgrade the quality or drop what could not be read. The final
 * record is frozen into the footprint (`FootprintFact.quality`).
 */

import { chainIntoRing, convexHull, nestedRings, ringArea } from '../geom.js';
import type { MapPoint } from '../types.js';
import { isExternal } from './candidate-base.js';
import { FOOTPRINT_QUALITY_ORDER, type FootprintFact, type FootprintQuality, type FootprintQualityRecord, type ModelFacts } from './facts.js';
import type { ModelGeoreference } from './georef.js';
import { completeness, readSlabOutline, readWallAxis, toWorld } from './outline.js';
import type { PlacementResolver } from './placement.js';
import { asEnum, type ModelReader } from './reader.js';

/** Wall axes meeting at a butt joint stop about half a wall thickness short of each other. */
const WALL_JOIN_TOLERANCE = 0.5;

/** The accumulated quality: append-only. */
class QualityLog {
  private readonly conditions: Array<Exclude<FootprintQuality, 'complete'>> = [];
  private readonly unreadable: Array<{ expressId: number; ifcClass: string; reason: string }> = [];

  mark(condition: Exclude<FootprintQuality, 'complete'>): void {
    if (!this.conditions.includes(condition)) this.conditions.push(condition);
  }

  /** A source tried that could not be read: the outline may miss its area. */
  unread(expressId: number, ifcClass: string, reason: string): void {
    this.unreadable.push({ expressId, ifcClass, reason });
    this.mark('partial');
  }

  get unreadableSources(): ReadonlyArray<{ expressId: number; ifcClass: string; reason: string }> {
    return this.unreadable;
  }

  record(): FootprintQualityRecord {
    const worst = FOOTPRINT_QUALITY_ORDER.reduce<FootprintQuality>((w, q) => (q !== 'complete' && this.conditions.includes(q) ? q : w), 'complete');
    return Object.freeze({ worst, conditions: Object.freeze([...this.conditions]), unreadable: Object.freeze(this.unreadable.map((u) => Object.freeze({ ...u }))) });
  }
}

export interface FootprintInput {
  reader: ModelReader;
  placements: PlacementResolver;
  georef: ModelGeoreference;
  storeyOf(id: number): number | null;
  ground: ModelFacts['groundStorey'];
  /** The caller's rings (`ExtractOptions.footprint`), which replace the model's sources. */
  given?: MapPoint[][];
  skipped: ModelFacts['skipped'];
  warnings: string[];
}

export interface FootprintResolution {
  /** The footprint from the model or the caller; null when no source gave one (see {@link FootprintResolution.finish}). */
  fact: FootprintFact | null;
  /** The footprint once candidates are known: the hull of the candidates when no source gave one, with the same accumulated quality. */
  finish(candidatePositions: readonly MapPoint[]): FootprintFact;
}

function seal(rings: MapPoint[][], source: FootprintFact['source'], fromElements: number[], log: QualityLog): FootprintFact {
  if (nestedRings(rings).size > 0) log.mark('courtyard-ring');
  const quality = log.record();
  const fact: FootprintFact = { rings, source, fromElements, quality };
  if (quality.conditions.includes('partial')) fact.partial = true;
  return fact;
}

/** Resolve the footprint and its accumulated quality. Throws `RangeError` for an empty or degenerate given footprint. */
export function resolveFootprint(input: FootprintInput): FootprintResolution {
  const log = new QualityLog();
  if (input.given) {
    // An empty or degenerate given footprint would be trusted as an outline with no inside: refused, not read as ground.
    if (input.given.length === 0 || input.given.some((ring) => ring.length < 3 || ringArea(ring) < 1 || ring.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))) {
      throw new RangeError('footprint must have at least one ring, each of at least 3 finite points enclosing at least 1 m²');
    }
    const fact = seal(input.given, 'given', [], log);
    return { fact, finish: () => fact };
  }
  const derived = fromModel(input, log);
  const report = () => {
    const unread = log.unreadableSources;
    if (unread.length === 0) return;
    for (const u of unread) input.skipped.push(u);
    input.warnings.push(
      `the footprint covers only part of the ground storey: ${unread.length} source(s) there cannot be read (${unread.map((u) => `${u.ifcClass} #${u.expressId}`).join(', ')}); ` +
        'no element gets a reassuring outcome — pass a footprint (for example the cadastral outline)',
    );
  };
  if (derived) {
    report();
    return { fact: derived, finish: () => derived };
  }
  return {
    fact: null,
    finish(candidatePositions) {
      report();
      log.mark('hull');
      const hull = convexHull(candidatePositions);
      input.warnings.push(
        'no slab outline or external wall could be read in the ground storey; the footprint is the hull of the candidates and ' +
          'ground samples near interior elements may fall inside the real building',
      );
      return seal(hull.length >= 3 ? [hull] : [], 'candidate-hull', [], log);
    },
  };
}

function fromModel(input: FootprintInput, log: QualityLog): FootprintFact | null {
  const { reader, placements, georef, storeyOf, ground } = input;
  const inGround = (id: number) => ground.expressId === null || storeyOf(id) === ground.expressId;
  const toRing = (pts: [number, number, number][]): MapPoint[] => pts.map((p) => {
    const [x, y] = georef.toMap(p);
    return { x, y };
  });

  // 1. The ground storey's floor slab outlines. Ids are keyed by the raw STEP name: the standard and elemented cases are separate keys.
  const rings: MapPoint[][] = [];
  const from: number[] = [];
  for (const id of [...reader.idsOfType('IFCSLAB'), ...reader.idsOfType('IFCSLABSTANDARDCASE'), ...reader.idsOfType('IFCSLABELEMENTEDCASE')]) {
    if (!inGround(id)) continue;
    const kind = asEnum(reader.attr(reader.entity(id), 'PredefinedType'));
    if (kind && !['FLOOR', 'BASESLAB', 'NOTDEFINED', 'USERDEFINED'].includes(kind)) continue;
    const frame = placements.ofProduct(id);
    const outline = frame ? readSlabOutline(reader, id) : null;
    const state = outline ? completeness(outline) : 'unreadable';
    const cls = reader.className(reader.entity(id)!);
    if (!frame || !outline || state === 'none' || state === 'unreadable') {
      log.unread(id, cls, 'ground-storey floor slab whose outline cannot be read');
      continue;
    }
    // Every ring the slab gives (one per extrusion or curve); a part not read leaves the outline partial.
    if (state === 'partial') log.unread(id, cls, `ground-storey floor slab whose outline can be read only in part (${outline.readable} of ${outline.items} items)`);
    for (const r of outline.rings) {
      const ring = toRing(toWorld(frame, r));
      if (ringArea(ring) >= 1) rings.push(ring);
    }
    from.push(id);
    if (outline.voids) log.mark('voids-filled');
  }
  if (rings.length > 0) return seal(rings, log.record().conditions.includes('voids-filled') ? 'slab-outline-voids-filled' : 'slab-outline', from, log);

  // 2. The external walls' axes: chained into one closed ring (keeps courtyards and notches), else their hull.
  const points: MapPoint[] = [];
  const axes: MapPoint[][] = [];
  const walls: number[] = [];
  let everyAxisRead = true;
  for (const type of ['IFCWALL', 'IFCWALLSTANDARDCASE']) {
    for (const id of reader.idsOfType(type)) {
      const wall = reader.entity(id);
      if (!wall || isExternal(reader, wall) !== true || !inGround(id)) continue;
      const frame = placements.ofProduct(id);
      if (!frame) {
        log.unread(id, reader.className(wall), 'external wall in the ground storey whose placement cannot be read');
        continue;
      }
      const axis = readWallAxis(reader, id);
      const state = completeness(axis);
      if (state !== 'complete') {
        everyAxisRead = false;
        log.unread(id, reader.className(wall), state === 'partial'
          ? `external wall in the ground storey whose axis can be read only in part (${axis.readable} of ${axis.items} curves)`
          : 'external wall in the ground storey whose axis cannot be read');
      }
      for (const l of axis.lines) {
        const line = toRing(toWorld(frame, l));
        points.push(...line);
        axes.push(line);
      }
      // With no axis read, the wall's placement origin is the one point of it known: it still widens the hull.
      if (axis.lines.length === 0) points.push(...toRing(toWorld(frame, [[0, 0, 0]])));
      walls.push(id);
    }
  }
  const chained = everyAxisRead ? chainIntoRing(axes, WALL_JOIN_TOLERANCE) : null;
  if (chained && ringArea(chained) >= 1) return seal([chained], 'external-wall-outline', walls, log);
  const hull = convexHull(points);
  if (hull.length >= 3 && ringArea(hull) >= 1) {
    log.mark('hull');
    return seal([hull], 'external-wall-hull', walls, log);
  }
  return null;
}
