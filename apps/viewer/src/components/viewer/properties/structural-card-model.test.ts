/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `structuralCardSections` on the generated IFC4 coverage fixture, which
 * carries one record of every structural kind (#9668). The structural coverage
 * harness checks every corpus record against its file (`probes/card.mjs`);
 * this pins the shape the card renders: EXPRESS names in schema order, held
 * records as sections of their own, references as ids and measures for units.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IfcParser, extractStructuralOnDemand, type StructuralExtraction } from '@ifc-lite/parser';
import { structuralCardSections, type StructuralCardSection } from './structural-card-model.js';

const FIXTURE = fileURLToPath(new URL('../../../../../../tests/models/ifcopenshell/generated_structural_coverage_ifc4.ifc', import.meta.url));
const maybe = existsSync(FIXTURE) ? it : it.skip;

let loaded: Promise<{ data: StructuralExtraction; schema: string }> | null = null;
function fixture() {
  loaded ??= (async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer, { disableWorkerScan: true });
    return { data: extractStructuralOnDemand(store), schema: store.schemaVersion };
  })();
  return loaded;
}

async function card(expressId: number): Promise<StructuralCardSection[]> {
  const { data, schema } = await fixture();
  return structuralCardSections(data, { expressId }, schema);
}

const rows = (section: StructuralCardSection | undefined) => Object.fromEntries(section?.rows.map((r) => [r.attribute, r.value]) ?? []);

describe('structuralCardSections on generated_structural_coverage_ifc4.ifc', () => {
  maybe('shows a load case\'s own attributes by EXPRESS name, in schema order', async () => {
    const [section, ...rest] = await card(80);
    assert.equal(rest.length, 0);
    assert.deepEqual({ ...section, rows: undefined }, { expressId: 80, type: 'IfcStructuralLoadCase', via: null, depth: 0, rows: undefined });
    assert.deepEqual(section.rows.map((r) => r.attribute), ['Name', 'PredefinedType', 'ActionType', 'ActionSource', 'Coefficient', 'Purpose', 'SelfWeightCoefficients']);
    assert.deepEqual(rows(section).SelfWeightCoefficients, [0, 0, -1]);
  });

  maybe('nests an activity\'s load configuration and each of its values, with their measures', async () => {
    const sections = await card(51);
    assert.deepEqual(sections.map((s) => [s.via, s.type, s.expressId, s.depth]), [
      [null, 'IfcStructuralCurveAction', 51, 0],
      ['AppliedLoad', 'IfcStructuralLoadConfiguration', 23, 1],
      ['Values[0]', 'IfcStructuralLoadLinearForce', 18, 2],
      ['Values[1]', 'IfcStructuralLoadLinearForce', 18, 2],
    ]);
    assert.deepEqual(rows(sections[0]).AppliedLoad, { ref: 23 });
    assert.deepEqual(rows(sections[1]), { Name: 'Coverage configuration', Values: { refs: [18, 18] }, Locations: [[0], [4]] });
    // A nested list attribute (`IfcLengthMeasure[]`) still carries its measure.
    assert.equal(sections[1].rows.find((r) => r.attribute === 'Locations')?.measure, 'IfcLengthMeasure');
    assert.deepEqual(sections[2].rows.find((r) => r.attribute === 'LinearForceZ'), { attribute: 'LinearForceZ', value: -250, measure: 'IfcLinearForceMeasure' });
  });

  maybe('shows a member\'s ends: relationship attributes, conditions and eccentricity', async () => {
    const sections = await card(31);
    assert.deepEqual(rows(sections[0]), { Name: 'Coverage IfcStructuralCurveMember', PredefinedType: 'RIGID_JOINED_MEMBER', Axis: { ref: 15 } });
    assert.deepEqual(sections.slice(1).map((s) => [s.via, s.type, s.expressId]), [
      ['IfcRelConnectsStructuralMember[0]', 'IfcRelConnectsStructuralMember', 64],
      ['AppliedCondition', 'IfcBoundaryNodeCondition', 24],
      ['AdditionalConditions', 'IfcFailureConnectionCondition', 28],
      ['IfcRelConnectsStructuralMember[1]', 'IfcRelConnectsWithEccentricity', 68],
      ['AppliedCondition', 'IfcBoundaryNodeCondition', 24],
      ['AdditionalConditions', 'IfcSlippageConnectionCondition', 29],
      ['ConnectionConstraint', 'IfcConnectionPointEccentricity', 67],
    ]);
    const end = sections[1].rows.find((r) => r.attribute === 'SupportedLength');
    assert.deepEqual(end, { attribute: 'SupportedLength', value: 5, measure: 'IfcLengthMeasure' });
    assert.deepEqual(rows(sections[1]).RelatedStructuralConnection, { ref: 39 });
    assert.deepEqual(rows(sections[1]).ConditionCoordinateSystem, { ref: 7 });
    assert.deepEqual(rows(sections.at(-1)), { PointOnRelatingElement: { ref: 6 }, PointOnRelatedElement: { ref: 6 }, EccentricityInX: 0.1, EccentricityInY: 0, EccentricityInZ: -0.05 });
  });

  maybe('names a connection\'s axis by the schema\'s attribute only', async () => {
    const [section] = await card(41);
    assert.deepEqual(rows(section).Axis, { ref: 15 });
    assert.ok(!('AxisDirection' in rows(section)), 'IFC4 has no AxisDirection');
  });

  maybe('shows group links as GlobalIds', async () => {
    const { data } = await fixture();
    const gid = (id: number) => [...data.loadGroups, ...data.resultGroups].find((g) => g.expressId === id)!.globalId;
    const [model] = await card(data.analysisModels[0].expressId);
    assert.deepEqual(rows(model).LoadedBy, { globalIds: [gid(79), gid(80)] });
    assert.deepEqual(rows(model).HasResults, { globalIds: [gid(81)] });
    const [result] = await card(81);
    assert.deepEqual(rows(result), { Name: 'Coverage IfcStructuralResultGroup', TheoryType: 'FIRST_ORDER_THEORY', ResultForLoadGroup: { globalId: gid(79) }, IsLinear: true });
  });

  maybe('shows nothing for a record that is not structural', async () => {
    assert.deepEqual(await card(14), []);
  });
});
