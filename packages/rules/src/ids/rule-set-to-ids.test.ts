/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ruleSetToIds` (#5225): every rule either exports as a specification the
 * IDS tooling reads back and accepts, or is refused with its own reason.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { auditIDSDocument, parseIDS } from '@ifc-lite/ids';
import { Rule, type FilterRule } from '../filter/filter-rules.js';
import type { InformationRule, Requirement, RuleSetFile } from '../rule-set/rule-set.js';

// The changed-test oracle deletes new production files before re-running
// this test. Load them at runtime so a missing module fails an assertion
// instead of preventing collection (same pattern as
// `packages/mutations/src/effective-entity-enumeration.test.ts`).
const toIdsPath = './rule-set-to-ids.js';
const toIds: typeof import('./rule-set-to-ids.js') | null = await import(toIdsPath).catch(() => null);
function ruleSetToIds(...args: Parameters<typeof import('./rule-set-to-ids.js').ruleSetToIds>): ReturnType<typeof import('./rule-set-to-ids.js').ruleSetToIds> {
  assert.ok(toIds, './rule-set-to-ids.js must exist');
  return toIds.ruleSetToIds(...args);
}

const exactWall = (): FilterRule => ({ kind: 'ifcType', op: 'in', values: ['IfcWall'], exactClass: true });

function block(rules: FilterRule[], combinator: 'AND' | 'OR' = 'AND') {
  return { groups: [{ rules, combinator }], authoredAs: 'chips' as const };
}

function rule(requirement: FilterRule[] | Requirement, extra: Partial<InformationRule> = {}): InformationRule {
  return {
    id: 'r1',
    name: 'Walls have a fire rating',
    applicability: block([exactWall()]),
    requirement: Array.isArray(requirement) ? { kind: 'element', block: block(requirement) } : requirement,
    ...extra,
  };
}

/** The parser leaves absent optional fields as `undefined` keys. */
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function file(...rules: InformationRule[]): RuleSetFile {
  return { version: 1, name: 'Handover checks', rules };
}

function onlyReasons(r: InformationRule): string[] {
  const result = ruleSetToIds(file(r));
  assert.equal(result.exportedRuleIds.length, 0, 'expected the rule to be refused');
  assert.equal(result.xml, null);
  assert.equal(result.refused.length, 1);
  return result.refused[0].reasons;
}

describe('ruleSetToIds — exportable rules (#5225)', () => {
  it('exports a property/attribute/material rule set that IDS tooling parses and audits clean', async () => {
    const result = ruleSetToIds(file(
      rule([Rule.property('Pset_WallCommon', 'FireRating', 'eq', '2HR')]),
      rule([Rule.property('Pset_WallCommon', 'IsExternal', 'isSet', '')], { id: 'r2', name: 'IsExternal is set' }),
      rule([Rule.name('matches', '^W-[0-9]{3}$', 'regex')], { id: 'r3', name: 'Wall naming' }),
      rule([Rule.material('contains', 'Concrete')], { id: 'r4', name: 'Concrete walls' }),
      rule(
        [Rule.property('Pset_WallCommon', 'ThermalTransmittance', 'gte', '0.1'), Rule.property('Pset_WallCommon', 'ThermalTransmittance', 'lte', '0.3')],
        { id: 'r5', name: 'U-value in range', cardinality: { minApplicable: 1 } },
      ),
    ));
    assert.deepEqual(result.refused, []);
    assert.deepEqual(result.exportedRuleIds, ['r1', 'r2', 'r3', 'r4', 'r5']);
    assert.ok(result.xml);

    const doc = parseIDS(result.xml);
    assert.equal(doc.info.title, 'Handover checks');
    assert.equal(doc.specifications.length, 5);
    const [fire, isSet, naming, material, range] = doc.specifications;
    assert.deepEqual(clean(fire.applicability.facets), [{ type: 'entity', name: { type: 'simpleValue', value: 'IFCWALL' } }]);
    assert.deepEqual(clean(fire.requirements[0].facet), {
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'Pset_WallCommon' },
      baseName: { type: 'simpleValue', value: 'FireRating' },
      value: { type: 'simpleValue', value: '2HR' },
    });
    assert.equal(fire.requirements[0].optionality, 'required');
    assert.equal(isSet.requirements[0].facet.type === 'property' && isSet.requirements[0].facet.value, undefined);
    assert.deepEqual(clean(naming.requirements[0].facet.type === 'attribute' && naming.requirements[0].facet.value),
      { type: 'pattern', pattern: 'W-[0-9]{3}', base: 'xs:string' });
    assert.deepEqual(clean(material.requirements[0].facet.type === 'material' && material.requirements[0].facet.value),
      { type: 'pattern', pattern: '.*Concrete.*', base: 'xs:string' });
    // The `between` pair folds into ONE restriction; minApplicable 1 = required.
    assert.equal(range.requirements.length, 1);
    const rangeValue = range.requirements[0].facet.type === 'property' ? range.requirements[0].facet.value : undefined;
    assert.equal(rangeValue?.type, 'bounds');
    assert.equal(rangeValue?.type === 'bounds' && rangeValue.minInclusive, 0.1);
    assert.equal(rangeValue?.type === 'bounds' && rangeValue.maxInclusive, 0.3);
    assert.equal(range.minOccurs, 1);

    const audit = await auditIDSDocument(result.xml, { ifcVersion: 'IFC4' });
    const errors = audit.issues.filter((i) => i.severity === 'error');
    assert.deepEqual(errors, [], 'the exported IDS has no audit errors');
  });

  it('carries the rule id and description, and records the SI-units caveat for numeric property checks', () => {
    const result = ruleSetToIds(file(rule([Rule.quantity('Qto_WallBaseQuantities', 'Width', 'gte', 0.2)], { description: 'min width' })));
    const spec = parseIDS(result.xml!).specifications[0];
    assert.equal(spec.identifier, 'r1');
    assert.equal(spec.description, 'min width');
    assert.ok(result.notes.some((n) => /SI units/.test(n)));
  });

  it('notes where a pattern without the u flag can read astral-plane characters differently (review, #5291)', () => {
    const plain = ruleSetToIds(file(rule([Rule.name('matches', '^.$', 'regex')])));
    assert.deepEqual(plain.refused, []);
    assert.ok(plain.notes.some((n) => /Basic Multilingual Plane/.test(n)), 'a bare "." gets the caveat');
    const unicode = ruleSetToIds(file(rule([Rule.name('matches', '/^.$/u')])));
    assert.ok(!unicode.notes.some((n) => /Basic Multilingual Plane/.test(n)), 'the u flag reads whole characters, like IDS');
    const noDot = ruleSetToIds(file(rule([Rule.name('matches', '^W-[0-9]{3}$', 'regex')])));
    assert.ok(!noDot.notes.some((n) => /Basic Multilingual Plane/.test(n)), 'no ".", "[^" or "\\D": nothing to note');
  });

  it('uses the requested ifcVersions', () => {
    const result = ruleSetToIds(file(rule([Rule.property('P', 'X', 'isSet', '')])), { ifcVersions: ['IFC2X3', 'IFC4'] });
    assert.deepEqual(parseIDS(result.xml!).specifications[0].ifcVersions, ['IFC2X3', 'IFC4']);
  });

  it('exports what it can and refuses the rest, per rule', () => {
    const result = ruleSetToIds(file(
      rule([Rule.property('P', 'X', 'isSet', '')]),
      rule({ kind: 'unique', subject: { kind: 'name' } }, { id: 'r2', name: 'Unique names' }),
    ));
    assert.deepEqual(result.exportedRuleIds, ['r1']);
    assert.deepEqual(result.refused.map((r) => r.ruleName), ['Unique names']);
  });
});

describe('ruleSetToIds — refuses each unmappable kind with its own reason (#5225)', () => {
  const cases: Array<[string, InformationRule, RegExp]> = [
    ['unique', rule({ kind: 'unique', subject: { kind: 'name' } }), /"unique" requirement compares values across elements/],
    ['aggregate', rule({ kind: 'aggregate', fn: 'count', op: 'gte', value: 1 }), /"aggregate" requirement totals values/],
    ['compare', rule({ kind: 'compare', left: { kind: 'name' }, right: { kind: 'name' }, op: 'eq' }), /"compare" requirement compares two values of one element/],
    ['unit', rule({ kind: 'unit', subject: { kind: 'quantity', setName: 'Qto_WallBaseQuantities', quantityName: 'Width' }, unit: 'mm' }),
      /"unit" requirement checks the unit a value is recorded in/],
    ['ne', rule([Rule.property('P', 'X', 'ne', 'a')]), /negated condition \("ne"\)/],
    ['notContains', rule([Rule.name('notContains', 'a')]), /negated condition \("notContains"\)/],
    ['notMatches', rule([Rule.name('notMatches', 'a')]), /negated condition \("notMatches"\)/],
    ['isNotSet', rule([Rule.property('P', 'X', 'isNotSet', '')]), /negated condition \("isNotSet"\)/],
    ['OR across applicability groups', rule([Rule.property('P', 'X', 'isSet', '')], {
      applicability: { groups: [{ rules: [exactWall()], combinator: 'AND' }, { rules: [exactWall()], combinator: 'AND' }], authoredAs: 'chips' },
    }), /applicability groups combined with OR/],
    ['OR inside a requirement group', rule({ kind: 'element', block: block([Rule.name('eq', 'a'), Rule.name('eq', 'b')], 'OR') }),
      /requirement: conditions combined with OR/],
    ['exactClass: false', rule([Rule.property('P', 'X', 'isSet', '')], { applicability: block([Rule.ifcType(['IfcWall'])]) }),
      /includes subclasses \(exactClass is off\)/],
    ['caseSensitive: false', rule([Rule.property('P', 'X', 'isSet', '')], { caseSensitive: false }), /case-insensitive matching/],
    ['modelTag targeting', rule([Rule.property('P', 'X', 'isSet', '')], {
      applicability: block([exactWall(), Rule.modelTag('hasAny', ['t1'])]),
    }), /targeting a model or model tag/],
    ['model targeting', rule([Rule.property('P', 'X', 'isSet', '')], { applicability: block([exactWall(), Rule.model(['fp'])]) }),
      /targeting a model or model tag/],
    ['warning severity', rule([Rule.property('P', 'X', 'isSet', '')], { severity: 'warning' }), /no warning severity/],
    ['custom tolerance', rule([Rule.property('P', 'X', 'isSet', '')], { tolerance: 0.01 }), /tolerance of 0\.01/],
    ['cardinality IDS 1.0 cannot say', rule([Rule.property('P', 'X', 'isSet', '')], { cardinality: { minApplicable: 2 } }),
      /applicable-count bounds \(min 2, max unbounded\)/],
    ['storey', rule([Rule.property('P', 'X', 'isSet', '')], { applicability: block([exactWall(), Rule.storey(['Level 1'])]) }),
      /storey membership/],
    ['relating type name', rule([Rule.typeName('eq', 'WT01')]), /relating type name/],
    ['parent', rule([Rule.parent('eq', 'Level 1')]), /ancestor matched by name/],
    ['group', rule([{ kind: 'group', groupClass: 'IfcSystem', op: 'isSet', value: '' }]), /group membership .* has no IDS facet/],
    ['classification value', rule([Rule.classification('Uniclass', 'eq', 'Ss_25')]), /code OR a name/],
    ['JS-only regex', rule([Rule.name('matches', '(?<=a)b', 'regex')]), /groups starting "\(\?"/],
    ['case-insensitive regex flag', rule([Rule.name('matches', '/wall/i')]), /"i" flag/],
    ['class requirement', rule([Rule.ifcType(['IfcWall'])]), /IFC class requirement has no exact-class form/],
    ['PredefinedType without a class', rule([Rule.property('P', 'X', 'isSet', '')], {
      applicability: block([Rule.predefinedType(['SHEAR'])]),
    }), /PredefinedType condition needs an IFC class condition/],
  ];

  for (const [label, r, reason] of cases) {
    it(`refuses ${label}`, () => {
      const reasons = onlyReasons(r);
      assert.ok(reasons.some((x) => reason.test(x)), `expected a reason matching ${reason}, got ${JSON.stringify(reasons)}`);
    });
  }

  it('lists every reason a rule has, not just the first', () => {
    const reasons = onlyReasons(rule([Rule.property('P', 'X', 'ne', 'a')], { severity: 'warning', caseSensitive: false }));
    assert.equal(reasons.length, 3);
  });
});
