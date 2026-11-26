/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #11577: the generic writers (`addElement`, `addAxisElement`) wrote every
 * type in a fixed 7-attribute list (IfcSpace lost LongName, CompositionType,
 * PredefinedType and ElevationWithFlooring), contained groups and spatial
 * elements in the storey, and kept the caller's keyword casing.
 */

import { describe, it, expect } from 'vitest';
import { getSchemaRegistryForVersion } from '@ifc-lite/parser';
import { IfcCreator } from './ifc-creator.js';

type Schema = 'IFC2X3' | 'IFC4' | 'IFC4X3';
const profile = { ProfileType: 'AREA' as const, XDim: 2, YDim: 2 };

/** Top-level argument count of a STEP record's attribute list. */
function argCount(record: string): number {
  const body = record.slice(record.indexOf('(') + 1, record.lastIndexOf(')'));
  let depth = 0, quoted = false, count = 1;
  for (const ch of body) {
    if (ch === "'") quoted = !quoted;
    else if (!quoted && ch === '(') depth++;
    else if (!quoted && ch === ')') depth--;
    else if (!quoted && depth === 0 && ch === ',') count++;
  }
  return count;
}

function record(content: string, id: number): string {
  const line = content.split('\n').find((l) => l.startsWith(`#${id}=`));
  if (!line) throw new Error(`no #${id} in output`);
  return line;
}

describe.each(['IFC2X3', 'IFC4', 'IFC4X3'] as Schema[])('generic product writers (%s) (#11577)', (schema) => {
  const registry = getSchemaRegistryForVersion(schema);
  const fullCount = (entity: string) => registry.entities[entity].allAttributes!.length;

  it('writes a generic IfcSpace with its full attribute list and an upper-case keyword', () => {
    const c = new IfcCreator({ Name: 'T', Schema: schema });
    const storey = c.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    const viaElement = c.addElement(storey, { IfcType: 'IfcSpace', Placement: { Location: [0, 0, 0] }, Profile: profile, Depth: 3 });
    const viaAxis = c.addAxisElement(storey, { IfcType: 'IfcSpace', Start: [0, 0, 0], End: [0, 0, 3], Profile: profile });
    const { content } = c.toIfc();
    for (const id of [viaElement, viaAxis]) {
      const line = record(content, id);
      expect(line.startsWith(`#${id}=IFCSPACE(`)).toBe(true);
      expect(argCount(line)).toBe(fullCount('IfcSpace'));
      expect(line).toContain('.ELEMENT.');
    }
  });

  it('keeps the Tag slot of an element and upper-cases its keyword', () => {
    const c = new IfcCreator({ Name: 'T', Schema: schema });
    const storey = c.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    const id = c.addElement(storey, { IfcType: 'IfcBuildingElementProxy', Tag: 'P-1', Placement: { Location: [0, 0, 0] }, Profile: profile, Depth: 1 });
    const line = record(c.toIfc().content, id);
    expect(line.startsWith(`#${id}=IFCBUILDINGELEMENTPROXY(`)).toBe(true);
    expect(argCount(line)).toBe(fullCount('IfcBuildingElementProxy'));
    expect(line).toContain(",'P-1'");
  });

  it.each(['IfcZone', 'IfcSystem', 'IfcGroup'])('refuses %s, which is not a product', (type) => {
    const c = new IfcCreator({ Name: 'T', Schema: schema });
    const storey = c.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    expect(() => c.addElement(storey, { IfcType: type, Placement: { Location: [0, 0, 0] }, Profile: profile, Depth: 1 }))
      .toThrow(/not a product/);
    expect(() => c.addAxisElement(storey, { IfcType: type, Start: [0, 0, 0], End: [0, 0, 1], Profile: profile }))
      .toThrow(/not a product/);
  });

  it.each(['IfcSite', 'IfcBuilding', 'IfcBuildingStorey'])('refuses %s, a spatial element, under a storey', (type) => {
    const c = new IfcCreator({ Name: 'T', Schema: schema });
    const storey = c.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    expect(() => c.addElement(storey, { IfcType: type, Placement: { Location: [0, 0, 0] }, Profile: profile, Depth: 1 }))
      .toThrow(/spatial element/);
    expect(() => c.addAxisElement(storey, { IfcType: type, Start: [0, 0, 0], End: [0, 0, 1], Profile: profile }))
      .toThrow(/spatial element/);
  });

  it('a refused type leaves no orphan records behind', () => {
    const records = (refuse: boolean) => {
      const c = new IfcCreator({ Name: 'T', Schema: schema });
      const storey = c.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
      if (refuse) {
        expect(() => c.addElement(storey, { IfcType: 'IfcZone', Placement: { Location: [0, 0, 0] }, Profile: profile, Depth: 1 })).toThrow();
        expect(() => c.addAxisElement(storey, { IfcType: 'IfcSite', Start: [0, 0, 0], End: [0, 0, 1], Profile: profile })).toThrow();
      }
      return c.toIfc().content.split('\n').filter((line) => line.startsWith('#')).length;
    };
    expect(records(true)).toBe(records(false));
  });

  it('refuses an abstract product', () => {
    const c = new IfcCreator({ Name: 'T', Schema: schema });
    const storey = c.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    expect(() => c.addElement(storey, { IfcType: 'IfcElement', Placement: { Location: [0, 0, 0] }, Profile: profile, Depth: 1 }))
      .toThrow(/abstract/);
  });
});

it('refuses an IFC4X3 IfcFacilityPart under a storey (#11577)', () => {
  const c = new IfcCreator({ Name: 'T', Schema: 'IFC4X3' });
  const storey = c.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
  expect(() => c.addElement(storey, { IfcType: 'IfcFacilityPart', Placement: { Location: [0, 0, 0] }, Profile: profile, Depth: 1 }))
    .toThrow(/spatial element/);
  expect(() => c.addAxisElement(storey, { IfcType: 'IfcFacilityPart', Start: [0, 0, 0], End: [0, 0, 1], Profile: profile }))
    .toThrow(/spatial element/);
});
