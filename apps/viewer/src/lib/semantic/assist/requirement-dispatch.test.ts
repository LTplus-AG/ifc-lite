/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7375: explicit native targets of reviewed source requirements, and the drafts built from them. */

import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import type { IFCVersion } from '@ifc-lite/ids';
import { parseSemanticRequirements, type ExtractedRequirement } from './requirement-proposal';
import { reviewRequirements } from './requirement-review';
import { passagesOf } from './spans';
import { prepareNativeDrafts, qualifyRequirements } from './requirement-dispatch';
import { loadSchemaMeasures, textRevision, type SchemaMeasures } from './requirement-targets';
import { auditIdsDraft, buildIdsDraft } from '@/lib/check-authoring/ids-proposal';

const TEXT = 'Doors shall be rated EI30 in Pset_DoorCommon.FireRating. Door width at least 900 mm. Door names match D-[0-9]+.';
const sources = [{ id: 'S1', title: 'Spec', text: TEXT }];
const passages = passagesOf('S1', TEXT);
const span = (quote: string) => ({ source: 'S1', start: TEXT.indexOf(quote), end: TEXT.indexOf(quote) + quote.length, quote });
const door = (id: string, fields: Partial<ExtractedRequirement>, quote = 'rated EI30') =>
  ({ id, statement: `Statement ${id}`, appliesTo: { ifcClass: 'IfcDoor' }, span: span(quote), ...fields });

let schema: SchemaMeasures;
before(async () => { schema = await loadSchemaMeasures(); });

function qualify(requirements: object[], unsupported: object[] = [], versions: readonly IFCVersion[] = ['IFC4']) {
  const proposal = parseSemanticRequirements(JSON.stringify({ version: 1, kind: 'semantic.requirements', title: 'Doors', requirements, unsupported }));
  const review = reviewRequirements(proposal, passages);
  const rows = qualifyRequirements(review, passages, sources, schema, versions);
  const draft = (excluded: ReadonlySet<string> = new Set(), ifcVersions: readonly IFCVersion[] = versions) =>
    prepareNativeDrafts(proposal, rows, excluded, { unsupported: review.unsupported, passages, sources, ifcVersions });
  return { rows, draft };
}

test('#7375 each requirement gets one explicit target, or the reason it has none', () => {
  const { rows } = qualify([
    door('A', { property: 'Pset_DoorCommon.FireRating', operator: 'equals', value: 'EI30' }),
    door('B', { property: 'Qto_DoorBaseQuantities.Width', operator: 'atLeast', value: 900, unit: 'mm' }, 'at least 900 mm'),
    door('C', { property: 'Qto_DoorBaseQuantities.Width', operator: 'atLeast', value: 900 }, 'at least 900 mm'),
    door('D', { property: 'FireRating', operator: 'exists' }),
    door('E', { property: 'Pset_DoorCommon.FireRating', operator: 'notEquals', value: 'EI30' }),
    // The quoted words exist, but not at the cited offsets: the span does not verify.
    door('F', { property: 'Pset_DoorCommon.FireRating', operator: 'equals', value: 'EI30', span: { ...span('rated EI30'), start: 0, end: 10 } }),
    { id: 'G', statement: 'Doors are inspected on site', span: span('Doors shall be rated') },
    door('H', { property: 'Name', operator: 'matches', value: 'D-[0-9]+' }, 'D-[0-9]+'),
    door('I', { property: 'Name', operator: 'equals', value: 'D-1', unit: 'mm' }),
    door('J', { property: 'Qto_DoorBaseQuantities.Width', operator: 'atMost', value: 2, unit: 'furlong' }, 'at least 900 mm'),
    { ...door('K', { property: 'Pset_DoorCommon.FireRating', operator: 'exists' }), appliesTo: { ifcClass: 'IfcDoor', ontologyClass: 'https://example.org/FireDoor' } },
  ]);
  assert.deepEqual(rows.map(row => [row.requirement.id, row.target, row.reason ?? null]), [
    ['A', 'ids', null], ['B', 'geometry', null], ['C', 'unresolved', 'unit'], ['D', 'unresolved', 'property'],
    ['E', 'unresolved', 'operator'], ['F', 'unresolved', 'span'], ['G', 'manual', null], ['H', 'ids', null],
    ['I', 'unresolved', 'unit'], ['J', 'unresolved', 'unit'], ['K', 'unresolved', 'scope'],
  ]);
  assert.deepEqual(rows[0].source, { source: 'S1', title: 'Spec', revision: textRevision(TEXT), characters: TEXT.length });
  assert.equal(rows[5].source, undefined, 'an unverified span never claims a source revision');
  for (const index of [2, 3, 4, 8, 9, 10]) assert.deepEqual(rows[index].source, rows[0].source, `unresolved ${rows[index].requirement.id} keeps its verified source`);
});

test('#7375 a stated value is never weakened to an existence check', () => {
  const { rows, draft } = qualify([
    door('A', { property: 'Pset_DoorCommon.FireRating', value: 'EI30' }),
    door('B', { property: 'Pset_DoorCommon.FireRating', operator: 'exists', value: 'EI30' }),
    door('C', { property: 'Qto_DoorBaseQuantities.Width', value: 900, unit: 'mm' }, 'at least 900 mm'),
    door('D', { property: 'Qto_DoorBaseQuantities.Width', operator: 'exists', value: 900, unit: 'mm' }, 'at least 900 mm'),
    door('E', { property: 'Pset_DoorCommon.FireRating', operator: 'exists' }),
  ]);
  assert.deepEqual(rows.map(row => [row.requirement.id, row.target, row.reason ?? null]), [
    ['A', 'unresolved', 'value'], ['B', 'unresolved', 'value'], ['C', 'unresolved', 'value'], ['D', 'unresolved', 'value'], ['E', 'ids', null],
  ]);
  const drafts = draft(new Set());
  assert.deepEqual(drafts.ids?.document.specifications.map(spec => spec.name), ['E: Statement E'], 'only the true existence requirement becomes IDS');
  assert.equal(drafts.rules, null);
  assert.equal(drafts.document?.unsupported.length, 4, 'the value-carrying ones stay listed as not checked');
});

test('#7375 every document item keeps its source passage: verified with its revision, unverified labelled as such', () => {
  const { rows, draft } = qualify([
    door('E', { property: 'Pset_DoorCommon.FireRating', operator: 'notEquals', value: 'EI30' }),
    door('B', { property: 'Name', operator: 'matches', value: 'D-\\q[0-9]+' }, 'D-[0-9]+'),
    door('F', { property: 'Pset_DoorCommon.FireRating', operator: 'equals', value: 'EI30', span: { ...span('rated EI30'), start: 0, end: 10 } }),
  ]);
  assert.equal(rows[1].reason, 'native');
  assert.deepEqual(rows[1].source, rows[0].source, 'a native refusal keeps the verified source');
  const items = draft(new Set()).document!.unsupported.map(item => item.text);
  const revision = `revision ${textRevision(TEXT)}, ${TEXT.length} characters`;
  assert.equal(items[0], `E: Statement E\nSource requirement E from S1 "Spec" (${revision}), characters ${TEXT.indexOf('rated EI30')}-${TEXT.indexOf('rated EI30') + 10}: "rated EI30".`);
  assert.match(items[1], new RegExp(`^B: Statement B\\nSource requirement B from S1 "Spec" \\(${revision}\\)`));
  assert.equal(items[2], 'F: Statement F\nCited from S1, characters 0-10: "rated EI30" (not verified against the attached text).');
});

test('#7375 the IDS draft targets the IFC versions it is given', () => {
  const { draft } = qualify([door('A', { property: 'Pset_DoorCommon.FireRating', operator: 'equals', value: 'EI30' })]);
  assert.deepEqual(draft(new Set(), ['IFC2X3', 'IFC4X3_ADD2']).ids?.document.specifications[0].ifcVersions, ['IFC2X3', 'IFC4X3_ADD2']);
});

test('#7375 the native validator refuses a requirement individually, without blocking the others', () => {
  // `\q` is not an XSD regular-expression escape: the P07 IDS parser refuses it.
  const { rows, draft } = qualify([
    door('A', { property: 'Pset_DoorCommon.FireRating', operator: 'equals', value: 'EI30' }),
    door('B', { property: 'Name', operator: 'matches', value: 'D-\\q[0-9]+' }, 'D-[0-9]+'),
  ]);
  assert.equal(rows[1].target, 'unresolved');
  assert.equal(rows[1].reason, 'native');
  assert.match(rows[1].detail ?? '', /pattern/);
  const drafts = draft(new Set());
  assert.equal(drafts.ids?.document.specifications.length, 1);
  assert.deepEqual(drafts.refused, []);
  assert.match(drafts.document?.unsupported[0].reason ?? '', /^Unresolved: the native validator refused it \(.*pattern/);
});

test('#7375 a geometry rule compares the stated unit in SI and keeps the statement, unit and span with the rule', () => {
  const { draft } = qualify([door('B', { property: 'Qto_DoorBaseQuantities.Width', operator: 'atLeast', value: 900, unit: 'mm' }, 'at least 900 mm')],
    [{ text: 'Doors look good', reason: 'No measurable criterion' }]);
  const drafts = draft(new Set());
  const [rule] = drafts.rules!.ruleSet.rules;
  assert.deepEqual(rule.requirement, { kind: 'element', block: { groups: [{ combinator: 'AND', rules: [
    { kind: 'quantity', setName: 'Qto_DoorBaseQuantities', quantityName: 'Width', op: 'gte', value: 0.9, valueUnit: 'si' }] }], authoredAs: 'chips' } });
  assert.match(rule.description ?? '', /^Statement B\nSource requirement B from S1 "Spec" \(revision [0-9a-f]{16}, \d+ characters\), characters \d+-\d+: "at least 900 mm"\. Stated unit: mm\.$/);
  assert.equal(drafts.ids, null);
  assert.deepEqual(drafts.document?.unsupported, [{ text: 'Doors look good', reason: 'Not extracted as a requirement: No measurable criterion' }],
    'items P16 could not extract stay listed');
});

test('#7375 a draft over its native limit is refused for that target only', () => {
  const many = Array.from({ length: 51 }, (_, index) => door(`A${index}`, { property: 'Pset_DoorCommon.FireRating', operator: 'exists' }));
  const { draft } = qualify([...many, door('B', { property: 'Qto_DoorBaseQuantities.Width', operator: 'atLeast', value: 900, unit: 'mm' }, 'at least 900 mm')]);
  const drafts = draft(new Set());
  assert.equal(drafts.ids, null);
  assert.deepEqual(drafts.refused.map(item => item.target), ['ids']);
  assert.match(drafts.refused[0].detail, /At most 50 specifications/);
  assert.equal(drafts.rules?.ruleSet.rules.length, 1);
  assert.equal(draft(new Set(many.map(item => item.id))).ids, null, 'excluding them leaves no IDS draft');
});

test('#7375 a quantity rule needs the stated unit to measure what the schema says the quantity measures', () => {
  const quoted = 'at least 900 mm';
  const { rows } = qualify([
    door('W', { property: 'Qto_WallBaseQuantities.Width', operator: 'atLeast', value: 150, unit: 'mm²' }, quoted),
    door('G', { property: 'Qto_WallBaseQuantities.GrossWeight', operator: 'atLeast', value: 5, unit: 'm3' }, quoted),
    door('N', { property: 'Qto_SlabBaseQuantities.NetArea', operator: 'atMost', value: 20, unit: 'm' }, quoted),
    door('U', { property: 'Qto_WallBaseQuantities.Thickness', operator: 'atLeast', value: 150, unit: 'mm' }, quoted),
    door('L', { property: 'Qto_WallBaseQuantities.Width', operator: 'atLeast', value: 0.15, unit: 'm' }, quoted),
    door('A', { property: 'Qto_SlabBaseQuantities.NetArea', operator: 'atMost', value: 20, unit: 'm²' }, quoted),
    door('X', { property: 'Pset_DoorCommon.FireRating', operator: 'exists', unit: 'mm' }),
  ]);
  assert.deepEqual(rows.map(row => [row.requirement.id, row.target, row.reason ?? null]), [
    ['W', 'unresolved', 'dimension'], ['G', 'unresolved', 'dimension'], ['N', 'unresolved', 'dimension'], ['U', 'unresolved', 'unknown'],
    ['L', 'geometry', null], ['A', 'geometry', null], ['X', 'unresolved', 'unit'],
  ]);
});

test('#7375 unsupported items keep the passage they cite, verified with its revision or labelled unverified', () => {
  const { draft } = qualify([], [
    { text: 'Doors look good', reason: 'No measurable criterion', span: span('Door names match') },
    { text: 'Doors look fine', reason: 'Vague', span: { ...span('Door names match'), start: 0, end: 16 } },
  ]);
  const [verified, unverified] = draft().document!.unsupported.map(item => item.text);
  const at = TEXT.indexOf('Door names match');
  assert.equal(verified, `Doors look good\nSource passage from S1 "Spec" (revision ${textRevision(TEXT)}, ${TEXT.length} characters), characters ${at}-${at + 16}: "Door names match".`);
  assert.equal(unverified, 'Doors look fine\nCited from S1, characters 0-16: "Door names match" (not verified against the attached text).');
});

test('#7375 with no IFC version IDS can check, the IDS draft is refused rather than retargeted', () => {
  const { draft } = qualify([door('A', { property: 'Pset_DoorCommon.FireRating', operator: 'equals', value: 'EI30' })]);
  const drafts = draft(new Set(), []);
  assert.equal(drafts.ids, null);
  assert.deepEqual(drafts.refused.map(item => item.target), ['ids']);
  assert.match(drafts.refused[0].detail, /none of the loaded models has an IFC version IDS can check/);
});

test('#7375 an IDS check on a measured value states the type the schema declares, for every operator', async () => {
  const quoted = 'at least 900 mm';
  const { rows, draft } = qualify([
    door('Q', { appliesTo: { ifcClass: 'IfcWall' }, property: 'Qto_WallBaseQuantities.Width', operator: 'oneOf', value: [150, 200], unit: 'mm²' }, quoted),
    door('R', { appliesTo: { ifcClass: 'IfcWall' }, property: 'Qto_WallBaseQuantities.Width', operator: 'oneOf', value: [150, 200], unit: 'mm' }, quoted),
    door('T', { appliesTo: { ifcClass: 'IfcWindow' }, property: 'Pset_DoorWindowGlazingType.GlassThickness1', operator: 'atLeast', value: 6, unit: 'mm' }, quoted),
    door('S', { appliesTo: { ifcClass: 'IfcSpace' }, property: 'Pset_SpaceCommon.GrossPlannedArea', operator: 'atLeast', value: 20, unit: 'm' }, quoted),
    door('P', { appliesTo: { ifcClass: 'IfcSpace' }, property: 'Pset_SpaceCommon.GrossPlannedArea', operator: 'atLeast', value: 20, unit: 'm²' }, quoted),
    door('K', { property: 'Pset_DoorCommon.NoSuchWidth', operator: 'atLeast', value: 900, unit: 'mm' }, quoted),
    door('C', { property: 'Acme_Door.ClearWidth', operator: 'atLeast', value: 900, unit: 'mm' }, quoted),
  ], [], ['IFC4X3_ADD2']);
  assert.deepEqual(rows.map(row => [row.requirement.id, row.target, row.reason ?? null, row.typed?.dataType ?? null]), [
    ['Q', 'unresolved', 'dimension', null], ['R', 'ids', null, 'IFCLENGTHMEASURE'], ['T', 'ids', null, 'IFCPOSITIVELENGTHMEASURE'],
    ['S', 'unresolved', 'dimension', null], ['P', 'ids', null, 'IFCAREAMEASURE'], ['K', 'unresolved', 'unknown', null],
    ['C', 'ids', null, 'IFCLENGTHMEASURE'],
  ]);
  const ids = draft().ids!;
  const facets = ids.document.specifications.map(spec => spec.requirements[0].facet);
  assert.deepEqual(facets.map(facet => 'dataType' in facet && facet.dataType?.type === 'simpleValue' ? facet.dataType.value : null), ['IFCLENGTHMEASURE', 'IFCPOSITIVELENGTHMEASURE', 'IFCAREAMEASURE', 'IFCLENGTHMEASURE']);
  const errors = (await auditIdsDraft(buildIdsDraft(ids))).filter(issue => issue.severity === 'error');
  assert.deepEqual(errors, [], 'the native audit accepts every dispatched specification');
});

test('#7375 the declared type is the one of every IFC version the IDS draft targets', async () => {
  const quoted = 'at least 900 mm';
  const silencer = (id: string) => door(id, { appliesTo: { ifcClass: 'IfcDuctSilencerType' }, property: 'Pset_DuctSilencerTypeCommon.Length',
    operator: 'atLeast', value: 500, unit: 'mm' }, quoted);
  const typed = (versions: IFCVersion[]) => qualify([silencer('L')], [], versions).rows.map(row => [row.target, row.reason ?? null, row.typed?.dataType ?? null])[0];
  // IFC4 and IFC2X3 declare a plain length; IFC4X3 a positive one. One IDS specification carries one dataType for all its versions.
  assert.deepEqual(typed(['IFC4']), ['ids', null, 'IFCLENGTHMEASURE']);
  assert.deepEqual(typed(['IFC2X3', 'IFC4']), ['ids', null, 'IFCLENGTHMEASURE']);
  assert.deepEqual(typed(['IFC4X3_ADD2']), ['ids', null, 'IFCPOSITIVELENGTHMEASURE']);
  assert.deepEqual(typed(['IFC2X3', 'IFC4X3_ADD2']), ['unresolved', 'version', null]);
  // The generated tables define quantity sets for IFC4X3 only: an IDS check on one cannot be typed for IFC4.
  const width = door('W', { appliesTo: { ifcClass: 'IfcWall' }, property: 'Qto_WallBaseQuantities.Width', operator: 'oneOf', value: [150, 200], unit: 'mm' }, quoted);
  assert.equal(qualify([width], [], ['IFC4']).rows[0].reason, 'version');
  // An information rule compares in SI whatever the version.
  const rule = door('R', { appliesTo: { ifcClass: 'IfcWall' }, property: 'Qto_WallBaseQuantities.Width', operator: 'atLeast', value: 150, unit: 'mm' }, quoted);
  assert.equal(qualify([rule], [], ['IFC4']).rows[0].target, 'geometry');
  const { draft } = qualify([silencer('L')], [], ['IFC4']);
  const ids = draft().ids!;
  const errors = (await auditIdsDraft(buildIdsDraft(ids))).filter(issue => issue.severity === 'error' || issue.code === 'W_IFC_DATATYPE_MISMATCH');
  assert.deepEqual(errors, [], 'the IFC4 draft states the IFC4 type');
});

test('#7375 a value without its unit, or of the wrong type, never reaches an IDS check', () => {
  const quoted = 'at least 900 mm';
  const { rows } = qualify([
    door('A', { appliesTo: { ifcClass: 'IfcSpace' }, property: 'Pset_SpaceCommon.GrossPlannedArea', operator: 'atLeast', value: 20 }, quoted),
    door('B', { appliesTo: { ifcClass: 'IfcWall' }, property: 'Pset_WallCommon.IsExternal', operator: 'equals', value: true }, quoted),
    door('C', { appliesTo: { ifcClass: 'IfcWall' }, property: 'Pset_WallCommon.FireRating', operator: 'equals', value: true }, quoted),
    door('D', { appliesTo: { ifcClass: 'IfcArbitraryClosedProfileDef' }, property: 'Pset_ProfileArbitraryDoubleT.FlangeChamfer', operator: 'atLeast', value: 5, unit: 'mm' }, quoted),
    door('E', { appliesTo: { ifcClass: 'IfcWall' }, property: 'Acme_Wall.Checked', operator: 'equals', value: true }, quoted),
    // A declared boolean compared with a number or text: the value does not fit, so it never becomes an untyped IDS check.
    door('F', { appliesTo: { ifcClass: 'IfcWall' }, property: 'Pset_WallCommon.IsExternal', operator: 'equals', value: 1 }, quoted),
    door('G', { appliesTo: { ifcClass: 'IfcWall' }, property: 'Pset_WallCommon.IsExternal', operator: 'oneOf', value: ['yes', 'no'] }, quoted),
  ]);
  assert.deepEqual(rows.map(row => [row.requirement.id, row.target, row.reason ?? null, row.typed?.dataType ?? null]), [
    ['A', 'unresolved', 'unit', null], ['B', 'ids', null, 'IFCBOOLEAN'], ['C', 'unresolved', 'value', null],
    ['D', 'unresolved', 'measure', null], ['E', 'ids', null, 'IFCBOOLEAN'], ['F', 'unresolved', 'value', null], ['G', 'unresolved', 'value', null],
  ]);
});

test('#7375 an IDS check names a property every targeted IFC version defines, whatever its value', () => {
  const quoted = 'at least 900 mm';
  const rows = (requirements: object[], versions: IFCVersion[]) => qualify(requirements, [], versions).rows.map(row => [row.requirement.id, row.target, row.reason ?? null]);
  assert.deepEqual(rows([
    door('A', { property: 'Pset_DoorCommon.NoSuchWidth', operator: 'equals', value: 'EI30' }),
    door('B', { property: 'Pset_DoorCommon.NoSuchWidth', operator: 'exists' }),
    door('C', { property: 'Acme_Door.NoSuchWidth', operator: 'equals', value: 'EI30' }),
    door('D', { appliesTo: { ifcClass: 'IfcWall' }, property: 'Qto_WallBaseQuantities.Width', operator: 'exists' }, quoted),
  ], ['IFC4']), [['A', 'unresolved', 'unknown'], ['B', 'unresolved', 'unknown'], ['C', 'ids', null], ['D', 'unresolved', 'version']]);
  assert.deepEqual(rows([door('D', { appliesTo: { ifcClass: 'IfcWall' }, property: 'Qto_WallBaseQuantities.Width', operator: 'exists' }, quoted)], ['IFC4X3_ADD2']),
    [['D', 'ids', null]]);
});

test('#7375 a value without its unit on any measure the validator converts to SI never reaches an IDS check', () => {
  const quoted = 'at least 900 mm';
  const rows = qualify([
    door('A', { appliesTo: { ifcClass: 'IfcActuatorType' }, property: 'Pset_ActuatorTypeRotationalActuation.RangeAngle', operator: 'atMost', value: 6 }, quoted),
    door('T', { appliesTo: { ifcClass: 'IfcSystem' }, property: 'Pset_AirSideSystemInformation.CoolingTemperatureDelta', operator: 'atLeast', value: 5 }, quoted),
    door('M', { appliesTo: { ifcClass: 'IfcCableSegment' }, property: 'Pset_CableSegmentTypeCableSegment.Weight', operator: 'atMost', value: 2 }, quoted),
    door('S', { appliesTo: { ifcClass: 'IfcController' }, property: 'Pset_ControllerTypeFloating.SignalTime', operator: 'atMost', value: 2 }, quoted),
    door('N', { appliesTo: { ifcClass: 'IfcWindow' }, property: 'Pset_DoorWindowGlazingType.GlassThickness1', operator: 'equals', value: '6' }, quoted),
    door('U', { appliesTo: { ifcClass: 'IfcWindow' }, property: 'Pset_DoorWindowGlazingType.GlassThickness1', operator: 'oneOf', value: ['6 mm', '8 mm'] }, quoted),
    door('P', { appliesTo: { ifcClass: 'IfcWindow' }, property: 'Pset_DoorWindowGlazingType.GlassThickness1', operator: 'matches', value: '6.*' }, quoted),
    door('C', { appliesTo: { ifcClass: 'IfcActor' }, property: 'Pset_ActorCommon.NumberOfActors', operator: 'atLeast', value: 2 }, quoted),
  ]).rows;
  assert.deepEqual(rows.map(row => [row.requirement.id, row.target, row.reason ?? null]), [
    ['A', 'unresolved', 'unit'], ['T', 'unresolved', 'unit'], ['M', 'unresolved', 'unit'], ['S', 'unresolved', 'unit'],
    ['N', 'unresolved', 'unit'], ['U', 'unresolved', 'unit'], ['P', 'unresolved', 'value'], ['C', 'ids', null],
  ]);
});

test('#7375 an enumerated standard property is known to the schema, and its values are labels', () => {
  const rows = qualify([
    door('E', { appliesTo: { ifcClass: 'IfcWall' }, property: 'Pset_WallCommon.Status', operator: 'equals', value: 'NEW' }),
    door('B', { appliesTo: { ifcClass: 'IfcWall' }, property: 'Pset_WallCommon.Status', operator: 'equals', value: true }),
    door('X', { appliesTo: { ifcClass: 'IfcWall' }, property: 'Pset_WallCommon.Status', operator: 'exists' }),
  ]).rows;
  assert.deepEqual(rows.map(row => [row.requirement.id, row.target, row.reason ?? null]), [['E', 'ids', null], ['B', 'unresolved', 'value'], ['X', 'ids', null]]);
});
