/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #7401: a partOf facet without a `relation` attribute. IDS 1.0's
 * `ids.xsd` makes the attribute optional, and the user manual
 * (`Documentation/UserManual/partof-facet.md`) says that with no relation
 * every part-of relation is considered, recursively. Its own example table
 * lists "any entity that is directly or indirectly part of a curtain wall"
 * as `Entity="IFCCURTAINWALL"` with no relation, which is what this pins.
 *
 * The parser used to fill a missing relation with
 * IfcRelContainedInSpatialStructure, so the validator only followed
 * containment and the audit checked the entity against containment's
 * owner (IfcSpatialElement), rejecting the manual's example.
 *
 * All 34 partOf cases in the buildingSMART corpus state a relation, so the
 * corpus cannot catch this.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { createDataAccessor } from '../bridge/data-accessor.js';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from '../validation/validator.js';
import { auditIDSDocument } from '../audit/index.js';
import { checkPartOfFacet } from './partof-facet.js';
import type { IFCDataAccessor, IDSPartOfFacet, ParentInfo, PartOfRelation } from '../types.js';

const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('partof.ifc','2026-10-10T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,(#4),#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCUNITASSIGNMENT((#2));
#4=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#6,$);
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCAXIS2PLACEMENT3D(#5,$,$);
#7=IFCSITE('0000000000000000000007',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#8=IFCBUILDING('0000000000000000000008',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#9=IFCBUILDINGSTOREY('0000000000000000000009',$,'Storey',$,$,$,$,$,.ELEMENT.,0.);
#10=IFCRELAGGREGATES('0000000000000000000010',$,$,$,#1,(#7));
#11=IFCRELAGGREGATES('0000000000000000000011',$,$,$,#7,(#8));
#12=IFCRELAGGREGATES('0000000000000000000012',$,$,$,#8,(#9));
#20=IFCCURTAINWALL('0000000000000000000020',$,'CW-1',$,$,$,$,$,$);
#21=IFCMEMBER('0000000000000000000021',$,'Mullion',$,$,$,$,$,.MULLION.);
#22=IFCRELAGGREGATES('0000000000000000000022',$,$,$,#20,(#21));
#23=IFCMEMBER('0000000000000000000023',$,'Loose',$,$,$,$,$,.MULLION.);
#30=IFCWALL('0000000000000000000030',$,'Host',$,$,$,$,$,$);
#31=IFCOPENINGELEMENT('0000000000000000000031',$,'Opening',$,$,$,$,$,$);
#32=IFCWINDOW('0000000000000000000032',$,'Window',$,$,$,$,$,$,$,$,$,$);
#33=IFCRELVOIDSELEMENT('0000000000000000000033',$,$,$,#30,#31);
#34=IFCRELFILLSELEMENT('0000000000000000000034',$,$,$,#31,#32);
#99=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000099',$,$,$,(#20),#9);
ENDSEC;
END-ISO-10303-21;
`;

function spec(name: string, partOf: string, applicability = 'IFCMEMBER'): string {
  return `<specification name="${name}" ifcVersion="IFC4">
      <applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>${applicability}</simpleValue></name></entity></applicability>
      <requirements>${partOf}</requirements>
    </specification>`;
}

function ids(...specs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd">
  <info><title>partOf without a relation</title></info>
  <specifications>
    ${specs.join('\n    ')}
  </specifications>
</ids>`;
}

const partOf = (entity: string, relation?: string) =>
  `<partOf${relation ? ` relation="${relation}"` : ''}><entity><name><simpleValue>${entity}</simpleValue></name></entity></partOf>`;

async function verdicts(idsText: string): Promise<Record<string, Record<string, boolean>>> {
  const bytes = new TextEncoder().encode(IFC);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer, {
    disableWorkerScan: true,
  });
  const report = await validateIDS(
    parseIDS(idsText),
    createDataAccessor(store),
    { modelId: 'partof', schemaVersion: store.schemaVersion, entityCount: store.entityCount },
    { includePassingEntities: true },
  );
  const out: Record<string, Record<string, boolean>> = {};
  for (const r of report.specificationResults) {
    out[r.specification.name] = Object.fromEntries(
      r.entityResults.map((e) => [e.entityName ?? String(e.expressId), e.passed]),
    );
  }
  return out;
}

describe('partOf without a relation follows every part-of relation (#7401)', () => {
  it('keeps "no relation" distinct from an explicit containment relation when parsing', () => {
    const doc = parseIDS(ids(spec('none', partOf('IFCCURTAINWALL')), spec('contained', partOf('IFCBUILDINGSTOREY', 'IFCRELCONTAINEDINSPATIALSTRUCTURE'))));
    const [none, contained] = doc.specifications.map((s) => s.requirements[0].facet);
    expect(none).toMatchObject({ type: 'partOf', anyRelation: true });
    expect(contained).toMatchObject({ type: 'partOf', relation: 'IfcRelContainedInSpatialStructure' });
    expect(contained).not.toHaveProperty('anyRelation');
  });

  it("passes the manual's curtain-wall example: a mullion aggregated into a curtain wall", async () => {
    const v = await verdicts(ids(
      spec('no relation', partOf('IFCCURTAINWALL')),
      spec('aggregates', partOf('IFCCURTAINWALL', 'IFCRELAGGREGATES')),
      spec('containment', partOf('IFCCURTAINWALL', 'IFCRELCONTAINEDINSPATIALSTRUCTURE')),
    ));
    expect(v['no relation']).toEqual({ Mullion: true, Loose: false });
    expect(v['aggregates']).toEqual({ Mullion: true, Loose: false });
    // An explicit relation still follows only that relation.
    expect(v['containment']).toEqual({ Mullion: false, Loose: false });
  });

  it('follows a chain that mixes relations (aggregated into a wall contained in a storey, in a building)', async () => {
    const v = await verdicts(ids(
      spec('storey', partOf('IFCBUILDINGSTOREY')),
      spec('building', partOf('IFCBUILDING')),
      spec('storey by containment only', partOf('IFCBUILDINGSTOREY', 'IFCRELCONTAINEDINSPATIALSTRUCTURE')),
    ));
    expect(v['storey']).toEqual({ Mullion: true, Loose: false });
    expect(v['building']).toEqual({ Mullion: true, Loose: false });
    expect(v['storey by containment only']).toEqual({ Mullion: false, Loose: false });
  });

  it("does not report the manual's example as an audit error", async () => {
    const report = await auditIDSDocument(ids(spec('no relation', partOf('IFCCURTAINWALL'))));
    const partOfIssues = report.issues.filter((i) => i.code.startsWith('E_IFC_PARTOF'));
    expect(partOfIssues).toEqual([]);
  });

  it('still flags an entity that no part-of relation can relate to', async () => {
    const report = await auditIDSDocument(ids(spec('no relation', partOf('IFCPROPERTYSINGLEVALUE'))));
    expect(report.issues.map((i) => i.code)).toContain('E_IFC_PARTOF_ENTITY');
  });

  it('keeps checking an explicit relation against its own owner type', async () => {
    const report = await auditIDSDocument(ids(spec('contained', partOf('IFCCURTAINWALL', 'IFCRELCONTAINEDINSPATIALSTRUCTURE'))));
    expect(report.issues.map((i) => i.code)).toContain('E_IFC_PARTOF_ENTITY');
  });

  it('reaches the opening a window fills and the wall that opening voids', async () => {
    const v = await verdicts(ids(
      spec('opening', partOf('IFCOPENINGELEMENT'), 'IFCWINDOW'),
      spec('wall', partOf('IFCWALL'), 'IFCWINDOW'),
    ));
    expect(v['opening']).toEqual({ Window: true });
    expect(v['wall']).toEqual({ Window: true });
  });

  it('asks for the single fills and voids relations too, not only the merged opening path', () => {
    // An accessor whose merged voids/fills walk reports only the host wall
    // must still yield the opening through the direct fills link.
    const opening: ParentInfo = { expressId: 31, entityType: 'IfcOpeningElement' };
    const wall: ParentInfo = { expressId: 30, entityType: 'IfcWall' };
    const edges: Partial<Record<PartOfRelation, Record<number, ParentInfo[]>>> = {
      'IfcRelVoidsElement IfcRelFillsElement': { 32: [wall] },
      IfcRelFillsElement: { 32: [opening] },
      IfcRelVoidsElement: { 31: [wall] },
    };
    const accessor = {
      getAncestors: (id: number, relation: PartOfRelation) => edges[relation]?.[id] ?? [],
      getParent: (id: number, relation: PartOfRelation) => edges[relation]?.[id]?.[0],
    } as unknown as IFCDataAccessor;
    const facet: IDSPartOfFacet = {
      type: 'partOf',
      relation: 'IfcRelContainedInSpatialStructure',
      anyRelation: true,
      entity: { type: 'entity', name: { type: 'simpleValue', value: 'IFCOPENINGELEMENT' } },
    };
    expect(checkPartOfFacet(facet, 32, accessor).passed).toBe(true);
  });

  it('treats an empty relation as an invalid relation, not as an omitted one', async () => {
    const text = ids(spec('empty', '<partOf relation=""><entity><name><simpleValue>IFCCURTAINWALL</simpleValue></name></entity></partOf>'));
    const facet = parseIDS(text).specifications[0].requirements[0].facet;
    expect(facet).not.toHaveProperty('anyRelation');
    expect(facet).toMatchObject({ type: 'partOf', rawRelation: '' });
    const report = await auditIDSDocument(text);
    expect(report.issues.map((i) => i.code)).toContain('E_IFC_PARTOF_RELATION');
    // Not widened to every relation: the aggregated mullion is not contained in the curtain wall.
    expect((await verdicts(text))['empty']).toEqual({ Mullion: false, Loose: false });
  });
});
