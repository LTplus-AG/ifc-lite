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

import { chainIntoRing, convexHull, nestedRings, ringArea, signedDistance } from '../geom.js';
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
  private readonly notes: string[] = [];

  /** A condition found by checking the footprint against the building, with what was found. */
  note(condition: Exclude<FootprintQuality, 'complete'>, text: string): void {
    this.mark(condition);
    this.notes.push(text);
  }

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
    return Object.freeze({
      worst,
      conditions: Object.freeze([...this.conditions]),
      unreadable: Object.freeze(this.unreadable.map((u) => Object.freeze({ ...u }))),
      notes: Object.freeze([...this.notes]),
    });
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

/** A façade element found more than the boundary tolerance outside the footprint. */
export interface OutsideElement {
  expressId: number;
  ifcClass: string;
  distance: number;
}

export interface FootprintResolution {
  /** The footprint from the model or the caller, for candidate selection; null when no source gave one (see {@link FootprintResolution.finish}). */
  fact: FootprintFact | null;
  /**
   * The final footprint once candidates are known: the same rings (or the hull
   * of the candidates when no source gave one), with the quality accumulated
   * further: a façade element standing outside it marks it partial.
   */
  finish(candidatePositions: readonly MapPoint[], outside?: readonly OutsideElement[]): FootprintFact;
}

interface Geometry {
  rings: MapPoint[][];
  source: FootprintFact['source'];
  from: number[];
}

/** How far outside (or inside) a footprint must an external wall run before it shows the footprint does not fit, metres. */
const FIT_TOLERANCE = 1;

/**
 * The footprint against the ground storey's external walls: an axis reaching
 * more than 1 m outside it means the footprint misses part of the building
 * (`partial`); an axis running more than 1 m inside it all along means the
 * footprint is larger than the building (a podium or forecourt slab:
 * `oversized`, treated like a hull).
 */
function checkAgainstWalls(rings: MapPoint[][], input: FootprintInput, log: QualityLog): void {
  const { reader, placements, georef, storeyOf, ground } = input;
  for (const type of ['IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCWALLELEMENTEDCASE']) {
    for (const id of reader.idsOfType(type)) {
      const wall = reader.entity(id);
      if (!wall || isExternal(reader, wall) !== true) continue;
      if (ground.expressId !== null && storeyOf(id) !== ground.expressId) continue;
      const frame = placements.ofProduct(id);
      if (!frame) continue;
      // Along the whole axis (every 0.5 m), not only its ends: a wall's ends may sit on a slab's edge while its middle runs inside.
      const points = readWallAxis(reader, id).lines.flatMap((l) => {
        const line = toWorld(frame, l).map((p) => {
          const [x, y] = georef.toMap(p);
          return { x, y };
        });
        const out: MapPoint[] = [];
        for (let i = 0; i + 1 < line.length; i++) {
          const a = line[i];
          const b = line[i + 1];
          const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.5));
          for (let k = 0; k <= steps; k++) out.push({ x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps });
        }
        return line.length === 1 ? line : out;
      });
      if (points.length === 0) continue;
      const d = points.map((p) => signedDistance(p, rings));
      const out = Math.max(...d);
      if (out > FIT_TOLERANCE) log.note('partial', `external wall ${reader.className(wall)} #${id} reaches ${out.toFixed(2)} m outside the footprint`);
      else if (Math.min(...d) < -FIT_TOLERANCE) {
        log.note('oversized', `external wall ${reader.className(wall)} #${id} runs up to ${(-Math.min(...d)).toFixed(2)} m inside the footprint outline`);
      }
    }
  }
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
  let geometry: Geometry | null;
  if (input.given) {
    // An empty or degenerate given footprint would be trusted as an outline with no inside: refused, not read as ground.
    if (input.given.length === 0 || input.given.some((ring) => ring.length < 3 || ringArea(ring) < 1 || ring.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))) {
      throw new RangeError('footprint must have at least one ring, each of at least 3 finite points enclosing at least 1 m²');
    }
    geometry = { rings: input.given, source: 'given', from: [] };
  } else {
    geometry = fromModel(input, log);
  }
  // Whatever its source, the footprint must fit the building's own external walls.
  if (geometry) checkAgainstWalls(geometry.rings, input, log);
  let reported = false;
  const report = () => {
    if (reported) return;
    reported = true;
    const unread = log.unreadableSources;
    if (unread.length === 0) return;
    for (const u of unread) input.skipped.push(u);
    input.warnings.push(
      `the footprint covers only part of the ground storey: ${unread.length} source(s) there cannot be read (${unread.map((u) => `${u.ifcClass} #${u.expressId}`).join(', ')}); ` +
        'no element gets a reassuring outcome — pass a footprint (for example the cadastral outline)',
    );
  };
  return {
    fact: geometry ? seal(geometry.rings, geometry.source, geometry.from, log) : null,
    finish(candidatePositions, outside = []) {
      report();
      for (const o of outside) {
        log.note('partial', `${o.ifcClass} #${o.expressId} stands ${o.distance.toFixed(2)} m outside the footprint (a façade element cannot be interior)`);
      }
      if (geometry) return seal(geometry.rings, geometry.source, geometry.from, log);
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

function fromModel(input: FootprintInput, log: QualityLog): Geometry | null {
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
  if (rings.length > 0) return { rings, source: log.record().conditions.includes('voids-filled') ? 'slab-outline-voids-filled' : 'slab-outline', from };

  // 2. The external walls' axes: chained into one closed ring (keeps courtyards and notches), else their hull.
  const points: MapPoint[] = [];
  const axes: MapPoint[][] = [];
  const walls: number[] = [];
  let everyAxisRead = true;
  for (const type of ['IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCWALLELEMENTEDCASE']) {
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
  if (chained && ringArea(chained) >= 1) return { rings: [chained], source: 'external-wall-outline', from: walls };
  const hull = convexHull(points);
  if (hull.length >= 3 && ringArea(hull) >= 1) {
    log.mark('hull');
    return { rings: [hull], source: 'external-wall-hull', from: walls };
  }
  return null;
}
