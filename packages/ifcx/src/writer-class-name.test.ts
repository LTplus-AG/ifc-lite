/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IFC class an IFCX export writes for each entity.
 *
 * `bsi::ifc::class` is the node's IFC identity in the exported file: every
 * consumer that reads an .ifcx back — this package's own reader, the viewer's
 * hierarchy and every other IFC5 tool — takes the class from that attribute
 * and from nowhere else. So a wrong code here is not a display glitch, it is a
 * wrong value written into a file that outlives the session.
 *
 * The writer used to map the entity's `typeEnum` to a class name through a
 * 26-row table written out by hand. `IfcTypeEnum` has 128 members, so the
 * table could only ever answer for a fraction of them — and because the enum's
 * numbering had moved on since the table was typed, the rows it *did* have
 * were shifted against it: enum 17 is `IfcStair`, the table said `IfcRoof`.
 * Every stair in an exported model came back a roof.
 *
 * These tests derive the expectation from the entity table itself
 * (`EntityTable.getTypeName`, which resolves overrides, then the enum, then
 * the raw parsed class name) rather than restating a list, so a class added to
 * the schema is covered the day the enum learns it. The sweep is the real
 * guard; the named cases below it exist so a regression names the entity it
 * broke instead of a count.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { StringTable, EntityTableBuilder, IfcTypeEnum, IfcTypeEnumToString } from '@ifc-lite/data';
import type { EntityTable } from '@ifc-lite/data';
import { exportToIfcx } from './writer.js';
import type { IfcxFile, IfcxNode } from './types.js';

/**
 * Every concrete `IfcTypeEnum` member, by name. `Unknown` is the enum's own
 * "no member holds this id" sentinel and is not an IFC class, so it is
 * excluded here and exercised by the negative control instead.
 */
function enumMemberNames(): string[] {
  return Object.entries(IfcTypeEnum)
    .filter(([name, value]) => typeof value === 'number' && name !== 'Unknown')
    .map(([name]) => name);
}

function exportClasses(classNames: string[]): Map<string, string | undefined> {
  const strings = new StringTable();
  const builder = new EntityTableBuilder(Math.max(classNames.length, 1), strings);
  classNames.forEach((className, i) => {
    builder.add(i + 1, className.toUpperCase(), `GID-${i + 1}`, `n${i + 1}`, '', '', false, false);
  });
  const entities = builder.build();

  const file = JSON.parse(
    exportToIfcx({ entities, strings }, { includeProperties: false }),
  ) as IfcxFile;

  const byPath = new Map<string, string | undefined>();
  for (const node of file.data as IfcxNode[]) {
    const cls = (node.attributes as Record<string, { code?: string }> | undefined)?.[
      'bsi::ifc::class'
    ];
    byPath.set(node.path, cls?.code);
  }
  return byPath;
}

describe('IFCX export writes each entity its own IFC class', () => {
  it('agrees with the entity table for every IfcTypeEnum member', () => {
    const names = enumMemberNames();
    // Anti-vacuity: an empty or truncated member list would make the sweep
    // below pass without comparing anything.
    assert.ok(
      names.length >= 100,
      `expected IfcTypeEnum to carry the full IFC class vocabulary, got ${names.length} members`,
    );

    const byPath = exportClasses(names);
    assert.strictEqual(
      byPath.size,
      names.length,
      `expected one exported node per class, got ${byPath.size} for ${names.length} classes`,
    );

    const wrong: string[] = [];
    names.forEach((expected, i) => {
      const actual = byPath.get(`GID-${i + 1}`);
      if (actual !== expected) wrong.push(`${expected} -> ${actual ?? '(no class written)'}`);
    });
    assert.deepStrictEqual(wrong, []);
  });

  it('writes the class the hand table got wrong or never had', () => {
    // Named, not counted: a floor on the sweep above would survive dropping
    // any one of these. Each was observed misexported before the fix — the
    // first group as a DIFFERENT class, the second with no class at all.
    const required = [
      'IfcStair',
      'IfcRamp',
      'IfcRoof',
      'IfcCovering',
      'IfcCurtainWall',
      'IfcRailing',
      'IfcPile',
      'IfcMember',
      'IfcPlate',
      'IfcOpeningElement',
      'IfcDistributionElement',
      'IfcFlowSegment',
      'IfcPipeSegment',
      'IfcDuctSegment',
      'IfcFurniture',
      'IfcRoad',
      'IfcBridge',
      'IfcFacilityPart',
      'IfcSpatialZone',
      'IfcStairFlight',
    ];
    const byPath = exportClasses(required);
    required.forEach((expected, i) => {
      assert.strictEqual(
        byPath.get(`GID-${i + 1}`),
        expected,
        `${expected} was exported as ${byPath.get(`GID-${i + 1}`) ?? '(no class written)'}`,
      );
    });
  });

  it('keeps a class the enum does not carry, from the parsed type name', () => {
    // IfcAirTerminal has no IfcTypeEnum member; the entity table still knows
    // its parsed class, and the export must not drop it.
    assert.strictEqual(
      IfcTypeEnumToString(IfcTypeEnum.Unknown),
      'Unknown',
      'IfcTypeEnum.Unknown must stay the enum sentinel for this test to mean anything',
    );
    const byPath = exportClasses(['IfcAirTerminal']);
    assert.strictEqual(byPath.get('GID-1'), 'IfcAirTerminal');
  });

  it('writes no class, and no invented one, when the entity has none', () => {
    // Negative control. An entity table row whose type resolves to nothing at
    // all must leave `bsi::ifc::class` off the node rather than emit
    // `Unknown` (not an IFC class) or fall through to some neighbouring code.
    const entities = {
      count: 1,
      expressId: Uint32Array.from([1]),
      typeEnum: Uint16Array.from([IfcTypeEnum.Unknown % 65536]),
      globalId: Uint32Array.from([1]),
      name: Uint32Array.from([0]),
      description: Uint32Array.from([0]),
      getTypeName: () => 'Unknown',
    } as unknown as EntityTable;
    const strings = { get: (idx: number) => (idx === 1 ? 'GID-1' : '') };

    const file = JSON.parse(
      exportToIfcx({ entities, strings }, { includeProperties: false }),
    ) as IfcxFile;
    const node = (file.data as IfcxNode[]).find((n) => n.path === 'GID-1');
    assert.ok(node, 'expected the entity to be exported');
    assert.strictEqual(
      (node.attributes as Record<string, unknown> | undefined)?.['bsi::ifc::class'],
      undefined,
    );
  });

  it('names the synthesized path of a GlobalId-less entity after its real class', () => {
    // `generatePath` shares the same class lookup, so the shifted table
    // mislabelled the fallback path too: a stair became `ifc:IfcRoof.7`.
    const strings = new StringTable();
    const builder = new EntityTableBuilder(1, strings);
    builder.add(7, 'IFCSTAIR', '', 'stair-with-no-guid', '', '', false, false);
    const entities = builder.build();

    const file = JSON.parse(
      exportToIfcx({ entities, strings }, { includeProperties: false }),
    ) as IfcxFile;
    const paths = (file.data as IfcxNode[]).map((n) => n.path);
    assert.ok(
      paths.includes('ifc:IfcStair.7'),
      `expected ifc:IfcStair.7 among ${JSON.stringify(paths)}`,
    );
  });
});
