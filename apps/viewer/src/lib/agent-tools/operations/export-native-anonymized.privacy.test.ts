/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useViewerStore } from '@/store';
import { resetFeaturesForTest } from '@/lib/features';
import { model, parseStep, seed, viewerHost } from '@/test/agent-tools-fixture';
import { dispatchMainViewerTool } from '../main-viewer-dispatch';

const initial = useViewerStore.getState();
afterEach(() => { useViewerStore.setState(initial); resetFeaturesForTest(); });

/** A site whose root placement sits at real projected coordinates. */
const SITE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('site.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,(#14),#9);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#9=IFCUNITASSIGNMENT((#2));
#10=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCAXIS2PLACEMENT3D(#10,$,$);
#14=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#13,$);
#20=IFCCARTESIANPOINT((2600000.,1200000.,500.));
#21=IFCAXIS2PLACEMENT3D(#20,$,$);
#22=IFCLOCALPLACEMENT($,#21);
#30=IFCSITE('0Site000000000000000aa',$,'Site',$,$,#22,$,$,.ELEMENT.,$,$,$,$,$);
#40=IFCRELAGGREGATES('0Agg000000000000000aa',$,$,$,#1,(#30));
ENDSEC;
END-ISO-10303-21;
`;
const off = false;
const input = { target_model_id: 'A', seed_ids: [30], excluded_ids: [], excluded_types: [], file_stem: 'site',
  relations: { IfcRelVoidsElement: off, IfcRelFillsElement: off, IfcRelAggregates: 'none', IfcRelNests: 'none', IfcRelDefinesByType: off,
    IfcRelAssociatesMaterial: off, IfcRelContainedInSpatialStructure: off, IfcRelDefinesByProperties: off, IfcRelConnectsPathElementsDepth: 0 },
  anonymize: { names: true, otherNames: true, globalIds: true, propertySets: true, rootPlacementPosition: true, georeferencing: true, currency: true } };

test('anonymized export diagnostics leave out the original coordinates they zeroed (#10695)', async () => {
  resetFeaturesForTest();
  seed([model('A', await parseStep(new TextEncoder().encode(SITE)))]);
  const host = viewerHost();
  const run = (operation_id: string, extra = {}) => dispatchMainViewerTool(host, 'viewer_operation_execute', { operation_id, input: { ...input, ...extra } }, { canEdit: () => true });
  const preview = await run('exports.anonymized.prepare');
  assert.equal(preview.isError, false, preview.text);
  const { included_ids } = (preview.structured as { result: { included_ids: number[] } }).result;
  const exported = await run('exports.anonymized', { expected_included_ids: included_ids });
  assert.equal(exported.isError, false, exported.text);
  const diagnostics = (exported.structured as { result: { diagnostics_json: string } }).result.diagnostics_json;
  const parsed = JSON.parse(diagnostics) as Record<string, unknown>;
  assert.equal(parsed.zeroedPlacementCount, 1, 'the root placement was zeroed');
  assert.ok(!('zeroedPlacements' in parsed));
  assert.ok(!diagnostics.includes('2600000') && !diagnostics.includes('1200000'), diagnostics);
});
