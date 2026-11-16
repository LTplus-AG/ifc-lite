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

import { roofedBy, upperSlabs, type UpperSlab } from './slab-holes.js';
import { chainIntoRing, convexHull, ringArea } from '../geom.js';
import { closedGaps, prepareFootprint, signedDistance } from '../region.js';
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

  /** A finding that does not lower the quality (a closed gap between slabs). */
  remark(text: string): void {
    this.notes.push(text);
  }

  mark(condition: Exclude<FootprintQuality, 'complete'>): void {
    if (!this.conditions.includes(condition)) this.conditions.push(condition);
  }

  /**
   * The one recorder for a source walked for the footprint (or its wall check)
   * and not used, with why: it is listed once and the footprint is partial.
   */
  unread(expressId: number, ifcClass: string, reason: string): void {
    if (!this.unreadable.some((u) => u.expressId === expressId)) this.unreadable.push({ expressId, ifcClass, reason });
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
  /** Indices into `rings` of the slab holes that are open ground (courtyards). */
  courtyardRings?: number[];
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
function checkAgainstWalls(geometry: Geometry, input: FootprintInput, log: QualityLog): void {
  const region = prepareFootprint(geometry);
  const { reader, placements, georef, storeyOf, ground } = input;
  for (const type of ['IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCWALLELEMENTEDCASE']) {
    for (const id of reader.idsOfType(type)) {
      const wall = reader.entity(id);
      if (!wall || isExternal(reader, wall) !== true) continue;
      if (ground.expressId !== null && storeyOf(id) !== ground.expressId) continue;
      const frame = placements.ofProduct(id);
      const cls = reader.className(wall);
      // A wall that cannot be checked is recorded, never skipped silently: the footprint may disagree with it.
      if (!frame) {
        log.unread(id, cls, 'external wall in the ground storey whose placement cannot be read, so the footprint cannot be checked against it');
        continue;
      }
      const axis = readWallAxis(reader, id);
      const axisState = completeness(axis);
      if (axisState === 'unreadable' || axisState === 'partial') {
        log.unread(id, cls, `external wall in the ground storey whose axis can be read ${axisState === 'partial' ? `only in part (${axis.readable} of ${axis.items} curves)` : 'not at all'}, so the footprint cannot be fully checked against it`);
      } else if (axisState === 'none') {
        // No Axis representation: nothing to read (common), so the wall cannot cross-check the outline. Recorded, not partial.
        log.remark(`external wall ${cls} #${id} has no Axis representation, so the footprint is not checked against it`);
      }
      // Along the whole axis (every 0.5 m), not only its ends: a wall's ends may sit on a slab's edge while its middle runs inside.
      const points = axis.lines.flatMap((l) => {
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
      // The rings are non-empty here, so every distance is known.
      const d = points.map((p) => signedDistance(region, p) ?? 0);
      const out = Math.max(...d);
      if (out > FIT_TOLERANCE) log.note('partial', `external wall ${reader.className(wall)} #${id} reaches ${out.toFixed(2)} m outside the footprint`);
      else if (Math.min(...d) < -FIT_TOLERANCE) {
        log.note('oversized', `external wall ${reader.className(wall)} #${id} runs up to ${(-Math.min(...d)).toFixed(2)} m inside the footprint outline`);
      }
    }
  }
}

function seal(rings: MapPoint[][], source: FootprintFact['source'], fromElements: number[], log: QualityLog, courtyardRings: number[] = []): FootprintFact {
  const region = prepareFootprint({ rings, source, courtyardRings });
  if (region.courtyards.size > 0) log.mark('courtyard-ring');
  if (region.closedSmallRings.length > 0) {
    log.remark(`ring(s) ${region.closedSmallRings.join(', ')} of the given footprint enclose less than 1 m², below the closing scale, and are treated as closed (inside the building)`);
  }
  const gaps = closedGaps(region);
  if (gaps > 0) log.remark(`${gaps} boundary stretch(es) face a gap between footprint rings narrower than about 0.9 m, closed as inside the building`);
  const quality = log.record();
  const fact: FootprintFact = { rings, source, fromElements, quality };
  if (courtyardRings.length > 0) fact.courtyardRings = [...courtyardRings];
  if (quality.conditions.includes('partial')) fact.partial = true;
  return fact;
}

/** Resolve the footprint and its accumulated quality. Throws `RangeError` for an empty or degenerate given footprint. */
export function resolveFootprint(input: FootprintInput): FootprintResolution {
  const log = new QualityLog();
  let geometry: Geometry | null;
  if (input.given) {
    // An empty or degenerate given footprint would be trusted as an outline with no inside: refused, not read as ground.
    // Every ring needs 3 finite points; at least one must enclose 1 m² (a smaller inner ring is accepted and stays closed).
    if (input.given.length === 0 || input.given.some((ring) => ring.length < 3 || ring.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) || !input.given.some((ring) => ringArea(ring) >= 1)) {
      throw new RangeError('footprint must have rings of at least 3 finite points each, at least one of them enclosing at least 1 m²');
    }
    geometry = { rings: input.given, source: 'given', from: [] };
  } else {
    geometry = fromModel(input, log);
  }
  // Whatever its source, the footprint must fit the building's own external walls.
  if (geometry) checkAgainstWalls(geometry, input, log);
  let reported = false;
  const report = () => {
    if (reported) return;
    reported = true;
    const unread = log.unreadableSources;
    if (unread.length === 0) return;
    for (const u of unread) input.skipped.push({ ...u, stage: 'footprint-source' });
    input.warnings.push(
      `the footprint covers only part of the ground storey: ${unread.length} source(s) there cannot be read or are not used (${unread.map((u) => `${u.ifcClass} #${u.expressId}`).join(', ')}); ` +
        'no element gets a reassuring outcome — pass a footprint (for example the cadastral outline)',
    );
  };
  return {
    fact: geometry ? seal(geometry.rings, geometry.source, geometry.from, log, geometry.courtyardRings) : null,
    finish(candidatePositions, outside = []) {
      report();
      for (const o of outside) {
        log.note('partial', `${o.ifcClass} #${o.expressId} stands ${o.distance.toFixed(2)} m outside the footprint (a façade element cannot be interior)`);
      }
      if (geometry) return seal(geometry.rings, geometry.source, geometry.from, log, geometry.courtyardRings);
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

  // Without a storey nothing says which slabs or walls are at ground level: every one is taken, so the outline may include
  // an upper floor's projection. Never complete.
  if (ground.expressId === null) {
    log.note('partial', 'no storey identifies the ground level, so every floor slab and external wall was taken and the outline may include upper floors');
  }

  // 1. The ground storey's floor slab outlines. Ids are keyed by the raw STEP name: the standard and elemented cases are separate keys.
  const rings: MapPoint[][] = [];
  const from: number[] = [];
  const courtyards: Array<{ ring: MapPoint[]; text: string }> = [];
  let above: UpperSlab[] | undefined;
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
    // A ring smaller than 1 m² is not used for the outline: the slab then counts as a source not used, and the outline as partial.
    let used = 0;
    for (const r of outline.rings) {
      const ring = toRing(toWorld(frame, r));
      if (ringArea(ring) >= 1) {
        rings.push(ring);
        used++;
      } else {
        log.unread(id, cls, `ground-storey floor slab ring enclosing less than 1 m² (${ringArea(ring).toFixed(2)} m²), not used in the outline`);
      }
    }
    if (used > 0) from.push(id);
    if (outline.voids) log.mark('voids-filled');
    // The profile's holes, read: under 1 m² closed; roofed by a slab above, interior (filled); else open ground, a courtyard.
    const z = georef.toMap(frame.origin)[2];
    for (const h of outline.holes) {
      const ring = toRing(toWorld(frame, h));
      const area = ringArea(ring);
      if (area < 1) continue;
      above ??= upperSlabs(input);
      const roof = roofedBy(above, ring, z);
      if (roof !== null) {
        log.remark(`a ${area.toFixed(2)} m² hole in ${cls} #${id} is wholly roofed by slab(s) #${roof.join(', #')} (a shaft, a stair opening or a floor area under the building): interior, filled`);
      } else {
        courtyards.push({ ring, text: `a ${area.toFixed(2)} m² hole in ${cls} #${id} is not wholly roofed by a slab above: a courtyard, open ground` });
      }
    }
  }
  if (rings.length > 0) {
    const courtyardRings: number[] = [];
    for (const c of courtyards) {
      courtyardRings.push(rings.length);
      rings.push(c.ring);
      log.remark(c.text);
    }
    return { rings, source: log.record().conditions.includes('voids-filled') ? 'slab-outline-voids-filled' : 'slab-outline', from, courtyardRings };
  }

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
