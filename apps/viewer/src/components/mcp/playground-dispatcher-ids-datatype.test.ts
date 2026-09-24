/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5304: the playground's `ids_validate` used a hand-built accessor that made
 * up a property's dataType from the JS value kind: every string was IFCLABEL
 * and every number IFCREAL. An IFCTEXT property therefore passed an IFCLABEL
 * facet and failed an IFCTEXT one, and a length never matched
 * IFCLENGTHMEASURE. The tool must report the dataType the file declares, the
 * same answer the CLI and the stdio MCP give through `@ifc-lite/ids/bridge`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { dispatch, parsePlaygroundModel } from './playground-dispatcher.js';

const IFC = [
  'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
  "#1=IFCPROJECT('0Proj00000000000000001',$,'P',$,$,$,$,$,#2);",
  '#2=IFCUNITASSIGNMENT((#3));',
  '#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
  "#100=IFCWALL('0Wall0000000000000001',$,'Wall A',$,$,$,$,$,$);",
  "#10=IFCPROPERTYSINGLEVALUE('Note',$,IFCTEXT('long text'),$);",
  "#11=IFCPROPERTYSINGLEVALUE('Width',$,IFCLENGTHMEASURE(0.3),$);",
  "#20=IFCPROPERTYSET('0Pset0000000000000001',$,'Pset_Test',$,(#10,#11));",
  "#21=IFCRELDEFINESBYPROPERTIES('0Rel00000000000000001',$,$,$,(#100),#20);",
  'ENDSEC;', 'END-ISO-10303-21;', '',
].join('\n');

function idsXml(propertyName: string, dataType: string): string {
  return `<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>dataType</title></info>
  <specifications>
    <specification name="s" ifcVersion="IFC4">
      <applicability><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
      <requirements>
        <property dataType="${dataType}">
          <propertySet><simpleValue>Pset_Test</simpleValue></propertySet>
          <baseName><simpleValue>${propertyName}</simpleValue></baseName>
        </property>
      </requirements>
    </specification>
  </specifications>
</ids>`;
}

async function passes(propertyName: string, dataType: string): Promise<boolean> {
  const model = await parsePlaygroundModel(new TextEncoder().encode(IFC).buffer as ArrayBuffer, 'fixture.ifc');
  const result = await dispatch(model, 'ids_validate', { ids_xml: idsXml(propertyName, dataType) });
  assert.equal(result.isError, false, result.text);
  return (result.structured as { summary: { passedSpecifications: number } }).summary.passedSpecifications === 1;
}

describe('playground ids_validate reports the declared property dataType (#5304)', () => {
  it('an IFCTEXT property passes IFCTEXT and fails IFCLABEL', async () => {
    assert.equal(await passes('Note', 'IFCTEXT'), true);
    assert.equal(await passes('Note', 'IFCLABEL'), false);
  });

  it('an IFCLENGTHMEASURE property passes IFCLENGTHMEASURE and fails IFCREAL', async () => {
    assert.equal(await passes('Width', 'IFCLENGTHMEASURE'), true);
    assert.equal(await passes('Width', 'IFCREAL'), false);
  });
});
