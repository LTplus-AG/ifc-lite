/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The records `placeEachObjectOnce` (`schema-ifc2x3-placements.ts`) reads, and
 * where a grid placement resolves to, by the geometry reader's rules
 * (`rust/geometry/src/placement/grid.rs`): the intersection of the two axes'
 * chords, each shifted along its left normal by its offset, lifted by the
 * third offset, its +X turned towards a second intersection. Twin of
 * `rust/export/src/schema_ifc2x3_records.rs`.
 */

import { formatStepReal } from '@ifc-lite/data';
import { readStepSlots, splitTopLevelStepArguments } from './step-argument-parser.js';
import { stepRecordHead } from './step-record-frame.js';

export const LOCAL = 'IFCLOCALPLACEMENT';
export const GRID_PLACEMENT = 'IFCGRIDPLACEMENT';
export const INTERSECTION = 'IFCVIRTUALGRIDINTERSECTION';
/** `IfcProduct.ObjectPlacement`, the same slot on every IFC2X3 product. */
export const OBJECT_PLACEMENT = 5;
/** IfcGrid's `UAxes`, `VAxes`, `WAxes`. */
const GRID_AXIS_SLOTS = [7, 8, 9];
/** The reader's tolerance for a degenerate axis, direction or crossing. */
const EPS = 1e-9;

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export interface Rec { readonly id: number; readonly type: string; readonly text: string; readonly open: number }

/** A grid placement's frame in its grid's: where it is, and the +X turn, if any. */
export interface GridFrame { readonly at: Vec3; readonly turn: Vec2 | null }

export function refId(token: string | undefined): number | null {
  const m = /^#\s*(\d+)$/.exec((token ?? '').trim());
  return m ? Number(m[1]) : null;
}

export function num(token: string): number | null {
  const t = token.trim();
  if (t === '' || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

export function list(token: string | undefined): string[] | null {
  const t = (token ?? '').trim();
  return t.startsWith('(') && t.endsWith(')') ? splitTopLevelStepArguments(t.slice(1, -1)) : null;
}

export function numbers(token: string | undefined, min: number, max: number): number[] | null {
  const items = list(token);
  if (!items || items.length < min || items.length > max) return null;
  const values = items.map(num);
  return values.every((v): v is number => v !== null) ? values : null;
}

export function triple(v: readonly number[]): string {
  return `(${v.map(formatStepReal).join(',')})`;
}

export class Records {
  readonly list: (Rec | null)[];
  private readonly byId = new Map<number, Rec>();
  private readonly split = new Map<number, string[] | null>();
  maxId = 0;

  constructor(lines: readonly string[]) {
    this.list = lines.map((text) => {
      const head = stepRecordHead(text);
      if (!head) return null;
      const id = Number(/#\s*(\d+)/.exec(text)![1]);
      const rec = { id, type: text.slice(head.typeStart, head.typeEnd).toUpperCase(), text, open: head.open };
      this.byId.set(id, rec);
      if (id > this.maxId) this.maxId = id;
      return rec;
    });
  }

  get(id: number | null, type?: string): Rec | undefined {
    const rec = id === null ? undefined : this.byId.get(id);
    return rec && (type === undefined || rec.type === type) ? rec : undefined;
  }

  slots(rec: Rec | undefined): string[] | null {
    if (!rec) return null;
    if (!this.split.has(rec.id)) this.split.set(rec.id, readStepSlots(rec.text)?.slots.slice() ?? null);
    return this.split.get(rec.id)!;
  }

  /** The coordinates of a point or the ratios of a direction, by id. */
  vector(token: string | undefined, type: string): number[] | null {
    return numbers(this.slots(this.get(refId(token), type))?.[0], 2, 3);
  }

  /** An axis's chord, with its sense, as origin and direction; null when it does not read. */
  private axisLine(id: number): { o: Vec2; d: Vec2 } | null {
    const axis = this.slots(this.get(id, 'IFCGRIDAXIS'));
    const points = list(this.slots(this.get(refId(axis?.[1]), 'IFCPOLYLINE'))?.[0]);
    if (!axis || !points || points.length < 2) return null;
    const a = this.vector(points[0], 'IFCCARTESIANPOINT');
    const b = this.vector(points[points.length - 1], 'IFCCARTESIANPOINT');
    if (!a || !b) return null;
    let d: Vec2 = [b[0] - a[0], b[1] - a[1]];
    if (Math.sqrt(d[0] * d[0] + d[1] * d[1]) < EPS) return null;
    if ((axis[2] ?? '').trim().toUpperCase() === '.F.') d = [-d[0], -d[1]];
    return { o: [a[0], a[1]], d };
  }

  /** An intersection's point in its grid's frame; null when it does not read. */
  crossing(id: number | null): Vec3 | null {
    const s = this.slots(this.get(id, INTERSECTION));
    const axes = list(s?.[0])?.map(refId);
    if (!s || !axes || axes.length !== 2 || axes.includes(null)) return null;
    const offsets = s[1]?.trim() === '$' ? [0, 0] : numbers(s[1], 2, 3);
    const a = this.axisLine(axes[0]!);
    const b = this.axisLine(axes[1]!);
    if (!offsets || !a || !b) return null;
    const shifted = ({ o, d }: { o: Vec2; d: Vec2 }, by: number): Vec2 => {
      const len = Math.sqrt(d[0] * d[0] + d[1] * d[1]);
      return [o[0] + (-d[1] / len) * by, o[1] + (d[0] / len) * by];
    };
    const pa = shifted(a, offsets[0]);
    const pb = shifted(b, offsets[1]);
    const denom = a.d[0] * b.d[1] - a.d[1] * b.d[0];
    if (Math.abs(denom) < EPS) return null;
    const t = ((pb[0] - pa[0]) * b.d[1] - (pb[1] - pa[1]) * b.d[0]) / denom;
    return [pa[0] + t * a.d[0], pa[1] + t * a.d[1], offsets[2] ?? 0];
  }

  /** Where a grid placement (IFC2X3 layout) sits in its grid's frame. */
  gridFrame(g: readonly string[]): GridFrame | null {
    const at = this.crossing(refId(g[0]));
    if (!at) return null;
    if (g[1].trim() === '$') return { at, turn: null };
    const toward = this.crossing(refId(g[1]));
    const ratios = toward ? null : this.vector(g[1], 'IFCDIRECTION');
    const v = toward ? [toward[0] - at[0], toward[1] - at[1]] : ratios;
    if (!v) return null;
    const norm = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    if (!Number.isFinite(norm)) return null;
    return { at, turn: norm < EPS ? null : [v[0] / norm, v[1] / norm] };
  }

  /** The `ObjectPlacement` of the first grid listing an axis of the intersection, as a slot value. */
  gridPlacementOf(intersection: number | null): string {
    const axis = refId(list(this.slots(this.get(intersection, INTERSECTION))?.[0])?.[0]);
    for (const rec of this.list) {
      if (rec?.type !== 'IFCGRID') continue;
      const s = this.slots(rec);
      if (axis !== null && s && GRID_AXIS_SLOTS.some((i) => list(s[i])?.some((m) => refId(m) === axis))) {
        return refId(s[OBJECT_PLACEMENT]) === null ? '$' : `#${refId(s[OBJECT_PLACEMENT])}`;
      }
    }
    return '$';
  }
}
