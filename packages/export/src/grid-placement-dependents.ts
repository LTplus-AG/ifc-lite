/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Inverse placement dependencies for live grid edits (#6232). The records,
 * schema slots and ownership are shared with mini STEP serialization. No
 * placement math: the canonical mesher resolves the returned products. */
import { getAttributeNamesForSchema } from '@ifc-lite/parser';
import type { EffectiveEntityIndex } from './effective-index.js';
import { gridReferenceContext, stepReferenceReader } from './grid-reference-context.js';
import type { IfcSchemaVersion } from './schema-converter.js';

export function collectGridPlacementDependents(
  index: EffectiveEntityIndex, line: (id: number) => string | null,
  schema: IfcSchemaVersion, gridIds: ReadonlySet<number>,
): Set<number> {
  const out = new Set<number>();
  if (![...gridIds].some((id) => index.typeOf(id) === 'IFCGRID')) return out;
  const owner = gridReferenceContext(index, line, schema);
  const ref = stepReferenceReader(index, line, schema);
  const bindings = new Map<number, number[]>();
  const append = (map: Map<number, number[]>, key: number, id: number) => {
    const ids = map.get(key) ?? []; ids.push(id); map.set(key, ids);
  };
  for (const placement of index.byType.get('IFCGRIDPLACEMENT') ?? []) {
    const grid = owner(placement);
    if (grid !== null) append(bindings, grid, placement);
  }
  // Ordinary models pay no placement/product scan when no target is bound.
  if (![...gridIds].some((id) => bindings.has(id))) return out;
  const children = new Map<number, number[]>();
  for (const placement of index.byType.get('IFCLOCALPLACEMENT') ?? []) {
    const parent = ref(placement, 'IFCLOCALPLACEMENT', 'PlacementRelTo');
    if (typeof parent === 'number') append(children, parent, placement);
  }
  const products = new Map<number, number[]>();
  // Only effective type buckets whose EXPRESS layout has ObjectPlacement.
  for (const [type, ids] of index.byType) {
    if (!getAttributeNamesForSchema(type, schema).includes('ObjectPlacement')) continue;
    for (const id of ids) {
      const placement = ref(id, type, 'ObjectPlacement');
      if (typeof placement === 'number') append(products, placement, id);
    }
  }
  const queue = [...gridIds], visited = new Set(gridIds);
  const enqueue = (id: number) => { if (!visited.has(id)) { visited.add(id); queue.push(id); } };
  // The frontier is globally visited and iterative. Nested bound grids and
  // cyclic/multiply-shared local chains cannot recurse or amplify the walk.
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor];
    if (index.typeOf(id) === 'IFCGRID') {
      for (const placement of bindings.get(id) ?? []) enqueue(placement);
    } else {
      for (const child of children.get(id) ?? []) enqueue(child);
      for (const product of products.get(id) ?? []) {
        out.add(product);
        if (index.typeOf(product) === 'IFCGRID') enqueue(product);
      }
    }
  }
  return out;
}
