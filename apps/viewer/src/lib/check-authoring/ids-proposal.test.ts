/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIDS, validateIDS, type IDSDocument } from '@ifc-lite/ids';
import { createDataAccessor } from '@/hooks/ids/idsDataAccessor';
import { SAMPLE_IDS_PROPOSAL as SAMPLE_PROPOSAL, SAMPLE_IDS_XML as SAMPLE_IDS, parseSampleIfc, json as answer } from '@/test/check-authoring-fixture';
import { auditIdsDraft, buildIdsDraft, parseIdsProposal } from './ids-proposal';
import { siUnitOf, unitConversions } from './ids-constraint';
import { auditBlocks } from './save';

/** What a validator reads: parser bookkeeping (raw echoes, ids it invents) and the document metadata excluded.
 * An absent maxOccurs is IDS's default, "unbounded", which the writer spells out. */
function checks(doc: IDSDocument): unknown {
  return doc.specifications.map(spec => ({ name: spec.name, ifcVersions: spec.ifcVersions, minOccurs: spec.minOccurs, maxOccurs: spec.maxOccurs ?? 'unbounded',
    applicability: spec.applicability.facets, requirements: spec.requirements.map(r => ({ facet: r.facet, optionality: r.optionality })) }));
}

// #6915: the proposal maps 1:1 onto the native IDS model, through the native writer and parser.
test('a proposal of the committed sample IDS reads back as the same native specifications and verdicts', async () => {
  const draft = buildIdsDraft(parseIdsProposal(answer(SAMPLE_PROPOSAL)));
  const sample = parseIDS(SAMPLE_IDS);
  assert.deepEqual(checks(draft.document), checks(sample));
  assert.deepEqual(checks(parseIDS(draft.xml)), checks(draft.document), 'the reviewed XML is what the native parser reads');
  const store = await parseSampleIfc();
  const info = { modelId: 'arch', schemaVersion: 'IFC4' as const, entityCount: store.entityCount };
  const [fromDraft, fromSample] = await Promise.all([validateIDS(draft.document, createDataAccessor(store, 'arch'), info),
    validateIDS(sample, createDataAccessor(store, 'arch'), info)]);
  const counts = (report: typeof fromDraft) => report.specificationResults.map(r => [r.status, r.applicableCount, r.passedCount, r.failedCount]);
  assert.deepEqual(counts(fromDraft), counts(fromSample));
  assert.ok(fromSample.specificationResults.some(r => r.applicableCount > 0), 'the sample actually exercises the specifications');
  assert.equal((await auditIdsDraft(draft)).filter(issue => issue.severity === 'error').length, 0);
});

test('measure units convert to the SI values IDS stores, and partOf/classification map to native facets', () => {
  const proposal = parseIdsProposal(answer({ version: 1, kind: 'ids.specifications', title: 'Doors', specifications: [{
    name: 'Doors on storeys are wide enough', cardinality: 'optional',
    applicability: [{ type: 'partOf', relation: 'IfcRelContainedInSpatialStructure', entity: { name: 'IFCBUILDINGSTOREY' } }, { type: 'entity', name: 'IFCDOOR' }],
    requirements: [
      { type: 'property', propertySet: 'Qto_DoorBaseQuantities', baseName: 'Width', dataType: 'IFCLENGTHMEASURE', unit: 'mm', value: { type: 'bounds', minInclusive: 900 } },
      { type: 'property', propertySet: 'Qto_DoorBaseQuantities', baseName: 'Area', dataType: 'IFCAREAMEASURE', unit: 'cm2', value: 25000 },
      { type: 'classification', system: 'Uniclass 2015', value: { type: 'pattern', pattern: 'Pr_30_59_.*' }, cardinality: 'optional' },
    ] }] }));
  const spec = buildIdsDraft(proposal).document.specifications[0];
  assert.deepEqual(spec.applicability.facets.map(f => f.type), ['entity', 'partOf'], 'applicability follows the ids.xsd sequence');
  assert.deepEqual([spec.minOccurs, spec.maxOccurs], [0, 'unbounded']);
  const [width, area, classification] = JSON.parse(JSON.stringify(spec.requirements)) as typeof spec.requirements;
  assert.deepEqual(width.facet.type === 'property' && width.facet.value, { type: 'bounds', minInclusive: 0.9, base: 'xs:double' });
  assert.deepEqual(area.facet.type === 'property' && area.facet.value, { type: 'simpleValue', value: '2.5' });
  assert.equal(classification.optionality, 'optional');
});

// #6915 review: the SI conversion is not hidden; the review shows the declared unit next to the stored SI value.
test('a declared unit stays on the proposal, located on its facet, and converts the current SI value back for display', () => {
  const proposal = parseIdsProposal(answer({ version: 1, kind: 'ids.specifications', title: 'Doors', specifications: [{
    name: 'Tall doors are wide', applicability: [
      { type: 'property', propertySet: 'Qto_DoorBaseQuantities', baseName: 'Height', dataType: 'IFCLENGTHMEASURE', unit: 'mm', value: { type: 'bounds', minInclusive: 2000 } },
      { type: 'entity', name: 'IFCDOOR' }],
    requirements: [{ type: 'attribute', name: 'Name' },
      { type: 'property', propertySet: 'Qto_DoorBaseQuantities', baseName: 'Width', dataType: 'IFCLENGTHMEASURE', unit: 'mm', value: 2400 }] }] }));
  assert.deepEqual(proposal.units, [{ spec: 0, part: 'applicability', index: 1, unit: 'mm' }, { spec: 0, part: 'requirements', index: 1, unit: 'mm' }],
    'the applicability index is the one after the ids.xsd reordering');
  const spec = proposal.document.specifications[0];
  const height = spec.applicability.facets[1], width = spec.requirements[1].facet;
  assert.ok(height.type === 'property' && width.type === 'property');
  assert.deepEqual(unitConversions(width.value, 'mm'), [{ authored: 2400, si: 2.4 }]);
  assert.deepEqual(unitConversions(height.value, 'mm'), [{ authored: 2000, si: 2 }]);
  assert.deepEqual(unitConversions({ type: 'simpleValue', value: '3' }, 'mm'), [{ authored: 3000, si: 3 }], 'an edited SI value reads back in the declared unit');
  assert.deepEqual(unitConversions({ type: 'simpleValue', value: '2.5' }, 'cm2'), [{ authored: 25000, si: 2.5 }]);
  assert.deepEqual(unitConversions({ type: 'simpleValue', value: 'tall' }, 'mm'), []);
  assert.deepEqual([siUnitOf('IFCLENGTHMEASURE'), siUnitOf('IFCAREAMEASURE'), siUnitOf('IFCVOLUMEMEASURE'), siUnitOf('IFCLABEL')], ['m', 'm²', 'm³', null]);
  assert.deepEqual(parseIdsProposal(answer(SAMPLE_PROPOSAL)).units, [], 'no unit declared, nothing recorded');
});

test('refusals name the field and what to change', () => {
  const spec = SAMPLE_PROPOSAL.specifications[1];
  const refuse = (value: unknown, pattern: RegExp) => assert.throws(() => parseIdsProposal(typeof value === 'string' ? value : answer(value)), pattern);
  const withSpec = (patch: object) => ({ ...SAMPLE_PROPOSAL, specifications: [{ ...spec, ...patch }] });
  const withRequirement = (requirement: object) => withSpec({ requirements: [requirement] });
  refuse('{"version":1,"kind":"ids.specifications","title":"x","specifications":[', /not complete JSON/);
  refuse({ ...SAMPLE_PROPOSAL, version: 2 }, /"version": 1/);
  refuse({ ...SAMPLE_PROPOSAL, author: 'x' }, /unsupported field\(s\) author/);
  refuse(withSpec({ applicability: [] }), /applicability must list 1 to 20 facets/);
  refuse(withSpec({ applicability: [{ type: 'entity', name: 'IFCWALL' }, { type: 'entity', name: 'IFCSLAB' }] }), /only one entity facet/);
  refuse(withSpec({ requirements: [] }), /has no requirements/);
  refuse(withRequirement({ type: 'property', propertySet: 'Pset_WallCommon', baseName: 'ThermalTransmittance', dataType: 'IFCTHERMALTRANSMITTANCEMEASURE', unit: 'W/m2K', value: 0.2 }),
    /unit must be one of .*state the value in SI or list the requirement as unsupported/);
  refuse(withRequirement({ type: 'property', propertySet: 'Pset_WallCommon', baseName: 'FireRating', dataType: 'IFCLABEL', unit: 'mm', value: 1 }), /unit needs dataType/);
  refuse(withRequirement({ type: 'property', propertySet: 'Pset_WallCommon', baseName: 'Width', dataType: 'IFCREALX' }), /upper-case IFC data type/);
  refuse(withRequirement({ type: 'property', propertySet: 'Pset_WallCommon', baseName: 'Width', value: { type: 'bounds', minInclusive: 3, maxInclusive: 1 } }), /lower bound above its upper bound/);
  // #6915 review: equal bounds with an exclusive side admit no value, so every applicable element would fail.
  refuse(withRequirement({ type: 'property', propertySet: 'Pset_WallCommon', baseName: 'Width', value: { type: 'bounds', minExclusive: 5, maxExclusive: 5 } }), /admits no value/);
  refuse(withRequirement({ type: 'property', propertySet: 'Pset_WallCommon', baseName: 'Width', value: { type: 'bounds', minInclusive: 5, maxExclusive: 5 } }), /admits no value/);
  refuse(withRequirement({ type: 'property', propertySet: 'Pset_WallCommon', baseName: 'Width', value: { type: 'bounds', minExclusive: 5, maxInclusive: 5 } }), /admits no value/);
  assert.doesNotThrow(() => parseIdsProposal(answer(withRequirement({ type: 'property', propertySet: 'Pset_WallCommon', baseName: 'Width',
    value: { type: 'bounds', minInclusive: 5, maxInclusive: 5 } }))), 'inclusive equal bounds admit exactly that value');
  refuse(withRequirement({ type: 'classification', value: 'Ss_25' }), /system is required/);
  refuse(withRequirement({ type: 'partOf', relation: 'IfcRelAggregates', entity: { name: 'IFCBUILDING' }, cardinality: 'optional' }), /required or prohibited/);
  refuse(withRequirement({ type: 'attribute', name: 'Name', value: { type: 'enumeration', values: ['A', 'A'] } }), /repeats a value/);
  refuse(withRequirement({ type: 'geometry', clearance: 0.9 }), /type must be one of entity, attribute, property/);
  refuse({ ...SAMPLE_PROPOSAL, specifications: [spec, spec] }, /names must be distinct/);
});

// #6915: a requirement no engine can check stays visible and inside the IDS a user saves or exports.
test('unsupported requirements are retained in the native IDS document and its specification', () => {
  const proposal = parseIdsProposal(answer({ ...SAMPLE_PROPOSAL, unsupported: [
    { text: 'Escape doors open outwards', reason: 'opening direction is geometry', relatesTo: 'Walls are external' },
    { text: 'Finishes match the sample board', reason: 'manual visual inspection' }] }));
  assert.equal(proposal.unsupported.length, 2);
  const reread = parseIDS(buildIdsDraft(proposal).xml);
  assert.match(reread.info.description ?? '', /1\. Escape doors open outwards \(opening direction is geometry; Walls are external\)/);
  assert.match(reread.info.description ?? '', /2\. Finishes match the sample board \(manual visual inspection\)/);
  assert.match(reread.specifications[1].instructions ?? '', /Escape doors open outwards/);
  assert.equal(reread.specifications[0].instructions, undefined);
  const onlyUnsupported = parseIdsProposal(answer({ ...SAMPLE_PROPOSAL, specifications: [], unsupported: [{ text: 'Doors are fire rated', reason: 'no data source' }] }));
  assert.equal(buildIdsDraft(onlyUnsupported).xml, '', 'nothing to save as IDS, but the requirement is still listed');
});

test('the native audit blocks a draft whose property is not in its standard property set', async () => {
  const draft = buildIdsDraft(parseIdsProposal(answer({ ...SAMPLE_PROPOSAL, specifications: [{ ...SAMPLE_PROPOSAL.specifications[1],
    requirements: [{ type: 'property', propertySet: 'Pset_WallCommon', baseName: 'IsExternal', dataType: 'IFCLABEL', value: 'true' }] }] })));
  const issues = await auditIdsDraft(draft);
  assert.ok(issues.some(issue => issue.severity === 'error' && issue.code === 'W_IFC_DATATYPE_MISMATCH'), JSON.stringify(issues));
  assert.equal(auditBlocks(issues), true);
});
