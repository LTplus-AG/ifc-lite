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
import { listArtifacts } from './artifacts';
import { MAX_RESULT_BYTES, resultBytes } from './result-limit';

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
  // Exact wire allowlist (#10898). New producer statistics need an explicit privacy decision.
  assert.deepEqual(Object.keys(parsed).sort(), [
    'droppedPropertyReferenceCount', 'droppedPropertyReferenceSampleIds', 'droppedPropertySetCount', 'droppedPropertySetSampleIds',
    'entityCount', 'includedRootEntityCount', 'prunedRelationshipCount', 'prunedRelationshipSampleIds', 'truncated',
    'warningCount', 'warnings', 'zeroedPlacementCount',
  ]);
  assert.ok(!diagnostics.includes('2600000') && !diagnostics.includes('1200000'), diagnostics);
});

test('a real anonymized IFC export succeeds when full diagnostic IDs alone exceed the result limit (#10898)', async () => {
  resetFeaturesForTest();
  const relationships = Array.from({ length: 92_000 }, (_, index) => 2_100_000_000 + index);
  assert.ok(resultBytes(relationships) > MAX_RESULT_BYTES, 'the old full relationship ID array alone exceeded the response limit');
  const records = relationships.map((id, index) =>
    `#${id}=IFCRELAGGREGATES('1${String(index).padStart(21, '0')}',$,$,$,#50,(#30));`).join('\n');
  const step = SITE.replace('ENDSEC;\nEND-ISO-10303-21;', `#50=IFCWALL('2Wall00000000000000000',$,'Excluded',$,$,$,$,$,$);\n${records}\nENDSEC;\nEND-ISO-10303-21;`);
  const store = await parseStep(new TextEncoder().encode(step));
  seed([model('A', store, { maxExpressId: relationships.at(-1) })]);
  const host = viewerHost();
  const included = [30, ...relationships];
  const result = await dispatchMainViewerTool(host, 'viewer_operation_execute', {
    operation_id: 'exports.anonymized',
    // Anonymized membership always includes the source IfcProject (#1).
    input: { ...input, seed_ids: included, expected_included_ids: [1, ...included] },
  }, { canEdit: () => true });
  assert.equal(result.isError, false, result.text.slice(0, 500));
  const { artifact, diagnostics_json } = (result.structured as { result: { artifact: { artifact_id: string }; diagnostics_json: string } }).result;
  const diagnostics = JSON.parse(diagnostics_json) as { prunedRelationshipCount: number; prunedRelationshipSampleIds: number[] };
  assert.equal(diagnostics.prunedRelationshipCount, relationships.length);
  assert.deepEqual(diagnostics.prunedRelationshipSampleIds, relationships.slice(0, 32));
  assert.ok(resultBytes(result.structured) < 16 * 1024, 'small reply even with an oversized native diagnostic list');
  assert.deepEqual(listArtifacts(host).map(row => row.artifact_id), [artifact.artifact_id]);
  const read = await dispatchMainViewerTool(host, 'viewer_artifact_read', { artifact_id: artifact.artifact_id });
  assert.equal(read.isError, false, read.text);
  const stepExport = Buffer.from((read.structured as { data: string }).data, 'base64').toString('utf8');
  assert.match(stepExport, /IFCSITE/);
  assert.doesNotMatch(stepExport, /#2100000000=|Excluded/);
});
