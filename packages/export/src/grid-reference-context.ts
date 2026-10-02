/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** IfcGridPlacement reaches its axes forwards, but their owning IfcGrid is
 * inverse context (#6232). Read ownership from the same effective STEP lines
 * that the subgraph writes; no coordinates or placement resolution live here. */
import { getAttributeNamesForSchema } from '@ifc-lite/parser';
import type { EffectiveEntityIndex } from './effective-index.js';
import { refGroupFromArg } from './reference-collector.js';
import { readStepSlots } from './step-argument-parser.js';
import type { IfcSchemaVersion } from './schema-converter.js';

interface Membership { gridId: number; row: string }

export function gridReferenceContext(
  index: EffectiveEntityIndex,
  line: (id: number) => string | null,
  schema: IfcSchemaVersion,
): (placementId: number) => number | null {
  let owners: Map<number, Membership[]> | undefined;
  const ref = stepReferenceReader(index, line, schema);
  return (placementId) => {
    const intersection = ref(placementId, 'IFCGRIDPLACEMENT', 'PlacementLocation');
    if (typeof intersection !== 'number') return null;
    const axes = ref(intersection, 'IFCVIRTUALGRIDINTERSECTION', 'IntersectingAxes');
    if (!Array.isArray(axes) || axes.length !== 2 || axes[0] === axes[1]
      || axes.some((id) => index.typeOf(id) !== 'IFCGRIDAXIS')) return null;
    if (!owners) {
      owners = new Map();
      // One effective type bucket, including created/retyped/deleted grids.
      for (const gridId of index.byType.get('IFCGRID') ?? []) {
        for (const row of ['UAxes', 'VAxes', 'WAxes']) {
          const rowAxes = ref(gridId, 'IFCGRID', row);
          if (!Array.isArray(rowAxes)) continue;
          for (const axisId of rowAxes) {
            const memberships = owners.get(axisId) ?? [];
            memberships.push({ gridId, row });
            owners.set(axisId, memberships);
          }
        }
      }
    }
    const first = owners.get(axes[0]);
    const second = owners.get(axes[1]);
    if (first?.length !== 1 || second?.length !== 1
      || first[0].gridId !== second[0].gridId || first[0].row === second[0].row) return null;
    return first[0].gridId;
  };
}

/** Typed reference slots read from the exporter's effective record text. */
export function stepReferenceReader(
  index: EffectiveEntityIndex,
  line: (id: number) => string | null,
  schema: IfcSchemaVersion,
): (id: number, type: string, name: string) => number | number[] | undefined {
  const slots = (id: number) => {
    const text = line(id);
    return text === null ? undefined : readStepSlots(text)?.slots;
  };
  const attributes = new Map<string, string[]>();
  const attribute = (type: string, name: string): number => {
    let names = attributes.get(type);
    if (!names) {
      names = getAttributeNamesForSchema(type, schema);
      attributes.set(type, names);
    }
    return names.indexOf(name);
  };
  return (id: number, type: string, name: string) => {
    if (index.typeOf(id) !== type) return undefined;
    const values = slots(id);
    const token = values?.[attribute(type, name)];
    return token === undefined ? undefined : refGroupFromArg(token);
  };
}
