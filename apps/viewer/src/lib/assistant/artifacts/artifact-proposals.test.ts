/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Strict parsers for the four artifact proposal kinds (viewer AI P13, #6914). */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IfcTypeEnum } from '@ifc-lite/data';
import { elementFieldColumnId, validateChartSpec } from '@ifc-lite/charts';
import type { FilterRule } from '@ifc-lite/rules';
import { declaredArtifactKind, parseArtifactProposal } from './proposal-kinds';
import { parseFilterProposal } from './filter-proposal';
import { parseListProposal } from './list-proposal';
import { parseLensProposal } from './lens-proposal';
import { parseChartProposal, resolveChartSpec } from './chart-proposal';

const json = (value: unknown) => JSON.stringify(value);
const walls = { combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }] };

test('a filter proposal becomes native Rules groups with canonical classes and SI thresholds', () => {
  const proposal = parseFilterProposal(`\`\`\`json\n${json({ version: 1, kind: 'filter.proposal', title: 'Large walls', name: 'Large walls',
    groups: [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] },
      { kind: 'quantity', setName: 'Qto_WallBaseQuantities', quantityName: 'NetSideArea', op: 'gt', value: 10 },
      { kind: 'property', setName: 'Pset_WallCommon', propertyName: 'IsExternal', op: 'eq', value: true }] }] })}\n\`\`\``);
  const [type, quantity, property] = proposal.groups[0].rules;
  assert.equal(type.kind, 'ifcType');
  assert.ok(type.kind === 'ifcType' && type.values.includes('IfcWall') && type.values.includes('IfcWallStandardCase'), 'a class names its subclasses, as the selector does');
  assert.deepEqual(quantity, { kind: 'quantity', setName: 'Qto_WallBaseQuantities', quantityName: 'NetSideArea', op: 'gt', value: 10, valueUnit: 'si' });
  assert.equal(property.kind === 'property' && property.value, 'TRUE', 'an IFC boolean reads as its STEP spelling');
  assert.equal(property.kind === 'property' && property.valueUnit, undefined, 'a boolean equality is not a unit-bearing comparison');
});

test('a numeric property equality is SI like every numeric threshold; text stays as stored (#6914 review)', () => {
  const rule = (op: string, value: unknown) => parseFilterProposal(json({ version: 1, kind: 'filter.proposal', title: 'T', name: 'N',
    groups: [{ combinator: 'AND', rules: [{ kind: 'property', setName: 'Pset_Dims', propertyName: 'Height', op, value }] }] })).groups[0].rules[0];
  assert.deepEqual(rule('eq', 2.5), { kind: 'property', setName: 'Pset_Dims', propertyName: 'Height', op: 'eq', value: '2.5', valueUnit: 'si' });
  const unit = (parsed: FilterRule) => parsed.kind === 'property' ? parsed.valueUnit : 'not a property rule';
  assert.equal(unit(rule('ne', 3)), 'si');
  assert.equal(unit(rule('eq', 'EI60')), undefined, 'a text equality compares the stored text');
  assert.equal(unit(rule('gte', '2')), 'si');
});

test('a model rule names loaded models; they stay names until the review resolves them', () => {
  const proposal = parseFilterProposal(json({ version: 1, kind: 'filter.proposal', title: 'T', name: 'N',
    groups: [{ combinator: 'AND', rules: [{ kind: 'model', op: 'in', values: ['hello-wall.ifc'] }] }] }));
  assert.deepEqual(proposal.groups[0].rules[0], { kind: 'model', op: 'in', values: ['hello-wall.ifc'] });
  assert.throws(() => parseListProposal(json({ version: 1, kind: 'list.proposal', title: 'T', scope: 'selected',
    list: { name: 'L', columns: [{ id: 'a', source: 'attribute', propertyName: 'Name' }] } })), /list\.proposal runs over every loaded model/);
});

test('filter proposals refuse with reasons a person can act on', () => {
  const refuse = (groups: unknown, pattern: RegExp, extra: Record<string, unknown> = {}) => assert.throws(
    () => parseFilterProposal(json({ version: 1, kind: 'filter.proposal', title: 'T', name: 'N', groups, ...extra })), pattern);
  refuse([{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWal'] }] }], /"IfcWal" is not an IFC class name/);
  refuse([{ combinator: 'AND', rules: [{ kind: 'modelTag', op: 'in', tagIds: ['t'] }] }], /Model tags are user-defined/);
  // "Visible" and "selected" are runtime states a saved filter cannot hold; a proposal claiming one is refused, never broadened.
  refuse([walls], /runs over every loaded model.*"visible" and "selected"/, { scope: 'visible' });
  refuse([{ combinator: 'AND', rules: [{ kind: 'name', op: 'matches', value: '^W' }] }], /"op" must be one of eq, ne, contains/);
  refuse([{ combinator: 'AND', rules: [{ kind: 'quantity', setName: 'Q', quantityName: 'A', op: 'gt', value: '10 m2' }] }], /finite number \(SI units/);
  // `Number('')` is 0: an empty or blank threshold is refused, never saved as a fabricated zero (#6914 review).
  for (const value of ['', '  ', 'ten']) {
    refuse([{ combinator: 'AND', rules: [{ kind: 'property', setName: 'S', propertyName: 'P', op: 'gt', value }] }], /compares with "gt", so "value" must be a number/);
  }
  refuse([{ combinator: 'XOR', rules: [] }], /"combinator" must be AND or OR/);
  refuse([walls], /unsupported field "selector"/, { selector: 'IfcWall' });
  refuse([], /at least one filter group/);
  assert.throws(() => parseFilterProposal(json({ kind: 'filter.proposal', title: 'T', groups: [walls] })), /"version": 1/);
  assert.throws(() => parseFilterProposal('Here is a filter: {"kind":"filter.proposal"}'), /not one complete JSON object/);
});

test('a list proposal is a ListDefinition draft: exact classes, Lists column contract and grouping by column id', () => {
  const proposal = parseListProposal(json({ version: 1, kind: 'list.proposal', title: 'Wall areas', list: { name: 'Wall areas',
    entityTypes: ['IfcWall'], groups: [], columns: [
      { id: 'name', source: 'attribute', propertyName: 'Name' },
      { id: 'storey', source: 'spatial', propertyName: 'Storey' },
      { id: 'area', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'NetSideArea', label: 'Area' }],
    grouping: { columnIds: ['storey'], sumColumnIds: ['area'], view: 'schedule' }, sortBy: { columnId: 'area', direction: 'desc' } } }));
  assert.ok(proposal.list.entityTypes.includes(IfcTypeEnum.IfcWall));
  assert.ok(proposal.list.entityTypes.includes(IfcTypeEnum.IfcWallStandardCase), 'Lists target exact classes, so subclasses are listed');
  assert.deepEqual(proposal.list.grouping, { columnId: 'storey', columnIds: ['storey'], sumColumnIds: ['area'], view: 'schedule' });
  assert.equal(proposal.list.columns[2].label, 'Area');
  const list = (patch: Record<string, unknown>) => json({ version: 1, kind: 'list.proposal', title: 'T', list: { name: 'L', columns: [{ id: 'a', source: 'attribute', propertyName: 'Name' }], ...patch } });
  assert.throws(() => parseListProposal(list({ columns: [{ id: 'z', source: 'zone', psetName: 'set', propertyName: 'Zone' }] })), /"source" must be one of/);
  assert.throws(() => parseListProposal(list({ columns: [{ id: 'a', source: 'attribute', propertyName: 'Name' }, { id: 'a', source: 'material', propertyName: '' }] })), /repeats the column id "a"/);
  assert.throws(() => parseListProposal(list({ grouping: { columnIds: ['missing'] } })), /"missing", which is not a column id/);
  assert.throws(() => parseListProposal(list({ entityTypes: ['IfcActor'] })), /Lists cannot target IfcActor/);
  assert.throws(() => parseListProposal(list({ columns: [{ id: 'a', source: 'attribute', propertyName: 'FireRating' }] })), /attribute must be one of Name/);
});

test('a lens proposal is either first-match rules or one auto-colour spec, never both', () => {
  const rules = parseLensProposal(json({ version: 1, kind: 'lens.proposal', title: 'External', lens: { name: 'External', rules: [
    { name: 'External walls', groups: [walls], action: 'colorize', color: '#e53935' }, { name: 'Hidden', groups: [walls], action: 'hide' }] } }));
  assert.deepEqual(rules.lens.rules.map((rule) => [rule.id, rule.color, rule.enabled]), [['rule-1', '#E53935', true], ['rule-2', '#1E88E5', true]]);
  const auto = parseLensProposal(json({ version: 1, kind: 'lens.proposal', title: 'By rating', lens: { name: 'By rating',
    autoColor: { source: 'property', psetName: 'Pset_SlabCommon', propertyName: 'FireRating' } } }));
  assert.deepEqual(auto.lens, { name: 'By rating', rules: [], autoColor: { source: 'property', psetName: 'Pset_SlabCommon', propertyName: 'FireRating' } });
  assert.throws(() => parseLensProposal(json({ version: 1, kind: 'lens.proposal', title: 'T', lens: { name: 'L', rules: [], autoColor: { source: 'ifcType' } } })), /either "rules" or "autoColor"/);
  assert.throws(() => parseLensProposal(json({ version: 1, kind: 'lens.proposal', title: 'T', lens: { name: 'L', rules: [{ name: 'R', groups: [walls], action: 'colorize', color: 'red' }] } })), /#RRGGBB/);
});

test('an elements chart proposal names fields by identity and resolves to a valid native ChartSpec', () => {
  const proposal = parseChartProposal(json({ version: 1, kind: 'chart.proposal', title: 'Slab area by class', scope: 'visible', chart: {
    type: 'bar', dimension: 'IfcType', measure: { agg: 'sum' }, measureField: { kind: 'quantity', qsetName: 'Qto_SlabBaseQuantities', quantityName: 'NetArea' },
    filter: { groups: [walls] }, topN: 5 } }));
  assert.deepEqual(proposal.scope, { kind: 'visible' });
  const binding = { kind: 'quantity' as const, qsetName: 'Qto_SlabBaseQuantities', quantityName: 'NetArea', valueKind: 'number' as const, dataType: 'IFCAREAMEASURE' };
  const spec = resolveChartSpec(proposal.chart, 'c1', () => binding);
  assert.deepEqual(validateChartSpec(spec), []);
  assert.deepEqual(spec.measure, { agg: 'sum', column: elementFieldColumnId(binding) }, 'the summed column is the discovered binding, never the answer\'s');
  assert.throws(() => resolveChartSpec(proposal.chart, 'c1', () => ({ ...binding, valueKind: 'category' })), /not numeric in the loaded models/);
  const chart = (patch: Record<string, unknown>) => json({ version: 1, kind: 'chart.proposal', title: 'T', chart: { type: 'bar', dimension: 'Storey', measure: { agg: 'count' }, ...patch } });
  assert.throws(() => parseChartProposal(chart({ source: 'invented7106' })), /Unknown chart source/);
  assert.throws(() => parseChartProposal(chart({ measure: { agg: 'sum' } })), /names the summed field in "measureField"/);
  assert.throws(() => parseChartProposal(chart({ elementField: { kind: 'material' } })), /not both/);
  assert.throws(() => parseChartProposal(chart({ type: 'stackedBar' })), /needs "stackBy"/);
  assert.throws(() => parseChartProposal(chart({ type: 'timeline' })), /"type" must be one of/);
});

test('only an answer declaring an artifact kind reaches the strict parsers', () => {
  assert.equal(declaredArtifactKind('Walls are listed in the evidence.'), null);
  assert.equal(declaredArtifactKind(json({ kind: 'model.changes' })), null);
  const content = json({ version: 1, kind: 'filter.proposal', title: 'Walls', name: 'Walls', groups: [walls] });
  assert.equal(declaredArtifactKind(content), 'filter.proposal');
  assert.equal(parseArtifactProposal(content, 'filter.proposal').kind, 'filter.proposal');
});
