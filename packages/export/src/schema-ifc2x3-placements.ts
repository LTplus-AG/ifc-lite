/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The grid and shared placements of an IFC2X3 output each place exactly one
 * product (#9209).
 *
 * IFC2X3 declares `IfcObjectPlacement.PlacesObject` as `SET [1:1]`; IFC4
 * relaxed it to `SET [0:?]`, and the models this package writes use that:
 *
 *   - a column on a grid is `IfcColumn` -> `IfcLocalPlacement` ->
 *     `IfcGridPlacement`, so the grid placement places nothing;
 *   - a blank model's site and building share one `IfcLocalPlacement`.
 *
 * So an IFC2X3 output is adapted after it is written, the same way for a
 * converted file and an IFC2X3 source:
 *
 *   - A grid placement that places nothing, with one local child that only
 *     lifts it (no heading, no offset in plan), is folded: the child keeps its
 *     id and becomes the grid placement, its height carried as the
 *     intersection's third offset. Its product keeps naming it.
 *   - Otherwise each local child is written as a plain `IfcLocalPlacement` in
 *     the owning grid's frame, at the position the grid placement resolves
 *     to, and the grid placement is not written. A grid placement whose
 *     intersection does not read (curved axes, say), or one over an axis
 *     that bends, where readers may disagree on the point, is left as it was.
 *   - A placement shared by several products gives each product after the
 *     first its own copy.
 *
 * New records take the ids after the highest one and are written after the
 * last record, in id order, the order a re-read file is written back in.
 *
 * A local placement that places nothing and only parents another one is a
 * source file's shape, under a grid or not; ifc-lite never writes it, and this
 * pass leaves it as it was. Under a grid placement it is still folded or freed
 * as above, which writes one placement that places nothing instead of two.
 *
 * Positions follow the geometry reader (`rust/geometry/src/placement/grid.rs`):
 * the intersection of the two axes' chords, each shifted along its left
 * normal by its offset, lifted by the third offset; `PlacementRefDirection`
 * turns local +X towards a second intersection. IFC4 and IFC4X3 outputs never
 * reach this pass. Twin of `rust/export/src/schema_ifc2x3_placements.rs`,
 * pinned for both by `rust/export/tests/fixtures/schema_grid_placement_vectors.json`.
 */

import { formatStepReal } from '@ifc-lite/data';
import { readStepSlots } from './step-argument-parser.js';
import {
  GRID_PLACEMENT, INTERSECTION, LOCAL, OBJECT_PLACEMENT, Records, list, num, refId, triple, type GridFrame, type Vec3,
} from './schema-ifc2x3-records.js';

interface Users {
  /** Local placements by the placement they are relative to. */
  readonly children: Map<number, number[]>;
  /** Products by the placement in their `ObjectPlacement`. */
  readonly products: Map<number, number[]>;
  /** Placements named anywhere else: left as they are. */
  readonly others: Set<number>;
  /** How many references each intersection has. */
  readonly crossings: Map<number, number>;
}

function append<T>(map: Map<number, T[]>, key: number, value: T): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

/** The `#n` references in `text` from `from` on, outside string literals. */
function references(text: string, from: number): number[] {
  const ids: number[] = [];
  for (let i = from; i < text.length; i++) {
    if (text[i] === "'") {
      for (i++; i < text.length; i++) {
        if (text[i] === "'" && text[i + 1] === "'") i++;
        else if (text[i] === "'") break;
      }
    } else if (text[i] === '#') {
      let j = i + 1;
      while (j < text.length && text[j] >= '0' && text[j] <= '9') j++;
      if (j > i + 1) ids.push(Number(text.slice(i + 1, j)));
      i = j - 1;
    }
  }
  return ids;
}

/** Who names each placement and intersection. */
function users(records: Records): Users {
  const placements = new Set<number>();
  const crossings = new Map<number, number>();
  for (const rec of records.list) {
    if (rec?.type === LOCAL || rec?.type === GRID_PLACEMENT) placements.add(rec.id);
    else if (rec?.type === INTERSECTION) crossings.set(rec.id, 0);
  }
  const found: Users = { children: new Map(), products: new Map(), others: new Set(), crossings };
  if (placements.size === 0) return found;
  for (const rec of records.list) {
    if (!rec) continue;
    const hits: number[] = [];
    for (const id of references(rec.text, rec.open)) {
      if (placements.has(id)) hits.push(id);
      else if (crossings.has(id)) crossings.set(id, crossings.get(id)! + 1);
    }
    if (hits.length === 0) continue;
    const s = records.slots(rec);
    for (const id of new Set(hits)) {
      const once = hits.filter((h) => h === id).length === 1;
      if (once && s && rec.type === LOCAL && refId(s[0]) === id) append(found.children, id, rec.id);
      else if (once && s && rec.type !== LOCAL && rec.type !== GRID_PLACEMENT && refId(s[OBJECT_PLACEMENT]) === id) append(found.products, id, rec.id);
      else found.others.add(id);
    }
  }
  return found;
}

/**
 * The IFC2X3 output `lines` with every object placement placing one product;
 * null when nothing changes. See the module comment.
 */
export function placeEachObjectOnce(lines: readonly string[]): string[] | null {
  const records = new Records(lines);
  // A record adds at most four (a freed child's point, two directions and
  // axes); a file whose ids leave no room for them is left as it was.
  if (records.maxId + 4 * records.list.length >= 0xffffffff) return null;
  const { children, products, others, crossings } = users(records);
  const rewrites = new Map<number, string>();
  /** New records, in id order: written after the last record, where a re-read writes them back. */
  const added: string[] = [];
  const drops = new Set<number>();
  let next = records.maxId + 1;
  /** A grid placement not written, and the intersections only it named. */
  const drop = (id: number, g: readonly string[]) => {
    drops.add(id);
    const named = g.map(refId);
    for (const i of new Set(named)) {
      if (i !== null && crossings.get(i) === named.filter((n) => n === i).length) drops.add(i);
    }
  };

  for (const rec of records.list) {
    if (rec?.type !== GRID_PLACEMENT || others.has(rec.id) || products.has(rec.id)) continue;
    const g = records.slots(rec);
    const kids = children.get(rec.id) ?? [];
    if (!g || g.length !== 2) continue;
    if (kids.length === 0) {
      drop(rec.id, g);
      continue;
    }
    const lifts = kids.length === 1 ? lift(records, kids[0], g) : null;
    if (lifts) {
      const at = refId(g[0])!;
      let location = g[0].trim();
      if (lifts.intersection && crossings.get(at) === 1) rewrites.set(at, `#${at}=${INTERSECTION}(${lifts.intersection});`);
      else if (lifts.intersection) {
        added.push(`#${next}=${INTERSECTION}(${lifts.intersection});`);
        location = `#${next++}`;
      }
      rewrites.set(kids[0], `#${kids[0]}=${GRID_PLACEMENT}(${location},${g[1].trim()});`);
      drops.add(rec.id);
      continue;
    }
    const frame = records.gridFrame(g);
    const freed = frame && kids.map((kid) => free(records, kid, frame));
    if (!freed || freed.includes(null)) continue;
    const relTo = records.gridPlacementOf(refId(g[0]));
    freed.forEach((written, i) => {
      const ids = written!.map(() => next++);
      written!.forEach((line, k) => added.push(`#${ids[k]}=${line.replace(/#\{(\d)\}/g, (_, j: string) => `#${ids[Number(j)]}`)}`));
      rewrites.set(kids[i], `#${kids[i]}=${LOCAL}(${relTo},#${ids[ids.length - 1]});`);
    });
    drop(rec.id, g);
  }

  for (const rec of records.list) {
    const placed = rec && products.get(rec.id);
    if (!rec || !placed || placed.length < 2 || drops.has(rec.id)) continue;
    const own = rewrites.get(rec.id) ?? rec.text;
    const frame = readStepSlots(own);
    if (!frame) continue;
    for (const product of placed.slice(1)) {
      const productFrame = readStepSlots(records.get(product)!.text);
      if (!productFrame) continue;
      const copy = next++;
      added.push(`#${copy}=${frame.type}(${frame.slots.join(',')});`);
      const slots = [...productFrame.slots];
      slots[OBJECT_PLACEMENT] = `#${copy}`;
      rewrites.set(product, `${productFrame.prefix}${slots.join(',')}${productFrame.suffix}`);
    }
  }

  if (rewrites.size === 0 && drops.size === 0) return null;
  const out: string[] = [];
  lines.forEach((line, i) => {
    const rec = records.list[i];
    if (rec && drops.has(rec.id)) return;
    out.push(rec ? rewrites.get(rec.id) ?? line : line);
  });
  for (const line of added) out.push(line); // not spread: there can be more than a call takes
  return out;
}

/**
 * `lines`, adapted in place by {@link placeEachObjectOnce} when `schema` is
 * IFC2X3 and left as they are otherwise: the one call every STEP writer makes
 * on its finished records.
 */
export function placeObjectsForSchema(schema: string, lines: string[]): string[] {
  const placed = schema === 'IFC2X3' ? placeEachObjectOnce(lines) : null;
  if (placed) {
    lines.length = 0;
    for (const line of placed) lines.push(line);
  }
  return lines;
}

/**
 * A child that only lifts its grid placement, folded: the intersection to
 * write with the lift as its third offset (null for no lift). Null when the
 * child turns, tilts or moves in plan, or anything does not read.
 */
function lift(records: Records, kid: number, g: readonly string[]): { intersection: string | null } | null {
  const l = records.slots(records.get(kid));
  const a = records.slots(records.get(refId(l?.[1]), 'IFCAXIS2PLACEMENT3D'));
  const at = a && records.vector(a[0], 'IFCCARTESIANPOINT');
  if (!l || l.length !== 2 || !a || a.length !== 3 || !at || at[0] !== 0 || at[1] !== 0) return null;
  const axis = a[1].trim() === '$' ? [0, 0, 1] : records.vector(a[1], 'IFCDIRECTION');
  const ref = a[2].trim() === '$' ? [1, 0] : records.vector(a[2], 'IFCDIRECTION');
  if (!axis || axis.length !== 3 || axis[0] !== 0 || axis[1] !== 0 || !(axis[2] > 0)) return null;
  if (!ref || !(ref[0] > 0) || ref[1] !== 0) return null;
  if (g[1].trim() !== '$' && !records.get(refId(g[1]), INTERSECTION)) return null;
  const i = records.slots(records.get(refId(g[0]), INTERSECTION));
  if (!i || i.length !== 2 || !records.crossing(refId(g[0]))) return null;
  const dz = at[2] ?? 0;
  if (dz === 0) return { intersection: null };
  const offsets = i[1].trim() === '$' ? ['0.', '0.'] : list(i[1]);
  if (!offsets || (offsets.length !== 2 && offsets.length !== 3)) return null;
  const z0 = offsets[2] === undefined ? 0 : num(offsets[2]);
  if (z0 === null) return null;
  const z = z0 + dz;
  return { intersection: `${i[0].trim()},(${offsets[0].trim()},${offsets[1].trim()},${formatStepReal(z)})` };
}

/**
 * A child as a plain placement in its grid's frame: the records to write
 * before it, the last one its new `RelativePlacement`. `#{k}` names the k-th
 * of them. Null when its relative placement does not read.
 */
function free(records: Records, kid: number, frame: GridFrame): string[] | null {
  const l = records.slots(records.get(kid));
  const a = records.slots(records.get(refId(l?.[1]), 'IFCAXIS2PLACEMENT3D'));
  const at = a && records.vector(a[0], 'IFCCARTESIANPOINT');
  if (!l || l.length !== 2 || !a || a.length !== 3 || !at) return null;
  const axisGiven = a[1].trim() !== '$';
  const refGiven = a[2].trim() !== '$';
  const axis = axisGiven ? records.vector(a[1], 'IFCDIRECTION') : null;
  const ref = refGiven ? records.vector(a[2], 'IFCDIRECTION') : null;
  if ((axisGiven && !axis) || (refGiven && !ref)) return null;
  const [c, s] = frame.turn ?? [1, 0];
  const turn = (v: readonly number[]): Vec3 => (frame.turn ? [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2] ?? 0] : [v[0], v[1], v[2] ?? 0]);
  const p = turn(at);
  const lines = [`IFCCARTESIANPOINT(${triple([frame.at[0] + p[0], frame.at[1] + p[1], frame.at[2] + p[2]])});`];
  const slot = (given: boolean, raw: string, v: number[] | null, fallback: Vec3 | null): string => {
    if (!frame.turn) return given ? raw.trim() : '$';
    const turned = v ? turn(v) : fallback;
    if (!turned) return '$';
    if (v && turned[0] === v[0] && turned[1] === v[1]) return raw.trim();
    lines.push(`IFCDIRECTION(${triple(turned)});`);
    return `#{${lines.length - 1}}`;
  };
  const axisSlot = slot(axisGiven, a[1], axis, null);
  const refSlot = slot(refGiven, a[2], ref, [c, s, 0]);
  lines.push(`IFCAXIS2PLACEMENT3D(#{0},${axisSlot},${refSlot});`);
  return lines;
}
