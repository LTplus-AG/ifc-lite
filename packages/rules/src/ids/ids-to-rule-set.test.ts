/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `idsToRuleSet` (#5225): simple IDS specifications import as rules that
 * the rule-set loader accepts; a facet without a rule equivalent blocks
 * its specification with a named reason; a simple spec round-trips.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { parseIDS } from '@ifc-lite/ids';
import { parseRuleSetFile } from '../rule-set/rule-set-io.js';

// The changed-test oracle deletes new production files before re-running
// this test. Load them at runtime so a missing module fails an assertion
// instead of preventing collection (same pattern as
// `packages/mutations/src/effective-entity-enumeration.test.ts`).
const fromIdsPath = './ids-to-rule-set.js';
const fromIds: typeof import('./ids-to-rule-set.js') | null = await import(fromIdsPath).catch(() => null);
const toIdsPath = './rule-set-to-ids.js';
const toIds: typeof import('./rule-set-to-ids.js') | null = await import(toIdsPath).catch(() => null);
function idsToRuleSet(...args: Parameters<typeof import('./ids-to-rule-set.js').idsToRuleSet>): ReturnType<typeof import('./ids-to-rule-set.js').idsToRuleSet> {
  assert.ok(fromIds, './ids-to-rule-set.js must exist');
  return fromIds.idsToRuleSet(...args);
}
function ruleSetToIds(...args: Parameters<typeof import('./rule-set-to-ids.js').ruleSetToIds>): ReturnType<typeof import('./rule-set-to-ids.js').ruleSetToIds> {
  assert.ok(toIds, './rule-set-to-ids.js must exist');
  return toIds.ruleSetToIds(...args);
}

function ids(specifications: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd">
  <info><title>BEP deliverable</title></info>
  <specifications>${specifications}</specifications>
</ids>`;
}

const WALLS = '<applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>';

function spec(requirements: string, applicability = WALLS, attrs = ''): string {
  return `<specification name="S" ifcVersion="IFC2X3 IFC4 IFC4X3_ADD2" ${attrs}>${applicability}<requirements>${requirements}</requirements></specification>`;
}

const SIMPLE_SPEC = ids(`
  <specification name="Walls are rated" ifcVersion="IFC2X3 IFC4 IFC4X3_ADD2" identifier="EIR-001" description="Fire rating">
    <applicability minOccurs="1" maxOccurs="unbounded">
      <entity><name><simpleValue>IFCWALL</simpleValue></name><predefinedType><simpleValue>SHEAR</simpleValue></predefinedType></entity>
      <property><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet><baseName><simpleValue>IsExternal</simpleValue></baseName><value><simpleValue>TRUE</simpleValue></value></property>
    </applicability>
    <requirements>
      <property cardinality="required"><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet><baseName><simpleValue>FireRating</simpleValue></baseName>
        <value><xs:restriction base="xs:string"><xs:enumeration value="REI60"/><xs:enumeration value="REI90"/></xs:restriction></value></property>
      <attribute cardinality="required"><name><simpleValue>Name</simpleValue></name><value><xs:restriction base="xs:string"><xs:pattern value="W-\\d{3}"/></xs:restriction></value></attribute>
      <property cardinality="required"><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet><baseName><simpleValue>ThermalTransmittance</simpleValue></baseName>
        <value><xs:restriction base="xs:double"><xs:minInclusive value="0.1"/><xs:maxExclusive value="0.3"/></xs:restriction></value></property>
      <material cardinality="required"/>
      <classification cardinality="required"><system><simpleValue>Uniclass 2015</simpleValue></system></classification>
    </requirements>
  </specification>`);

describe('idsToRuleSet — simple specifications (#5225)', () => {
  it('imports entity/attribute/property/material/classification facets as rules the loader accepts', () => {
    const result = idsToRuleSet(parseIDS(SIMPLE_SPEC), { newId: () => 'generated' });
    assert.deepEqual(result.refused, []);
    assert.ok(result.file);
    assert.equal(result.file.name, 'BEP deliverable');

    const [rule] = result.file.rules;
    assert.equal(rule.id, 'EIR-001');
    assert.equal(rule.name, 'Walls are rated');
    assert.equal(rule.description, 'Fire rating');
    assert.deepEqual(rule.cardinality, { minApplicable: 1 });
    assert.deepEqual(rule.applicability.groups[0].rules, [
      { kind: 'ifcType', op: 'in', values: ['IfcWall'], exactClass: true },
      { kind: 'predefinedType', op: 'in', values: ['SHEAR'] },
      { kind: 'property', setName: 'Pset_WallCommon', propertyName: 'IsExternal', op: 'eq', value: 'TRUE', setNameKind: 'literal', propertyNameKind: 'literal' },
    ]);
    assert.equal(rule.requirement.kind, 'element');
    const req = rule.requirement.kind === 'element' ? rule.requirement.block.groups[0].rules : [];
    assert.deepEqual(req, [
      { kind: 'property', setName: 'Pset_WallCommon', propertyName: 'FireRating', op: 'matches', value: '/^(?:REI60|REI90)$/u', setNameKind: 'literal', propertyNameKind: 'literal' },
      { kind: 'attribute', name: 'Name', op: 'matches', value: '/^(?:W-\\p{Nd}{3})$/u' },
      { kind: 'property', setName: 'Pset_WallCommon', propertyName: 'ThermalTransmittance', op: 'gte', value: '0.1', setNameKind: 'literal', propertyNameKind: 'literal' },
      { kind: 'property', setName: 'Pset_WallCommon', propertyName: 'ThermalTransmittance', op: 'lt', value: '0.3', setNameKind: 'literal', propertyNameKind: 'literal' },
      { kind: 'material', op: 'matches', value: '.', valueKind: 'regex' },
      { kind: 'classification', system: 'Uniclass 2015', op: 'isSet', value: '' },
    ]);

    const reparsed = parseRuleSetFile(JSON.parse(JSON.stringify(result.file)));
    assert.equal(reparsed.ok, true, reparsed.ok ? '' : reparsed.error);
  });

  it('imports a Qto_ property facet as a quantity rule', () => {
    const result = idsToRuleSet(parseIDS(ids(spec(
      '<property cardinality="required"><propertySet><simpleValue>Qto_WallBaseQuantities</simpleValue></propertySet><baseName><simpleValue>Width</simpleValue></baseName><value><xs:restriction base="xs:double"><xs:minInclusive value="0.2"/></xs:restriction></value></property>',
    ))), { newId: () => 'q' });
    const rules = result.file!.rules[0].requirement.kind === 'element' ? result.file!.rules[0].requirement.block.groups[0].rules : [];
    assert.deepEqual(rules, [{ kind: 'quantity', setName: 'Qto_WallBaseQuantities', quantityName: 'Width', op: 'gte', value: 0.2, setNameKind: 'literal', quantityNameKind: 'literal' }]);
  });

  it('notes that a version-limited specification now runs on every model', () => {
    const result = idsToRuleSet(parseIDS(ids(
      `<specification name="S" ifcVersion="IFC4">${WALLS}<requirements><attribute cardinality="required"><name><simpleValue>Description</simpleValue></name></attribute></requirements></specification>`,
    )), { newId: () => 'v' });
    assert.ok(result.file);
    assert.ok(result.notes.some((n) => /every model/.test(n)));
  });
});

describe('idsToRuleSet — blocks what has no rule equivalent, with the reason (#5225)', () => {
  const property = (inner: string, attrs = 'cardinality="required"') =>
    `<property ${attrs}><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet><baseName><simpleValue>FireRating</simpleValue></baseName>${inner}</property>`;
  const cases: Array<[string, string, RegExp]> = [
    ['partOf', spec('<partOf relation="IFCRELAGGREGATES" cardinality="required"><entity><name><simpleValue>IFCBUILDINGSTOREY</simpleValue></name></entity></partOf>'), /partOf facet/],
    ['prohibited facet', spec(property('', 'cardinality="prohibited"')), /prohibited property facet/],
    ['optional facet', spec(property('', 'cardinality="optional"')), /optional property facet/],
    ['dataType', spec(property('', 'cardinality="required" dataType="IFCLABEL"')), /dataType check/],
    ['entity name pattern', spec('<attribute cardinality="required"><name><simpleValue>Description</simpleValue></name></attribute>',
      '<applicability><entity><name><xs:restriction base="xs:string"><xs:pattern value="IFCWALL.*"/></xs:restriction></name></entity></applicability>'),
    /entity name given as a pattern restriction/],
    ['attribute name pattern', spec('<attribute cardinality="required"><name><xs:restriction base="xs:string"><xs:pattern value="Desc.*"/></xs:restriction></name></attribute>'),
      /attribute name given as a pattern restriction/],
    ['length restriction', spec(property('<value><xs:restriction base="xs:string"><xs:minLength value="3"/></xs:restriction></value>')), /length and digit restrictions/],
    ['classification code', spec('<classification cardinality="required"><value><simpleValue>Ss_25</simpleValue></value></classification>'), /classification code check/],
    ['entity in requirements', spec('<entity><name><simpleValue>IFCWALL</simpleValue></name></entity>'), /entity facet in the requirements/],
    ['no requirements', `<specification name="S" ifcVersion="IFC4">${WALLS}</specification>`, /without requirements/],
    ['untranslatable XSD regex', spec(property('<value><xs:restriction base="xs:string"><xs:pattern value="\\p{IsBasicLatin}+"/></xs:restriction></value>')),
      /IsBasicLatin/],
  ];

  for (const [label, specXml, reason] of cases) {
    it(`blocks ${label}`, () => {
      const result = idsToRuleSet(parseIDS(ids(specXml)), { newId: () => 'x' });
      assert.equal(result.file, null);
      assert.equal(result.refused.length, 1);
      const { reasons } = result.refused[0];
      assert.ok(reasons.some((r) => reason.test(r)), `expected a reason matching ${reason}, got ${JSON.stringify(reasons)}`);
    });
  }
});

describe('round trip (#5225)', () => {
  it('a simple spec survives IDS → rules → IDS unchanged', () => {
    const original = parseIDS(SIMPLE_SPEC);
    const imported = idsToRuleSet(original, { newId: () => 'unused' });
    const exported = ruleSetToIds(imported.file!, { ifcVersions: ['IFC2X3', 'IFC4', 'IFC4X3_ADD2'] });
    assert.deepEqual(exported.refused, []);
    const back = parseIDS(exported.xml!);

    const [a] = original.specifications;
    const [b] = back.specifications;
    assert.equal(b.name, a.name);
    assert.equal(b.identifier, a.identifier);
    assert.equal(b.minOccurs, a.minOccurs);
    assert.deepEqual(JSON.parse(JSON.stringify(b.applicability.facets)), JSON.parse(JSON.stringify(a.applicability.facets)));
    // Facet order and content survive; only the XSD spelling of `\d` moves
    // to its exact Unicode category (`\p{Nd}`), which is the same class.
    const normalise = (facets: typeof a.requirements) => facets.map((r) => JSON.stringify(r.facet).replace('\\\\p{Nd}', '\\\\d'));
    assert.deepEqual(normalise(b.requirements), normalise(a.requirements).map((f) => f
      // An enumeration imports as one anchored alternation and exports back as a pattern.
      .replace('{"type":"enumeration","values":["REI60","REI90"],"base":"xs:string"}', '{"type":"pattern","pattern":"REI60|REI90","base":"xs:string"}')));
  });

  it('a simple rule survives rules → IDS → rules unchanged', () => {
    const file = {
      version: 1 as const,
      name: 'Checks',
      rules: [{
        id: 'r1',
        name: 'Rated walls',
        applicability: { groups: [{ rules: [{ kind: 'ifcType' as const, op: 'in' as const, values: ['IfcWall'], exactClass: true }], combinator: 'AND' as const }], authoredAs: 'chips' as const },
        requirement: {
          kind: 'element' as const,
          block: {
            groups: [{
              rules: [
                { kind: 'property' as const, setName: 'Pset_WallCommon', propertyName: 'FireRating', op: 'eq' as const, value: 'REI60', setNameKind: 'literal' as const, propertyNameKind: 'literal' as const },
                { kind: 'attribute' as const, name: 'Description', op: 'isSet' as const, value: '' },
              ],
              combinator: 'AND' as const,
            }],
            authoredAs: 'chips' as const,
          },
        },
      }],
    };
    const exported = ruleSetToIds(file);
    const imported = idsToRuleSet(parseIDS(exported.xml!));
    assert.deepEqual(imported.file, file);
  });
});
