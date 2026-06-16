/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { IfcTypeEnum } from '@ifc-lite/data';
import { StepTokenizer } from '../src/tokenizer.js';
import {
  ColumnarParser,
  extractRelationshipsOnDemand,
  extractGroupMembersOnDemand,
} from '../src/columnar-parser.js';

// Issue #1075 follow-up: IfcGroup-family entities (IfcZone / IfcSystem /
// IfcDistributionSystem) were categorised CAT_SKIP and never entered the
// EntityTable, so their Name was unresolvable ("Group #<id>") and they were
// invisible to getByType (lists/lens). IfcSpatialZone was in the table but its
// Name was never extracted. This locks in the fix.
//
// Neutral synthetic fixture (no real-world identifiers):
// - 2 IfcSpace (named)
// - 1 IfcSpatialZone (named + LongName)
// - 2 IfcZone (one with LongName, one without)
// - 1 IfcSystem (named + ObjectType)
// - 1 IfcDistributionSystem (empty Name, LongName + ObjectType — the "system
//   type" the reporter wants surfaced)
// - IfcRelAssignsToGroup linking spaces into multiple zones/systems.
const IFC = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCSPACE('space-1',#1,'Office 101',$,$,$,$,$,$,$);
#11=IFCSPACE('space-2',#1,'Office 102',$,$,$,$,$,$,$);
#12=IFCSPATIALZONE('szone-1',#1,'Thermal Zone A',$,$,$,$,'Thermal Zone A (HVAC)',$,$);
#20=IFCZONE('zone-1',#1,'Dwelling A',$,$,'Dwelling A — long');
#21=IFCZONE('zone-2',#1,'Dwelling B',$,$,$);
#30=IFCSYSTEM('sys-1',#1,'Electrical',$,'ELEC');
#31=IFCDISTRIBUTIONSYSTEM('dsys-1',#1,$,$,'AHU-01','AHU-01 Air supply',.VENTILATION.);
#40=IFCRELASSIGNSTOGROUP('rel-1',#1,$,$,(#10,#11),$,#20);
#41=IFCRELASSIGNSTOGROUP('rel-2',#1,$,$,(#10),$,#21);
#42=IFCRELASSIGNSTOGROUP('rel-3',#1,$,$,(#10),$,#31);`;

async function parse(opts: Record<string, unknown> = {}) {
  const source = new TextEncoder().encode(IFC);
  const tokenizer = new StepTokenizer(source);
  const entityRefs = Array.from(tokenizer.scanEntitiesFast()).map((ref) => ({
    expressId: ref.expressId,
    type: ref.type,
    byteOffset: ref.offset,
    byteLength: ref.length,
    lineNumber: ref.line,
  }));
  const parser = new ColumnarParser();
  return parser.parseLite(source.buffer.slice(0), entityRefs, opts);
}

describe('issue #1075 — group / zone / system naming + listability', () => {
  it('puts IfcZone / IfcSystem / IfcDistributionSystem into the EntityTable with names', async () => {
    const store = await parse();

    // Names resolve (previously '' → "Group #<id>")
    expect(store.entities.getName(20)).toBe('Dwelling A');
    expect(store.entities.getName(21)).toBe('Dwelling B');
    expect(store.entities.getName(30)).toBe('Electrical');

    // Canonical type round-trips (was 'Unknown' when absent from the table)
    expect(store.entities.getTypeName(20)).toBe('IfcZone');
    expect(store.entities.getTypeName(30)).toBe('IfcSystem');
    expect(store.entities.getTypeName(31)).toBe('IfcDistributionSystem');
  });

  it('falls back to LongName for a system with an empty Name and exposes ObjectType', async () => {
    const store = await parse();
    // Name is empty on #31; the human label lives in LongName.
    expect(store.entities.getName(31)).toBe('AHU-01 Air supply');
    // ObjectType (the "system type" designation) is preserved.
    expect(store.entities.getObjectType(31)).toBe('AHU-01');
    expect(store.entities.getObjectType(30)).toBe('ELEC');
  });

  it('makes groups discoverable via getByType (lists/lens)', async () => {
    const store = await parse();
    expect(store.entities.getByType(IfcTypeEnum.IfcZone).sort()).toEqual([20, 21]);
    expect(store.entities.getByType(IfcTypeEnum.IfcSystem)).toEqual([30]);
    expect(store.entities.getByType(IfcTypeEnum.IfcDistributionSystem)).toEqual([31]);
  });

  it('extracts the Name for IfcSpatialZone (a relevant product, not a group)', async () => {
    const store = await parse();
    expect(store.entities.getByType(IfcTypeEnum.IfcSpatialZone)).toEqual([12]);
    expect(store.entities.getName(12)).toBe('Thermal Zone A');
  });

  it('returns all named group memberships for a multi-zone element', async () => {
    const store = await parse();
    // #10 is in zone-1 (#20), zone-2 (#21) and dist-system (#31).
    const rels = extractRelationshipsOnDemand(store, 10);
    const byId = new Map(rels.groups.map((g) => [g.id, g]));
    expect(byId.size).toBe(3);
    expect(byId.get(20)).toMatchObject({ name: 'Dwelling A', type: 'IfcZone' });
    expect(byId.get(21)).toMatchObject({ name: 'Dwelling B', type: 'IfcZone' });
    expect(byId.get(31)).toMatchObject({ name: 'AHU-01 Air supply', type: 'IfcDistributionSystem' });
  });

  it('enumerates a group\'s member objects with names', async () => {
    const store = await parse();
    const members = extractGroupMembersOnDemand(store, 20).sort((a, b) => a.id - b.id);
    expect(members.map((m) => m.id)).toEqual([10, 11]);
    expect(members.map((m) => m.name)).toEqual(['Office 101', 'Office 102']);
    expect(members.every((m) => m.type === 'IfcSpace')).toBe(true);
  });

  it('keeps group names + listability when property atoms are deferred (huge-file path)', async () => {
    const store = await parse({ deferPropertyAtomIndex: true });
    expect(store.entities.getName(20)).toBe('Dwelling A');
    expect(store.entities.getName(31)).toBe('AHU-01 Air supply');
    expect(store.entities.getByType(IfcTypeEnum.IfcZone).sort()).toEqual([20, 21]);
  });
});
