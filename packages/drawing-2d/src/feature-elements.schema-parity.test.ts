/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema-parity guard for `FEATURE_ELEMENT_TYPES` (issue #979).
 *
 * `feature-elements.ts` hand-maintains its type set rather than importing
 * `@ifc-lite/data` at runtime (drawing-2d does not otherwise depend on it —
 * see the "schema-derived" note in that file). That leaves the same drift
 * risk `ifc-type-hierarchy.test.ts` was written to close for the
 * graphic-override subtype table: the IFC2X3 edge-feature family
 * (`IfcEdgeFeature`, `IfcChamferEdgeFeature`, `IfcRoundedEdgeFeature`) was
 * missing from this set for exactly that reason, and nothing compared it to
 * a schema.
 *
 * This test re-derives every `IfcFeatureElement` descendant from
 * `@ifc-lite/data`'s generated entity tables (IFC2X3, IFC4, IFC4X3 — an
 * authority independent of the one this set was hand-copied from) and
 * asserts the two agree in both directions, so a future schema bump or
 * hand-edit cannot quietly reopen the gap.
 */

import { describe, it, expect } from 'vitest';
import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3 } from '@ifc-lite/data';
import type { IfcEntityInfo } from '@ifc-lite/data';
import { isFeatureElementType } from './feature-elements.js';

const ROOT = 'IfcFeatureElement';

/** Every `IfcFeatureElement` descendant (plus the root itself) in one schema. */
function featureElementUniverse(entities: readonly IfcEntityInfo[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const entity of entities) {
    if (!entity.parent) continue;
    const siblings = children.get(entity.parent) ?? [];
    siblings.push(entity.name);
    children.set(entity.parent, siblings);
  }
  const out = new Set<string>([ROOT]);
  const walk = (node: string): void => {
    for (const child of children.get(node) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      walk(child);
    }
  };
  walk(ROOT);
  return out;
}

const SCHEMAS: ReadonlyArray<readonly [name: string, entities: readonly IfcEntityInfo[]]> = [
  ['IFC2X3', ENTITIES_IFC2X3],
  ['IFC4', ENTITIES_IFC4],
  ['IFC4X3', ENTITIES_IFC4X3],
];

describe('FEATURE_ELEMENT_TYPES vs generated IFC schemas', () => {
  for (const [schemaName, entities] of SCHEMAS) {
    const universe = featureElementUniverse(entities);

    it(`derives a non-trivial IfcFeatureElement universe from ${schemaName} (anti-vacuity)`, () => {
      // If the parent walk broke or ENTITIES_* failed to load, `universe`
      // would collapse to just the root and every assertion below would
      // pass vacuously.
      expect(universe.size).toBeGreaterThan(1);
    });

    it(`isFeatureElementType flags every ${schemaName} IfcFeatureElement descendant`, () => {
      const missing = [...universe].filter((name) => !isFeatureElementType(name));
      expect(missing).toEqual([]);
    });
  }

  it('does not flag any real IfcElement outside the IfcFeatureElement family (IFC4)', () => {
    const universe = featureElementUniverse(ENTITIES_IFC4);
    const falsePositives = ENTITIES_IFC4.filter(
      (e) => !e.abstract && !universe.has(e.name) && isFeatureElementType(e.name),
    ).map((e) => e.name);
    expect(falsePositives).toEqual([]);
  });
});
