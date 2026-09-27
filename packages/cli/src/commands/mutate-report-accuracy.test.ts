/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `mutate --json` is read by CI, not by a person, so a mutation it says
 * happened has to have happened.
 *
 * `applyAttributeMutations` skips an attribute the entity has no slot for and
 * warns on stderr -- but it returned only the rewritten text, so `mutate.ts`
 * could not see the skip. It incremented `mutatedCount` once per target
 * unconditionally and published that, giving `mutated: 1, warnings: []` for a
 * record it had not touched (#5529). The human path was fine; only the machine
 * one lied, which is the worse half.
 *
 * Both directions are pinned here. A fix that simply stopped counting would
 * satisfy the negative case and break every real mutation.
 */

import { describe, it, expect } from 'vitest';
import { applyAttributeMutations } from './mutate-step-record.js';

/** `entity` only needs the shape `applyAttributeMutations` reads off it. */
function target(expressId: number) {
  return { ref: { expressId } };
}

/**
 * A wall, which has a Name slot, and a derived-unit element, which does not --
 * the exact pair from the issue. Inline rather than a fixture: the defect needs
 * one entity without the requested attribute, and a downloaded fixture would
 * let this skip where `pnpm fixtures` never ran.
 */
const CONTENT = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#41=IFCWALLSTANDARDCASE('0000000000000000000041',$,'Original',$,$,$,$,$,$);
#42=IFCDERIVEDUNITELEMENT(#41,-1);
ENDSEC;
END-ISO-10303-21;
`;

/** `IfcDerivedUnitElement` is not an entity that carries ObjectType. */
const OBJECT_TYPE_ENTITIES: ReadonlySet<string> = new Set(['IFCWALLSTANDARDCASE']);

describe('an attribute the entity cannot hold is reported, not counted', () => {
  it('reports the skip and writes nothing for it', () => {
    const result = applyAttributeMutations(
      CONTENT,
      [{ entity: target(42), propName: 'Name', value: 'TestWall' }],
      OBJECT_TYPE_ENTITIES,
    );

    expect(result.applied).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({
      expressId: 42,
      property: 'Name',
      reason: 'unknown-attribute',
    });
    // And the record really is untouched.
    expect(result.content).toContain('#42=IFCDERIVEDUNITELEMENT(#41,-1);');
  });

  it('reports ObjectType refused on a type that does not carry it', () => {
    const result = applyAttributeMutations(
      CONTENT,
      [{ entity: target(42), propName: 'ObjectType', value: 'Nope' }],
      OBJECT_TYPE_ENTITIES,
    );

    expect(result.applied).toBe(0);
    expect(result.skipped.map((s) => s.reason)).toEqual(['unknown-attribute']);
  });
});

describe('a mutation that does happen is still counted', () => {
  it('rewrites the attribute and reports it applied', () => {
    const result = applyAttributeMutations(
      CONTENT,
      [{ entity: target(41), propName: 'Name', value: 'Renamed' }],
      OBJECT_TYPE_ENTITIES,
    );

    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(result.content).toContain("'Renamed'");
    expect(result.content).not.toContain("'Original'");
  });

  it('separates the applied from the skipped in one run', () => {
    const result = applyAttributeMutations(
      CONTENT,
      [
        { entity: target(41), propName: 'Name', value: 'Renamed' },
        { entity: target(42), propName: 'Name', value: 'TestWall' },
      ],
      OBJECT_TYPE_ENTITIES,
    );

    expect(result.applied).toBe(1);
    expect(result.skipped.map((s) => s.expressId)).toEqual([42]);
  });
});
