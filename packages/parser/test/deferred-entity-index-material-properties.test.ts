/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coverage for the `deferredEntityIndex` fallback in `refFromStore()`
 * (on-demand-extractors.ts): `store.entityIndex.byId.get(id) ??
 * store.deferredEntityIndex?.get(id)`.
 *
 * On large files parsed with `deferPropertyAtomIndex: true`, property atoms
 * (IfcPropertySingleValue, etc.) are indexed separately into
 * `deferredEntityIndex` and are deliberately absent from the primary
 * `entityIndex.byId`. Material-property-set resolution
 * (`getMaterialPropertyIndex` in on-demand-extractors.ts) walks
 * *MaterialProperties entities and their referenced IfcProperty atoms through
 * `refFromStore()`, so it must fall back to the deferred index or every
 * property on a deferred-index model silently resolves to nothing.
 *
 * No existing test builds a store with a populated `deferredEntityIndex`
 * (`grep -rl deferredEntityIndex test/` returns nothing before this file),
 * so dropping the `?? store.deferredEntityIndex?.get(id)` fallback survives
 * the full suite.
 */

import { describe, it, expect } from 'vitest';
import { extractMaterialPropertiesForMaterialId } from '../src/columnar-parser.js';
import type { IfcDataStore } from '../src/columnar-parser.js';
import type { EntityRef } from '../src/types.js';

// #20 (the property atom) is deliberately built into `deferredEntityIndex`
// ONLY — never `entityIndex.byId` — to model the deferred-atom-index shape
// that a real large-file parse with `deferPropertyAtomIndex: true` produces.
const FIXTURE = [
  `#10=IFCMATERIAL('Concrete',$,'concrete');`,
  `#20=IFCPROPERTYSINGLEVALUE('Strength',$,30.0,$);`,
  `#30=IFCMATERIALPROPERTIES('Pset_MaterialConcrete',$,(#20),#10);`,
];

/** Build a minimal store where one referenced entity (the property atom)
 *  lives ONLY in `deferredEntityIndex`, not the primary `entityIndex.byId`. */
function buildDeferredAtomStore(): IfcDataStore {
  const text = FIXTURE.join('\n');
  const source = new TextEncoder().encode(text);

  const byId = new Map<number, EntityRef>();
  const deferredById = new Map<number, EntityRef>();
  const byType = new Map<string, number[]>();

  let cursor = 0;
  for (const line of FIXTURE) {
    const start = text.indexOf(line, cursor);
    const match = line.match(/^#(\d+)\s*=\s*(\w+)\(/);
    if (match) {
      const expressId = parseInt(match[1], 10);
      const type = match[2];
      const ref: EntityRef = {
        expressId,
        type,
        byteOffset: start,
        byteLength: line.length,
        lineNumber: 1,
      };
      // #20 is the deferred property atom: index it into deferredById only.
      if (expressId === 20) {
        deferredById.set(expressId, ref);
      } else {
        byId.set(expressId, ref);
      }
      const typeUpper = type.toUpperCase();
      let list = byType.get(typeUpper);
      if (!list) { list = []; byType.set(typeUpper, list); }
      list.push(expressId);
    }
    cursor = start + line.length;
  }

  return {
    source,
    entityIndex: { byId, byType },
    deferredEntityIndex: deferredById,
  } as unknown as IfcDataStore;
}

describe('refFromStore deferredEntityIndex fallback (material property atoms)', () => {
  it('resolves a material pset whose property atom lives only in deferredEntityIndex', () => {
    const store = buildDeferredAtomStore();

    // Sanity: the property atom is genuinely absent from the primary index —
    // otherwise this test would pass without ever exercising the fallback.
    expect(store.entityIndex.byId.has(20)).toBe(false);
    expect(store.deferredEntityIndex!.has(20)).toBe(true);

    const groups = extractMaterialPropertiesForMaterialId(store, 10);

    expect(groups).toHaveLength(1);
    expect(groups[0].materialId).toBe(10);
    expect(groups[0].psets).toHaveLength(1);
    expect(groups[0].psets[0].name).toBe('Pset_MaterialConcrete');
    expect(groups[0].psets[0].properties).toHaveLength(1);
    expect(groups[0].psets[0].properties[0].name).toBe('Strength');
    expect(groups[0].psets[0].properties[0].value).toBe(30.0);
  });
});
