/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7402: the entity facet must see the class the STEP line declares. The
 * columnar type table deliberately files eight IFC4 *StandardCase classes
 * under their parent's `IfcTypeEnum` value (and IfcDistributionFlowElement /
 * IfcDistributionControlElement under IfcDistributionElement), so reading
 * `entities.getTypeName` made `IFCBEAMSTANDARDCASE` match nothing and made an
 * IfcBeamStandardCase satisfy an `IFCBEAM` requirement. IDS requires the class
 * to match exactly, with no inheritance in either direction.
 *
 * Driven through a real parsed STEP model and a real IDS document.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { createDataAccessor } from './data-accessor.js';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from '../validation/validator.js';

const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('probe.ifc','2026-10-10T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#20=IFCBEAMSTANDARDCASE('0000000000000000000020',$,'B-1',$,$,$,$,$,$);
#21=IFCBEAM('0000000000000000000021',$,'B-2',$,$,$,$,$,$);
#22=IFCDOORSTANDARDCASE('0000000000000000000022',$,'D-1',$,$,$,$,$,$,$,$);
#23=IFCDISTRIBUTIONFLOWELEMENT('0000000000000000000023',$,'F-1',$,$,$,$,$);
#24=IFCWALL('0000000000000000000024',$,'W-1',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

const entity = (name: string) => `<entity><name><simpleValue>${name}</simpleValue></name></entity>`;
const spec = (name: string, applicability: string, requirements: string) => `
    <specification name="${name}" ifcVersion="IFC4">
      <applicability minOccurs="0" maxOccurs="unbounded">${applicability}</applicability>
      <requirements>${requirements}</requirements>
    </specification>`;
const nameExists = '<attribute><name><simpleValue>Name</simpleValue></name></attribute>';

const IDS = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>probe</title></info>
  <specifications>${[
    spec('beam standard cases', entity('IFCBEAMSTANDARDCASE'), nameExists),
    spec('beams and beam standard cases must be IFCBEAM',
      '<entity><name><xs:restriction base="xs:string"><xs:enumeration value="IFCBEAM"/><xs:enumeration value="IFCBEAMSTANDARDCASE"/></xs:restriction></name></entity>',
      entity('IFCBEAM')),
    spec('beams only', entity('IFCBEAM'), nameExists),
    spec('door standard cases', entity('IFCDOORSTANDARDCASE'), nameExists),
    spec('distribution flow elements', entity('IFCDISTRIBUTIONFLOWELEMENT'), nameExists),
    spec('distribution elements', entity('IFCDISTRIBUTIONELEMENT'), nameExists),
    spec('walls', entity('IFCWALL'), nameExists),
  ].join('')}
  </specifications>
</ids>`;

async function run() {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer, { disableWorkerScan: true });
  const report = await validateIDS(parseIDS(IDS), createDataAccessor(store),
    { modelId: 'probe', schemaVersion: 'IFC4', entityCount: store.entityCount }, { includePassingEntities: true });
  return new Map(report.specificationResults.map((r) => [
    r.specification.name,
    r.entityResults.map((e) => `${e.entityName} ${e.entityType} ${e.passed ? 'pass' : 'fail'}`),
  ]));
}

describe('entity facet matches the declared STEP class (#7402)', () => {
  it('an IFCBEAMSTANDARDCASE applicability finds the IfcBeamStandardCase, reported under its own class', async () => {
    expect((await run()).get('beam standard cases')).toEqual(['B-1 IfcBeamStandardCase pass']);
  });

  it('an IFCBEAM requirement fails an IfcBeamStandardCase and passes an IfcBeam', async () => {
    expect([...((await run()).get('beams and beam standard cases must be IFCBEAM') ?? [])].sort()).toEqual([
      'B-1 IfcBeamStandardCase fail',
      'B-2 IfcBeam pass',
    ]);
  });

  it('an IFCBEAM applicability does not pick up the subtype (exact class, no inheritance)', async () => {
    expect((await run()).get('beams only')).toEqual(['B-2 IfcBeam pass']);
  });

  it('covers the other coalesced classes: a StandardCase and a distribution subtype', async () => {
    const results = await run();
    expect(results.get('door standard cases')).toEqual(['D-1 IfcDoorStandardCase pass']);
    expect(results.get('distribution flow elements')).toEqual(['F-1 IfcDistributionFlowElement pass']);
    expect(results.get('distribution elements')).toEqual([]);
  });

  it('control: an ordinary element keeps its PascalCase class name', async () => {
    expect((await run()).get('walls')).toEqual(['W-1 IfcWall pass']);
  });
});
