/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `GROUP_ENTITY_TYPES` is the Groups tab's enumeration of the IfcGroup family.
 * The tab reads `entityIndex.byType.get(name)` once per listed name, and
 * `byType` is keyed by the RAW STEP type name — so a concrete IfcGroup
 * descendant missing from the list contributes ZERO rows, silently, however
 * many the file holds. That is the #3229 / #3232 defect shape.
 *
 * The list must therefore be the schema's answer, not a hand-copy, and it has
 * to span EVERY bundled schema: `IfcElectricalCircuit` and `IfcCondition`
 * exist only in IFC2X3, `IfcBuiltSystem` only in IFC4X3. Derive the expectation
 * from `@ifc-lite/data`'s generated entity tables and check BOTH directions —
 * nothing schema-concrete may be missing, and nothing listed may be absent
 * from every schema (a typo would otherwise sit there forever, matching
 * nothing).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3 } from '@ifc-lite/data';
import type { IfcEntityInfo } from '@ifc-lite/data';
import { GROUP_ENTITY_TYPES, groupMatchesSubFilter } from './treeDataBuilder.js';

const SCHEMAS: ReadonlyArray<readonly [string, readonly IfcEntityInfo[]]> = [
  ['IFC2X3', ENTITIES_IFC2X3],
  ['IFC4', ENTITIES_IFC4],
  ['IFC4X3', ENTITIES_IFC4X3],
];

/** Concrete entities whose parent chain reaches `root`, plus `root` itself. */
function concreteFamily(entities: readonly IfcEntityInfo[], root: string): Set<string> {
  const byName = new Map(entities.map((e) => [e.name, e]));
  const out = new Set<string>();
  for (const entity of entities) {
    if (entity.abstract) continue;
    let cursor: IfcEntityInfo | undefined = entity;
    for (let hops = 0; cursor && hops <= 64; hops++) {
      if (cursor.name === root) {
        out.add(entity.name);
        break;
      }
      cursor = cursor.parent ? byName.get(cursor.parent) : undefined;
    }
  }
  return out;
}

describe('GROUP_ENTITY_TYPES covers the whole IfcGroup family', () => {
  // Anti-vacuity: the derivation must actually find a family, and it must find
  // the schema-specific members that make this test worth having. If the
  // generated tables ever change shape, `concreteFamily` would quietly return
  // an empty set and every subset assertion below would pass over nothing.
  it('the derivation is non-vacuous and schema-specific', () => {
    for (const [label, entities] of SCHEMAS) {
      const family = concreteFamily(entities, 'IfcGroup');
      assert.ok(family.size >= 8, `${label}: derived only ${family.size} IfcGroup descendants`);
      assert.ok(family.has('IfcGroup'), `${label}: IfcGroup itself must be in its own family`);
      assert.ok(family.has('IfcZone'), `${label}: IfcZone must be an IfcGroup descendant`);
    }
    const legacy = concreteFamily(ENTITIES_IFC2X3, 'IfcGroup');
    assert.ok(legacy.has('IfcElectricalCircuit'), 'IFC2X3 must carry IfcElectricalCircuit');
    assert.ok(legacy.has('IfcCondition'), 'IFC2X3 must carry IfcCondition');
    assert.ok(
      !concreteFamily(ENTITIES_IFC4, 'IfcGroup').has('IfcElectricalCircuit'),
      'IfcElectricalCircuit is IFC2X3-only — if IFC4 gained it, this test is testing the wrong thing',
    );
    assert.ok(
      concreteFamily(ENTITIES_IFC4X3, 'IfcGroup').has('IfcBuiltSystem'),
      'IFC4X3 must carry IfcBuiltSystem',
    );
  });

  // Direction 1: nothing concrete in any bundled schema may be missing.
  it('lists every concrete IfcGroup descendant of every bundled schema', () => {
    const listed = new Set<string>(GROUP_ENTITY_TYPES);
    const missing: string[] = [];
    for (const [label, entities] of SCHEMAS) {
      for (const name of concreteFamily(entities, 'IfcGroup')) {
        if (!listed.has(name)) missing.push(`${label}:${name}`);
      }
    }
    assert.deepEqual(missing, [], `GROUP_ENTITY_TYPES misses concrete IfcGroup classes: ${missing.join(', ')}`);
  });

  // Direction 2: nothing listed may be a name no schema has.
  it('lists no class that no bundled schema defines', () => {
    const known = new Set<string>();
    for (const [, entities] of SCHEMAS) {
      for (const name of concreteFamily(entities, 'IfcGroup')) known.add(name);
    }
    const unknown = GROUP_ENTITY_TYPES.filter((name) => !known.has(name));
    assert.deepEqual([...unknown], [], `GROUP_ENTITY_TYPES lists unknown classes: ${unknown.join(', ')}`);
  });

  // Every listed class must land in exactly one sub-filter bucket, or a group
  // visible under "All" vanishes when the user picks a chip.
  it('routes every listed class into exactly one sub-filter chip', () => {
    for (const name of GROUP_ENTITY_TYPES) {
      const hits = (['systems', 'zones', 'other'] as const).filter((f) => groupMatchesSubFilter(name, f));
      assert.deepEqual(hits.length, 1, `${name} matched ${hits.length} chips (${hits.join(', ')})`);
    }
  });

  // The IFC2X3 spelling of a distribution circuit belongs with the systems,
  // beside the IFC4 IfcDistributionCircuit it was renamed to.
  it('buckets IfcElectricalCircuit with the systems, like IfcDistributionCircuit', () => {
    assert.ok(groupMatchesSubFilter('IfcElectricalCircuit', 'systems'));
    assert.ok(groupMatchesSubFilter('IfcDistributionCircuit', 'systems'));
  });
});
