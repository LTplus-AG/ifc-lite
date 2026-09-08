/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #3715 end-to-end: `setProperty(…, PropertyValueType.Text)` on a property whose
 * source line declares `IFCLABEL` must export `IFCTEXT`.
 *
 * The unit-level rule lives in `declared-nominal-value-type.test.ts`. This file
 * drives the whole path the issue reports against — parse, `setProperty`,
 * `StepExporter`, RE-PARSE — because that is where the defect was visible and
 * the unit assertion alone would not have caught the merge in
 * `MutablePropertyView.getForEntity` that hands the exporter its `type` and
 * `dataType` separately.
 *
 * The re-parse is the point: an IDS `property` facet with `dataType="IFCTEXT"`
 * reads the token back out of the exported file, and before this fix it kept
 * reporting `is "IFCLABEL", expected "IFCTEXT"` no matter what the session did.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { PropertyValueType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

/** A wall carrying one string property whose line declares its token. */
const SOURCE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0project0000000000000a',$,'P',$,$,$,$,$,$);
#10=IFCWALL('0wall00000000000000001',$,'W',$,$,$,$,$,$);
#996=IFCPROPERTYSINGLEVALUE('RUS_LandID',$,IFCLABEL('77:01:0004042:1234'),$);
#997=IFCPROPERTYSINGLEVALUE('Untouched',$,IFCTEXT('prose'),$);
#998=IFCPROPERTYSET('0pset00000000000000001',$,'RusSet_AGR',$,(#996,#997));
#999=IFCRELDEFINESBYPROPERTIES('0rel000000000000000001',$,$,$,(#10),#998);
ENDSEC;
END-ISO-10303-21;
`;

async function parse(bytes: ArrayBuffer) {
  return new IfcParser().parseColumnar(bytes, { disableWorkerScan: true });
}

/**
 * Export the model with `RUS_LandID` re-typed to `valueType`, and report both
 * the emitted line and the token a re-parse reads back from it.
 */
async function exportWithType(
  valueType: PropertyValueType,
  value: string = '77:01:0004042:1234',
): Promise<{ line: string; reparsedDataType: string | undefined; untouched: string }> {
  const store = await parse(new TextEncoder().encode(SOURCE).buffer as ArrayBuffer);
  const entityId = store.entityIndex.byType.get('IFCWALL')![0];

  const view = new MutablePropertyView(null, 'm');
  view.setOnDemandExtractor(id => extractPropertiesOnDemand(store, id));
  view.setExpressIdWatermark(1_000_000);
  view.setProperty(entityId, 'RusSet_AGR', 'RUS_LandID', value, valueType);

  const { content } = new StepExporter(store, view).export({
    schema: 'IFC4',
    includeGeometry: false,
  });
  const text = new TextDecoder().decode(content);
  const lineOf = (name: string) =>
    text.split('\n').find(l => l.includes(`'${name}'`))?.trim() ?? '';

  const reparsed = await parse(content.slice().buffer as ArrayBuffer);
  const wallId = reparsed.entityIndex.byType.get('IFCWALL')![0];
  const prop = extractPropertiesOnDemand(reparsed, wallId)
    .flatMap(p => p.properties)
    .find(p => p.name === 'RUS_LandID');

  return {
    line: lineOf('RUS_LandID'),
    reparsedDataType: prop?.dataType,
    untouched: lineOf('Untouched'),
  };
}

describe('setProperty can change a declared type within one EXPRESS base (#3715)', () => {
  it('IFCLABEL -> IFCTEXT survives export and re-parse', async () => {
    const { line, reparsedDataType } = await exportWithType(PropertyValueType.Text);
    expect(line).toContain("IFCTEXT('77:01:0004042:1234')");
    expect(line).not.toContain('IFCLABEL');
    // What an IDS `dataType="IFCTEXT"` facet reads. The request used to be
    // accepted, recorded, and then discarded in the exported bytes.
    expect(reparsedDataType).toBe('IFCTEXT');
  });

  it('IFCLABEL -> IFCIDENTIFIER likewise', async () => {
    const { line, reparsedDataType } = await exportWithType(PropertyValueType.Identifier);
    expect(line).toContain("IFCIDENTIFIER('77:01:0004042:1234')");
    expect(reparsedDataType).toBe('IFCIDENTIFIER');
  });

  it('regenerating the set does not rewrite an untouched neighbour’s token (#2482)', async () => {
    // Editing `RUS_LandID` rewrites the whole property set, so `Untouched` is
    // re-serialized too. Its source `IFCTEXT` must survive: this is the defect
    // the base-agreement rule exists to prevent, and the one a fix that let any
    // requested type win would have re-introduced.
    const { untouched } = await exportWithType(PropertyValueType.Text);
    expect(untouched).toContain("IFCTEXT('prose')");
  });

  it('a value-only edit leaves the source token alone', async () => {
    // The UI path: `setProperty` with no meaningful type, which defaults to
    // `String` — a shape, not a member. It must not narrow `IFCLABEL` or widen
    // it; the source token stays.
    const { line, reparsedDataType } = await exportWithType(PropertyValueType.String, 'new-value');
    expect(line).toContain("IFCLABEL('new-value')");
    expect(reparsedDataType).toBe('IFCLABEL');
  });
});
