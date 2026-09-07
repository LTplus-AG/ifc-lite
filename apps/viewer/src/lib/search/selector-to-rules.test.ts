/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The same seventeen IfcOpenShell examples the parser pins, carried one step
 * further: what filter rules does each one become, and what does the adapter
 * refuse to guess at (#4091)?
 *
 * The `unsupported` assertions matter as much as the rules. A selector that
 * produced no rule and no complaint is the reported defect — the user typed a
 * valid query and got an empty result with nothing to read.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSelector } from '@ifc-lite/query';
import { selectorToFilterRules } from './selector-to-rules.js';
import { Rule, type FilterRule } from './filter-rules.js';
import { matchPropertyRule } from './filter-match.js';
import { stringOpMatches } from './filter-ops.js';

const GUID = '325Q7Fhnf67OZC$$r43uzK';

/**
 * A property / quantity rule as the adapter builds it. Both names carry the
 * AST's string-or-regex discriminator, so every expectation states it rather
 * than leaving the matcher to sniff the text back out (#4091).
 */
const prop = (
  set: string,
  name: string,
  op: Parameters<typeof Rule.property>[2],
  value: string,
  kinds: Parameters<typeof Rule.property>[4] = {},
): FilterRule =>
  Rule.property(set, name, op, value, { setNameKind: 'literal', propertyNameKind: 'literal', ...kinds });

const qty = (
  set: string,
  name: string,
  op: Parameters<typeof Rule.quantity>[2],
  value: number,
  kinds: Parameters<typeof Rule.quantity>[4] = {},
): FilterRule =>
  Rule.quantity(set, name, op, value, { setNameKind: 'literal', quantityNameKind: 'literal', ...kinds });

function adapt(text: string, schemaVersion = 'IFC4') {
  const result = parseSelector(text);
  if (!result.ok) throw new Error(`${text} did not parse: ${result.error.message}`);
  return selectorToFilterRules(result.query, { schemaVersion });
}

/** Rules only, for the cases whose `unsupported` list must be empty. */
function rulesOf(text: string, schemaVersion = 'IFC4'): FilterRule[] {
  const out = adapt(text, schemaVersion);
  assert.deepEqual(out.unsupported, [], `expected nothing unsupported in ${text}`);
  assert.equal(out.combinator, 'AND');
  return out.rules;
}

const WALLS = ['IfcWall', 'IfcWallElementedCase', 'IfcWallStandardCase'];
const SLABS = ['IfcSlab', 'IfcSlabElementedCase', 'IfcSlabStandardCase'];
const DOORS = ['IfcDoor', 'IfcDoorStandardCase'];

describe('selectorToFilterRules — the documented examples', () => {
  it('1. a class expands to its subclasses', () => {
    const rules = rulesOf('IfcWall');
    assert.deepEqual(rules, [Rule.ifcType(WALLS, 'in')]);
    // The point of the expansion, stated so deleting it fails here: a file
    // full of IfcWallStandardCase answers a query for IfcWall.
    assert.ok(rules[0] && 'values' in rules[0] && rules[0].values.includes('IfcWallStandardCase'));
  });

  it('1b. an abstract supertype reaches its whole branch', () => {
    const rules = rulesOf('IfcElement');
    assert.equal(rules.length, 1);
    const values = rules[0] && 'values' in rules[0] ? rules[0].values : [];
    assert.ok(values.length > 100, `IfcElement expanded to only ${values.length} names`);
    assert.ok(values.includes('IfcPump'));
    assert.ok(values.includes('IfcWallStandardCase'));
  });

  it('2. several classes fold into ONE rule, which is the OR the grammar means', () => {
    assert.deepEqual(rulesOf('IfcWall, IfcSlab'), [Rule.ifcType([...WALLS, ...SLABS], 'in')]);
  });

  it('3. classes plus a material', () => {
    assert.deepEqual(rulesOf('IfcWall, IfcSlab, material=concrete'), [
      Rule.ifcType([...WALLS, ...SLABS], 'in'),
      Rule.material('eq', 'concrete'),
    ]);
  });

  it('4. a GlobalId has no rule kind yet, and says so', () => {
    const out = adapt(GUID);
    assert.deepEqual(out.rules, []);
    assert.equal(out.unsupported.length, 1);
    assert.match(out.unsupported[0] ?? '', /GlobalId/);
    assert.match(out.unsupported[0] ?? '', /325Q7Fhnf67OZC/);
  });

  it('5. the wall rule survives, the GlobalId subtraction is reported with its "!"', () => {
    const out = adapt(`IfcWall, ! ${GUID}`);
    assert.deepEqual(out.rules, [Rule.ifcType(WALLS, 'in')]);
    assert.equal(out.unsupported.length, 1);
    assert.ok(out.unsupported[0]?.includes(`! ${GUID}`), out.unsupported[0]);
  });

  it('6. a class subtraction becomes a notIn rule over the expanded subtree', () => {
    assert.deepEqual(rulesOf('IfcElement, ! IfcWall'), [
      Rule.ifcType(rulesOf('IfcElement').flatMap((r) => ('values' in r ? r.values : [])), 'in'),
      Rule.ifcType(WALLS, 'notIn'),
    ]);
  });

  it('7. Name equality', () => {
    assert.deepEqual(rulesOf('IfcDoor, Name=D01'), [
      Rule.ifcType(DOORS, 'in'),
      Rule.name('eq', 'D01'),
    ]);
  });

  it('8. Name by regular expression', () => {
    assert.deepEqual(rulesOf('IfcDoor, Name=/D[0-9]{2}/'), [
      Rule.ifcType(DOORS, 'in'),
      Rule.name('matches', 'D[0-9]{2}', 'regex'),
    ]);
  });

  it('9. a property in a named set', () => {
    assert.deepEqual(rulesOf('IfcWall, Pset_WallCommon.FireRating=2HR'), [
      Rule.ifcType(WALLS, 'in'),
      prop('Pset_WallCommon', 'FireRating', 'eq', '2HR'),
    ]);
  });

  it('10. four classes and a regex property-set name, which travels as a /…/ literal', () => {
    assert.deepEqual(rulesOf('IfcWall, IfcColumn, IfcBeam, IfcFooting, /Pset_.*Common/.LoadBearing=TRUE'), [
      Rule.ifcType([
        ...WALLS,
        'IfcColumn', 'IfcColumnStandardCase',
        'IfcBeam', 'IfcBeamStandardCase',
        'IfcFooting',
      ], 'in'),
      prop('Pset_.*Common', 'LoadBearing', 'eq', 'TRUE', { setNameKind: 'regex' }),
    ]);
  });

  it('11. != NULL is the isSet presence check', () => {
    const rules = rulesOf('IfcElement, /Pset_.*Common/.FireRating != NULL');
    assert.deepEqual(rules[1], prop('Pset_.*Common', 'FireRating', 'isSet', '', { setNameKind: 'regex' }));
  });

  it('11b. = NULL is isNotSet', () => {
    assert.deepEqual(
      rulesOf('Pset_WallCommon.FireRating = NULL'),
      [prop('Pset_WallCommon', 'FireRating', 'isNotSet', '')],
    );
  });

  it('12. location becomes a storey rule; type= is reported', () => {
    const out = adapt('IfcWall, type=WT01, location="Level 3"');
    assert.deepEqual(out.rules, [Rule.ifcType(WALLS, 'in'), Rule.storey(['Level 3'], 'in')]);
    assert.equal(out.unsupported.length, 1);
    assert.ok(out.unsupported[0]?.includes('type=WT01'), out.unsupported[0]);
  });

  it('13. a classification matched by a regular expression', () => {
    const rules = rulesOf('IfcElement, classification=/Pr_.*/');
    assert.deepEqual(rules[1], Rule.classification('', 'matches', 'Pr_.*', 'regex'));
  });

  it('14. everything at once — four rules kept, the GlobalId reported', () => {
    const out = adapt(`IfcWall, IfcSlab, ! ${GUID}, material=concrete, /Pset_.*Common/.FireRating=2HR`);
    assert.deepEqual(out.rules, [
      Rule.ifcType([...WALLS, ...SLABS], 'in'),
      Rule.material('eq', 'concrete'),
      prop('Pset_.*Common', 'FireRating', 'eq', '2HR', { setNameKind: 'regex' }),
    ]);
    assert.equal(out.unsupported.length, 1);
    assert.match(out.unsupported[0] ?? '', /GlobalId/);
  });

  it('15. a union keeps the FIRST group and names the rest', () => {
    const out = adapt('IfcSlab, material=concrete + IfcDoor');
    assert.deepEqual(out.rules, [Rule.ifcType(SLABS, 'in'), Rule.material('eq', 'concrete')]);
    assert.equal(out.unsupported.length, 1);
    assert.ok(out.unsupported[0]?.includes('IfcDoor'), out.unsupported[0]);
    assert.match(out.unsupported[0] ?? '', /\+/);
  });

  it('16. two dropped groups produce two entries, each quoting its own filters', () => {
    const out = adapt(`IfcDoor, IfcWindow + IfcWall, IfcSlab, material=concrete + ${GUID}`);
    assert.deepEqual(out.rules, [Rule.ifcType([...DOORS, 'IfcWindow', 'IfcWindowStandardCase'], 'in')]);
    assert.equal(out.unsupported.length, 2);
    assert.ok(out.unsupported[0]?.includes('IfcWall, IfcSlab, material=concrete'), out.unsupported[0]);
    assert.ok(out.unsupported[1]?.includes(GUID), out.unsupported[1]);
  });

  it('17. location reaches a storey by name — and only that far, see filter-evaluate.test.ts', () => {
    assert.deepEqual(rulesOf('IfcPump, location="Level 3"'), [
      Rule.ifcType(['IfcPump'], 'in'),
      Rule.storey(['Level 3'], 'in'),
    ]);
  });
});

describe('selectorToFilterRules — operators and value shapes', () => {
  it('maps every property operator', () => {
    const cases: Array<[string, FilterRule]> = [
      ['A.B=x', prop('A', 'B', 'eq', 'x')],
      ['A.B!=x', prop('A', 'B', 'ne', 'x')],
      ['A.B*=x', prop('A', 'B', 'contains', 'x')],
      ['A.B!*=x', prop('A', 'B', 'notContains', 'x')],
      ['A.B>1', prop('A', 'B', 'gt', '1')],
      ['A.B>=1', prop('A', 'B', 'gte', '1')],
      ['A.B<1', prop('A', 'B', 'lt', '1')],
      ['A.B<=1', prop('A', 'B', 'lte', '1')],
    ];
    for (const [text, expected] of cases) assert.deepEqual(rulesOf(text), [expected], text);
  });

  it('maps every Name operator, regex included', () => {
    assert.deepEqual(rulesOf('Name!=D01'), [Rule.name('ne', 'D01')]);
    assert.deepEqual(rulesOf('Name*=Wand'), [Rule.name('contains', 'Wand')]);
    assert.deepEqual(rulesOf('Name!*=Wand'), [Rule.name('notContains', 'Wand')]);
    assert.deepEqual(rulesOf('Name!=/D[0-9]{2}/'), [Rule.name('notMatches', 'D[0-9]{2}', 'regex')]);
  });

  it('a Qto_ set with a numeric value becomes a quantity rule, not a property rule', () => {
    assert.deepEqual(
      rulesOf('Qto_WallBaseQuantities.NetVolume>1.5'),
      [qty('Qto_WallBaseQuantities', 'NetVolume', 'gt', 1.5)],
    );
    assert.deepEqual(
      rulesOf('/Qto_.*/.NetVolume>1.5'),
      [qty('Qto_.*', 'NetVolume', 'gt', 1.5, { setNameKind: 'regex' })],
    );
  });

  it('a Qto_ set with a NON-numeric value stays a property rule', () => {
    assert.deepEqual(
      rulesOf('Qto_WallBaseQuantities.Note=draft'),
      [prop('Qto_WallBaseQuantities', 'Note', 'eq', 'draft')],
    );
  });

  it('a Pset_ set with a numeric value stays a property rule', () => {
    assert.deepEqual(
      rulesOf('Pset_WallCommon.ThermalTransmittance>1.5'),
      [prop('Pset_WallCommon', 'ThermalTransmittance', 'gt', '1.5')],
    );
  });

  it('PredefinedType maps onto its set rule', () => {
    assert.deepEqual(rulesOf('PredefinedType=SOLIDWALL'), [Rule.predefinedType(['SOLIDWALL'], 'in')]);
    assert.deepEqual(rulesOf('PredefinedType!=SOLIDWALL'), [Rule.predefinedType(['SOLIDWALL'], 'notIn')]);
  });

  it('classification != NULL is the presence check', () => {
    assert.deepEqual(rulesOf('classification != NULL'), [Rule.classification('', 'isSet', '')]);
  });

  it('a quoted value keeps its spaces and unescaped quotes', () => {
    assert.deepEqual(rulesOf('Name="Wand \\"A\\" 1"'), [Rule.name('eq', 'Wand "A" 1')]);
  });

  it('the schema decides the expansion', () => {
    const valuesFor = (schema: string): string[] => {
      const [rule] = rulesOf('IfcBuildingElement', schema);
      return rule && 'values' in rule ? rule.values : [];
    };
    // IFC2X3 parents IfcReinforcingBar under IfcBuildingElement; IFC4 moved it
    // out. The wrong table is a wrong answer, so the version has to reach
    // `expandTypes` rather than being left to the union fallback.
    assert.ok(valuesFor('IFC2X3').includes('IfcReinforcingBar'));
    assert.ok(!valuesFor('IFC4').includes('IfcReinforcingBar'));
  });
});

describe('selectorToFilterRules — nothing is dropped in silence', () => {
  const reported = (text: string): string[] => adapt(text).unsupported;

  it('an attribute other than Name / PredefinedType', () => {
    const out = adapt('IfcWall, Description=Foo');
    assert.deepEqual(out.rules, [Rule.ifcType(WALLS, 'in')]);
    assert.ok(out.unsupported[0]?.includes('Description=Foo'), out.unsupported[0]);
  });

  it('an unknown class name', () => {
    const out = adapt('IfcWaall');
    assert.deepEqual(out.rules, []);
    assert.match(out.unsupported[0] ?? '', /IfcWaall/);
  });

  it('an unknown class reads back with the "!" the user typed', () => {
    // Every other entry quotes `filter.text`, the exact source substring. This
    // one quoted `filter.name`, so `! IfcWaall` came back without its "!" and
    // the reader could not tell which of two terms was rejected.
    const out = adapt('IfcWall, ! IfcWaall');
    assert.deepEqual(out.rules, [Rule.ifcType(WALLS, 'in')]);
    assert.equal(out.unsupported.length, 1);
    assert.ok(out.unsupported[0]?.startsWith('"! IfcWaall"'), out.unsupported[0]);
  });

  it('parent= and query:', () => {
    assert.match(reported('parent=Foo')[0] ?? '', /parent=Foo/);
    assert.match(reported('query:types.count=0')[0] ?? '', /query:types\.count=0/);
  });

  it('an operator the dimension cannot take', () => {
    assert.match(reported('Name>1')[0] ?? '', /Name>1/);
    assert.match(reported('location*=Level')[0] ?? '', /location\*=Level/);
    assert.match(reported('PredefinedType=/SOLID.*/')[0] ?? '', /regular expression/);
    assert.match(reported('Pset.Prop > NULL')[0] ?? '', /NULL/);
  });

  it('a regular expression JavaScript cannot compile is refused up front, not at match time', () => {
    const out = adapt('Name=/D[0-9/');
    assert.deepEqual(out.rules, []);
    assert.match(out.unsupported[0] ?? '', /not a valid regular expression/);
    // A pattern the RegExp constructor rejects would otherwise match nothing,
    // which reads exactly like a correct pattern with no hits.
    assert.match(out.unsupported[0] ?? '', /D\[0-9/);
  });

  it('an invalid regular expression in a property-set NAME is caught too', () => {
    assert.match(reported('/Pset_[/.FireRating=2HR')[0] ?? '', /not a valid regular expression/);
  });

  it('every unsupported entry quotes the text the user typed', () => {
    const out = adapt(`IfcWall, ! ${GUID}, type=WT01, parent=Foo, Description=x + IfcDoor`);
    assert.equal(out.unsupported.length, 5);
    for (const entry of out.unsupported) {
      assert.match(entry, /^"/, `entry does not start with the quoted source: ${entry}`);
    }
  });
});


/**
 * The selector #4091 was reported with, pinned by name so it cannot regress
 * quietly. Two things had to be true for it to work: a class list hoists into
 * one expanded `in` rule, and a quoted property name is accepted after a
 * property set — which for the regex spelling it always was, and for the
 * literal spelling `Pset_BeamCommon."IsExternal"` it was not.
 */
describe('the reporter\'s selector (#4091)', () => {
  const SELECTOR =
    'IfcBeam, IfcColumn, IfcFooting, IfcMember, IfcPlate, IfcSlab, IfcStair, IfcWall, /Pset_.*Common/."Tragendes_Element" = TRUE';

  it('becomes one expanded type rule and one property rule, with nothing unsupported', () => {
    const out = adapt(SELECTOR);
    assert.deepEqual(out.unsupported, []);
    assert.equal(out.combinator, 'AND');
    assert.equal(out.rules.length, 2);

    const [types, property] = out.rules;
    assert.ok(types && types.kind === 'ifcType');
    assert.equal(types.op, 'in');
    assert.equal(types.values.length, 16);
    for (const name of ['IfcBeam', 'IfcColumn', 'IfcFooting', 'IfcMember', 'IfcPlate', 'IfcSlab', 'IfcStair', 'IfcWall']) {
      assert.ok(types.values.includes(name), `${name} missing from the expansion`);
    }
    // The expansion is the point: a file full of IfcBeamStandardCase answers.
    assert.ok(types.values.includes('IfcBeamStandardCase'));

    assert.deepEqual(
      property,
      prop('Pset_.*Common', 'Tragendes_Element', 'eq', 'TRUE', { setNameKind: 'regex' }),
    );
  });

  it('the property rule really reaches a German Pset_…Common set', () => {
    const rule = adapt(SELECTOR).rules[1];
    assert.ok(rule && rule.kind === 'property');
    assert.equal(
      matchPropertyRule(rule, [{ setName: 'Pset_BeamCommon', propertyName: 'Tragendes_Element', value: 'TRUE' }]),
      true,
    );
    assert.equal(
      matchPropertyRule(rule, [{ setName: 'Pset_BeamCommon', propertyName: 'Tragendes_Element', value: 'FALSE' }]),
      false,
    );
  });

  it('the same filter written with a LITERAL property set parses and adapts too', () => {
    assert.deepEqual(
      rulesOf('Pset_BeamCommon."Tragendes_Element" = TRUE'),
      [prop('Pset_BeamCommon', 'Tragendes_Element', 'eq', 'TRUE')],
    );
  });
});

/**
 * The AST's string/regex discriminator has to survive the adapter. Re-deriving
 * it from the rule's text downstream is #4091's own defect class — matched the
 * wrong thing, said nothing — moved one layer along.
 */
describe('selectorToFilterRules — a name or value keeps the kind the grammar gave it', () => {
  it('a QUOTED name that looks like a regex stays literal, and matches nothing else', () => {
    const [rule] = rulesOf('"/Wall/".FireRating=2HR');
    assert.deepEqual(rule, prop('/Wall/', 'FireRating', 'eq', '2HR'));
    assert.ok(rule && rule.kind === 'property');

    // Quoting is the grammar's only way to ask for a literal name. Read as a
    // pattern, `/Wall/` would swallow every set whose name contains "Wall".
    assert.equal(
      matchPropertyRule(rule, [{ setName: 'Pset_WallCommon', propertyName: 'FireRating', value: '2HR' }]),
      false,
    );
    assert.equal(
      matchPropertyRule(rule, [{ setName: '/Wall/', propertyName: 'FireRating', value: '2HR' }]),
      true,
    );
  });

  it('a regex VALUE containing an escaped slash keeps its slashes', () => {
    const [rule] = rulesOf('Name=/\\/tmp\\//');
    assert.deepEqual(rule, Rule.name('matches', '/tmp/', 'regex'));
    assert.ok(rule && rule.kind === 'name');

    // The source IS `/tmp/`, so the slashes are part of the pattern. Sniffed
    // for delimiters it would compile to `tmp` and match every name with
    // "tmp" anywhere in it.
    assert.equal(stringOpMatches(rule.op, 'C:/tmp/x', rule.value, rule.valueKind), true);
    assert.equal(stringOpMatches(rule.op, 'tmp', rule.value, rule.valueKind), false);
  });

  it('a regex property SET name is still a pattern, declared rather than spelled', () => {
    const [rule] = rulesOf('/Pset_.*Common/.FireRating=2HR');
    assert.deepEqual(rule, prop('Pset_.*Common', 'FireRating', 'eq', '2HR', { setNameKind: 'regex' }));
    assert.ok(rule && rule.kind === 'property');
    assert.equal(
      matchPropertyRule(rule, [{ setName: 'Pset_SlabCommon', propertyName: 'FireRating', value: '2HR' }]),
      true,
    );
  });

  it('a quoted VALUE spelled like a regex is compared as text', () => {
    const [rule] = rulesOf('Name="/D[0-9]/"');
    assert.deepEqual(rule, Rule.name('eq', '/D[0-9]/'));
    assert.ok(rule && rule.kind === 'name');
    assert.equal(stringOpMatches(rule.op, '/D[0-9]/', rule.value, rule.valueKind), true);
    assert.equal(stringOpMatches(rule.op, 'D01', rule.value, rule.valueKind), false);
  });
});
