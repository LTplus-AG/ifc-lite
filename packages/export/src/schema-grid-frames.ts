/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcGridPlacement.PlacementRelTo` for an IFC2X3 or IFC4 source converted to
 * IFC4X3 (#9026 item 14).
 *
 * IFC4X3 gives IfcGridPlacement the inherited `PlacementRelTo`, ahead of its
 * other attributes. Below IFC4X3 the attribute does not exist: the placement
 * sits in the frame of the IfcGrid that owns its axes. So the record cannot
 * pass through, and `$` is not enough either: in IFC4X3 `$` means the world
 * frame, which moves every element on a grid that is not at the origin. The
 * owning grid's `ObjectPlacement` says the same thing the source did.
 *
 * It is a pre-pass because a grid may follow the placements on it. The owner
 * rule is the reader's (`EntityDecoder::grid_of_axis`): the first grid in file
 * order listing the location's first axis. Twin of
 * `rust/export/src/schema_grid_frames.rs`, pinned for both by
 * `rust/export/tests/fixtures/schema_grid_placement_vectors.json`.
 */

import { splitTopLevelStepArguments } from './step-argument-parser.js';

/** The grid records a placement's frame is read from, in both source layouts. */
export const GRID_FRAME_TYPES = ['IFCGRID', 'IFCVIRTUALGRIDINTERSECTION'] as const;

/** IfcGrid slots, the same in IFC2X3 and IFC4. */
const OBJECT_PLACEMENT = 5;
const AXIS_SLOTS = [7, 8, 9];
/** `(PlacementLocation, PlacementRefDirection)`: the IFC2X3 and IFC4 list. */
const SOURCE_ARITY = 2;

function refId(token: string | undefined): number | null {
  const m = /^#\s*(\d+)$/.exec((token ?? '').trim());
  return m ? Number(m[1]) : null;
}

function refIds(value: string | undefined): number[] {
  const t = (value ?? '').trim();
  if (!t.startsWith('(') || !t.endsWith(')')) return [];
  return (splitTopLevelStepArguments(t.slice(1, -1)) ?? []).map(refId).filter((id): id is number => id !== null);
}

export class GridFrames {
  /** In file order, created grids after source ones: the first listing an axis owns it. */
  private readonly grids = new Map<number, { placement: number | null; axes: readonly number[] }>();
  private readonly firstAxis = new Map<number, number>();
  private written: (gridId: number) => boolean = () => true;

  /** Register a grid or an intersection by its attribute slots; the last record with an id wins. */
  note(type: string, id: number, args: readonly string[]): void {
    if (type === 'IFCGRID') {
      this.grids.set(id, { placement: refId(args[OBJECT_PLACEMENT]), axes: AXIS_SLOTS.flatMap((slot) => refIds(args[slot])) });
    } else if (type === 'IFCVIRTUALGRIDINTERSECTION') {
      const axis = refIds(args[0])[0];
      if (axis === undefined) this.firstAxis.delete(id);
      else this.firstAxis.set(id, axis);
    }
  }

  /** {@link note}, from a record's attribute text. */
  noteAttributes(type: string, id: number, attributes: string): void {
    const args = splitTopLevelStepArguments(attributes);
    if (args) this.note(type, id, args);
  }

  /** Which grids this export writes: a grid left out has no placement to name. */
  retain(written: (gridId: number) => boolean): void {
    this.written = written;
  }

  /** The owning grid's placement as a slot value; `$` when nothing owns the axis or the grid has none. */
  private relTo(locationId: number | null): string {
    const axis = locationId === null ? undefined : this.firstAxis.get(locationId);
    if (axis === undefined) return '$';
    for (const [gridId, grid] of this.grids) {
      if (!grid.axes.includes(axis)) continue;
      return grid.placement !== null && this.written(gridId) ? `#${grid.placement}` : '$';
    }
    return '$';
  }

  /** An IfcGridPlacement's attribute list in the IFC4X3 layout; null when `args` is not the source layout. */
  lift(args: readonly string[]): string[] | null {
    return args.length === SOURCE_ARITY ? [this.relTo(refId(args[0])), ...args] : null;
  }
}
