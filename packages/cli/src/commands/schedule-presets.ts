/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Named presets for `ifc-lite schedule --preset <name>`.
 *
 * A preset supplies a default `--type` and a default `--columns` set (and,
 * optionally, a default `--group-by`/`--sort`/`--subtotals`) so a common
 * schedule runs with no other flags. Explicit `--type`/`--columns`/
 * `--group-by`/`--sort`/`--subtotals` each override the preset's corresponding
 * default (explicit flag wins); `--where`/`--format` apply as normal.
 *
 * Column paths use the standard IFC4 property/quantity sets. A path is `Attr`,
 * `Pset.Prop`, or `Qto.Qty`, written `Header=path`. The `Material` pseudo-path
 * resolves an element's associated material name via the shared material
 * accessor (see `resolveScheduleValue`).
 */

import { fatal } from '../output.js';

export interface SchedulePreset {
  type: string;
  columns: string;
  groupBy?: string;
  sort?: string;
  subtotals?: string;
}

export const SCHEDULE_PRESETS: Record<string, SchedulePreset> = {
  door: {
    type: 'IfcDoor',
    columns:
      'Mark=Tag, Name, FireRating=Pset_DoorCommon.FireRating, IsExternal=Pset_DoorCommon.IsExternal, Width=Qto_DoorBaseQuantities.Width, Height=Qto_DoorBaseQuantities.Height',
  },
  window: {
    type: 'IfcWindow',
    columns:
      'Mark=Tag, Name, FireRating=Pset_WindowCommon.FireRating, IsExternal=Pset_WindowCommon.IsExternal, Width=Qto_WindowBaseQuantities.Width, Height=Qto_WindowBaseQuantities.Height',
  },
  space: {
    type: 'IfcSpace',
    columns:
      'Number=Name, LongName=LongName, Category=Pset_SpaceCommon.Category, NetFloorArea=Qto_SpaceBaseQuantities.NetFloorArea, NetVolume=Qto_SpaceBaseQuantities.NetVolume',
    sort: 'NetFloorArea:desc',
  },
  wall: {
    type: 'IfcWall',
    columns:
      'Name, FireRating=Pset_WallCommon.FireRating, IsExternal=Pset_WallCommon.IsExternal, LoadBearing=Pset_WallCommon.LoadBearing, Length=Qto_WallBaseQuantities.Length, Height=Qto_WallBaseQuantities.Height, NetVolume=Qto_WallBaseQuantities.NetVolume',
  },
  'material-takeoff': {
    type: 'IfcWall',
    columns: 'Material=Material, NetVolume=Qto_WallBaseQuantities.NetVolume',
    groupBy: 'Material',
    subtotals: 'count, sum:NetVolume',
  },
};

/**
 * Look up a preset by name (case-insensitive). An unknown name is a
 * `fatal(...)` that lists the valid preset names.
 *
 * `Object.hasOwn` guards a plain-object-property lookup against a name that
 * collides with something every object inherits from `Object.prototype`
 * (`constructor`, `toString`, `hasOwnProperty`, ...) — a bare
 * `SCHEDULE_PRESETS[name]` would resolve `--preset constructor` to the
 * inherited `Function` value instead of failing, since a function is truthy
 * and a plain `!preset` check never catches it.
 */
export function resolvePreset(name: string): SchedulePreset {
  const key = name.toLowerCase();
  if (!Object.hasOwn(SCHEDULE_PRESETS, key)) {
    fatal(
      `Unknown --preset "${name}". Valid presets: ${Object.keys(SCHEDULE_PRESETS).join(', ')}.`,
    );
  }
  return SCHEDULE_PRESETS[key];
}
