/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  combineRuleResults,
  isFilterRule,
  parseFilterRules,
  Rule,
  addHierarchyStoreyToRule,
} from './filter-rules.js';
import {
  setOpMatches,
  stringOpMatches,
  matchStringAnyNone,
  numericOpMatches,
  valueOpMatches,
} from './filter-ops.js';

describe('op helpers tolerate an undefined candidate (#1195)', () => {
  // getTypeName / property accessors are typed `string` but return undefined
  // for untyped entities at runtime; the helpers must not throw on it.
  const undef = undefined as unknown as string;
  it('setOpMatches treats undefined as "not one of the values"', () => {
    assert.doesNotThrow(() => setOpMatches('in', undef, ['IfcWall']));
    assert.strictEqual(setOpMatches('in', undef, ['IfcWall']), false);
    assert.strictEqual(setOpMatches('notIn', undef, ['IfcWall']), true);
  });
  it('stringOpMatches does not throw on an undefined candidate', () => {
    assert.doesNotThrow(() => stringOpMatches('contains', undef, 'wall'));
    assert.strictEqual(stringOpMatches('contains', undef, 'wall'), false);
  });
  it('valueOpMatches treats undefined as not set', () => {
    assert.strictEqual(valueOpMatches('isNotSet', undef, ''), true);
    assert.strictEqual(valueOpMatches('isSet', undef, ''), false);
    assert.doesNotThrow(() => valueOpMatches('eq', undef, 'x'));
  });
});

describe('setOpMatches', () => {
  it('matches case-insensitively for "in"', () => {
    assert.strictEqual(setOpMatches('in', 'IfcWall', ['ifcwall', 'IfcDoor']), true);
    assert.strictEqual(setOpMatches('in', 'IfcSlab', ['IfcWall', 'IfcDoor']), false);
  });
  it('inverts for "notIn"', () => {
    assert.strictEqual(setOpMatches('notIn', 'IfcSlab', ['IfcWall']), true);
    assert.strictEqual(setOpMatches('notIn', 'IfcWall', ['IfcWall']), false);
  });
  it('treats an empty values list as no match for "in"', () => {
    assert.strictEqual(setOpMatches('in', 'IfcWall', []), false);
    assert.strictEqual(setOpMatches('notIn', 'IfcWall', []), true);
  });
});

describe('stringOpMatches', () => {
  it('eq / ne are case-insensitive', () => {
    assert.strictEqual(stringOpMatches('eq', 'Foo', 'FOO'), true);
    assert.strictEqual(stringOpMatches('ne', 'Foo', 'bar'), true);
    assert.strictEqual(stringOpMatches('ne', 'Foo', 'foo'), false);
  });
  it('contains / notContains ignore case', () => {
    assert.strictEqual(stringOpMatches('contains', 'Wall-EXT', 'ext'), true);
    assert.strictEqual(stringOpMatches('notContains', 'Wall-EXT', 'int'), true);
  });
  it('startsWith ignores case', () => {
    assert.strictEqual(stringOpMatches('startsWith', 'IfcWallStandardCase', 'ifcwall'), true);
    assert.strictEqual(stringOpMatches('startsWith', 'IfcWall', 'wall'), false);
  });
});

describe('matchStringAnyNone', () => {
  const layers = ['Concrete C30/37', 'Rigid Insulation', 'Gypsum Board'];
  it('positive ops match if ANY candidate satisfies them', () => {
    assert.strictEqual(matchStringAnyNone('contains', layers, 'insulation'), true);
    assert.strictEqual(matchStringAnyNone('eq', layers, 'gypsum board'), true);
    assert.strictEqual(matchStringAnyNone('startsWith', layers, 'concrete'), true);
    assert.strictEqual(matchStringAnyNone('contains', layers, 'timber'), false);
  });
  it('negative ops match only if NO candidate violates them', () => {
    assert.strictEqual(matchStringAnyNone('notContains', layers, 'timber'), true);
    assert.strictEqual(matchStringAnyNone('notContains', layers, 'concrete'), false);
    assert.strictEqual(matchStringAnyNone('ne', layers, 'steel'), true);
    assert.strictEqual(matchStringAnyNone('ne', layers, 'gypsum board'), false);
  });
  it('an empty candidate set never matches — including negative ops', () => {
    assert.strictEqual(matchStringAnyNone('contains', [], 'concrete'), false);
    assert.strictEqual(matchStringAnyNone('notContains', [], 'concrete'), false);
    assert.strictEqual(matchStringAnyNone('ne', [], 'concrete'), false);
  });
});

describe('numericOpMatches', () => {
  it('eq uses 1e-9 epsilon (matches Rust impl)', () => {
    assert.strictEqual(numericOpMatches('eq', 1.0 + 1e-12, 1.0), true);
    assert.strictEqual(numericOpMatches('eq', 1.0 + 1e-7, 1.0), false);
  });
  it('gt/gte/lt/lte are exact', () => {
    assert.strictEqual(numericOpMatches('gt', 5, 5), false);
    assert.strictEqual(numericOpMatches('gte', 5, 5), true);
    assert.strictEqual(numericOpMatches('lt', 5, 5), false);
    assert.strictEqual(numericOpMatches('lte', 5, 5), true);
  });
});

describe('valueOpMatches', () => {
  it('isSet / isNotSet check string presence', () => {
    assert.strictEqual(valueOpMatches('isSet', 'foo', ''), true);
    assert.strictEqual(valueOpMatches('isSet', '', ''), false);
    assert.strictEqual(valueOpMatches('isNotSet', '', ''), true);
  });
  it('eq / ne / contains pass through case-insensitive', () => {
    assert.strictEqual(valueOpMatches('eq', 'Concrete', 'concrete'), true);
    assert.strictEqual(valueOpMatches('contains', 'C30/37', '30'), true);
    assert.strictEqual(valueOpMatches('notContains', 'C30/37', '50'), true);
  });
  it('numeric ops parse both sides as floats; NaN parses fail closed', () => {
    assert.strictEqual(valueOpMatches('gt', '12.5', '10'), true);
    assert.strictEqual(valueOpMatches('lt', '12.5', '10'), false);
    assert.strictEqual(valueOpMatches('gt', 'abc', '10'), false);
    assert.strictEqual(valueOpMatches('gt', '12', 'abc'), false);
  });
});

describe('combineRuleResults', () => {
  it('AND requires all true', () => {
    assert.strictEqual(combineRuleResults('AND', [true, true]), true);
    assert.strictEqual(combineRuleResults('AND', [true, false]), false);
  });
  it('OR requires any true', () => {
    assert.strictEqual(combineRuleResults('OR', [false, true]), true);
    assert.strictEqual(combineRuleResults('OR', [false, false]), false);
  });
  it('returns false on an empty list (no rule = no match)', () => {
    assert.strictEqual(combineRuleResults('AND', []), false);
    assert.strictEqual(combineRuleResults('OR', []), false);
  });
});

describe('addHierarchyStoreyToRule', () => {
  it('starts a hierarchy selection in exact-ref mode', () => {
    const result = addHierarchyStoreyToRule(
      undefined,
      'Level 1',
      [{ modelId: 'model-a', expressId: 100 }],
    );

    assert.deepStrictEqual(result, Rule.storey(
      ['Level 1'],
      'in',
      [{ modelId: 'model-a', expressId: 100 }],
    ));
  });

  it('keeps manual name selections in name mode when Ctrl/Cmd-click adds a storey (#3545)', () => {
    const manual = Rule.storey(['Level 1']);
    const result = addHierarchyStoreyToRule(
      manual,
      'Level 2',
      [{ modelId: 'model-a', expressId: 200 }],
    );

    assert.deepStrictEqual(result, Rule.storey(['Level 1', 'Level 2']));
  });

  it('merges exact refs for a rule already created by the hierarchy', () => {
    const hierarchyRule = Rule.storey(
      ['Level 1'],
      'in',
      [{ modelId: 'model-a', expressId: 100 }],
    );
    const result = addHierarchyStoreyToRule(
      hierarchyRule,
      'Level 2',
      [{ modelId: 'model-a', expressId: 200 }],
    );

    assert.deepStrictEqual(result, Rule.storey(
      ['Level 1', 'Level 2'],
      'in',
      [
        { modelId: 'model-a', expressId: 100 },
        { modelId: 'model-a', expressId: 200 },
      ],
    ));
  });
});

describe('isFilterRule / parseFilterRules', () => {
  it('accepts every known kind', () => {
    assert.strictEqual(isFilterRule(Rule.storey(['L1'])), true);
    assert.strictEqual(isFilterRule(Rule.ifcType(['IfcWall'])), true);
    assert.strictEqual(isFilterRule(Rule.predefinedType(['SOLID'])), true);
    assert.strictEqual(isFilterRule(Rule.name('contains', 'wall')), true);
    assert.strictEqual(isFilterRule(Rule.property('Pset_X', 'P', 'eq', 'v')), true);
    assert.strictEqual(isFilterRule(Rule.quantity('Qto_X', 'Q', 'gt', 1)), true);
    assert.strictEqual(isFilterRule(Rule.material('contains', 'Concrete')), true);
    assert.strictEqual(isFilterRule(Rule.classification('Uniclass', 'contains', 'Pr_')), true);
    assert.strictEqual(isFilterRule(Rule.elevation('gt', 3)), true);
  });
  it('rejects unknown kinds and non-objects', () => {
    assert.strictEqual(isFilterRule({ kind: 'bogus' }), false);
    assert.strictEqual(isFilterRule(null), false);
    assert.strictEqual(isFilterRule('storey'), false);
  });
  it('parseFilterRules drops invalid entries', () => {
    const parsed = parseFilterRules([
      { kind: 'ifcType', values: ['IfcWall'], op: 'in' },
      { kind: 'unknown' },
      'nope',
    ]);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].kind, 'ifcType');
  });
});

/**
 * `matches` / `notMatches` — the regex ops the selector syntax's `/…/` form
 * lands on (#4091). Everything else in this file compares case-insensitively;
 * these two do not, because the grammar's `/…/` is a Python regular
 * expression and those are case-sensitive by default.
 */
describe('stringOpMatches — matches / notMatches', () => {
  it('matches on the regex source, anchored nowhere', () => {
    assert.strictEqual(stringOpMatches('matches', 'D01', 'D[0-9]{2}'), true);
    assert.strictEqual(stringOpMatches('matches', 'Door-D01-A', 'D[0-9]{2}'), true);
    assert.strictEqual(stringOpMatches('matches', 'DA1', 'D[0-9]{2}'), false);
  });

  it('notMatches is its complement', () => {
    assert.strictEqual(stringOpMatches('notMatches', 'D01', 'D[0-9]{2}'), false);
    assert.strictEqual(stringOpMatches('notMatches', 'DA1', 'D[0-9]{2}'), true);
  });

  it('a value already written as a /…/ literal is honoured as one, flags included', () => {
    assert.strictEqual(stringOpMatches('matches', 'D01', '/D[0-9]{2}/'), true);
    assert.strictEqual(stringOpMatches('matches', 'wand', '/WAND/i'), true);
  });

  it('a DECLARED regex source is compiled whole, slashes and all', () => {
    // #4091: the selector `Name=/\/tmp\//` is the source `/tmp/`. Re-read for
    // delimiters it compiles to `tmp` and matches far too much.
    assert.strictEqual(stringOpMatches('matches', 'C:/tmp/x', '/tmp/', 'regex'), true);
    assert.strictEqual(stringOpMatches('matches', 'tmp', '/tmp/', 'regex'), false);
    // Without a declared kind the same string is free text, where the slashes
    // are the chip editor's only way to say "pattern".
    assert.strictEqual(stringOpMatches('matches', 'tmp', '/tmp/'), true);
  });

  it('is case-sensitive without an explicit flag, unlike every other op here', () => {
    assert.strictEqual(stringOpMatches('matches', 'wand', 'WAND'), false);
    assert.strictEqual(stringOpMatches('eq', 'wand', 'WAND'), true);
  });

  it('an invalid pattern never matches, and never throws', () => {
    assert.doesNotThrow(() => stringOpMatches('matches', 'D01', 'D[0-9'));
    assert.strictEqual(stringOpMatches('matches', 'D01', 'D[0-9'), false);
    // notMatches on a broken pattern rejects nothing rather than everything.
    assert.strictEqual(stringOpMatches('notMatches', 'D01', 'D[0-9'), true);
  });

  it('an empty pattern never matches (it would otherwise match everything)', () => {
    assert.strictEqual(stringOpMatches('matches', 'D01', ''), false);
  });

  it('a global flag does not alternate between calls', () => {
    for (let i = 0; i < 4; i++) {
      assert.strictEqual(stringOpMatches('matches', 'D01', '/D[0-9]{2}/g'), true, `call ${i}`);
    }
  });

  it('does not throw on an undefined candidate (#1195)', () => {
    const undef = undefined as unknown as string;
    assert.doesNotThrow(() => stringOpMatches('matches', undef, 'D[0-9]{2}'));
    assert.strictEqual(stringOpMatches('matches', undef, 'D[0-9]{2}'), false);
  });
});

describe('valueOpMatches / matchStringAnyNone — matches / notMatches', () => {
  it('matches a property value by regex', () => {
    assert.strictEqual(valueOpMatches('matches', 'REI 60', 'REI.*'), true);
    assert.strictEqual(valueOpMatches('matches', 'EI 60', 'REI.*'), false);
    assert.strictEqual(valueOpMatches('notMatches', 'EI 60', 'REI.*'), true);
  });

  it('multi-valued matches when ANY candidate matches', () => {
    assert.strictEqual(matchStringAnyNone('matches', ['Beton', 'Stahl'], 'Bet.*'), true);
    assert.strictEqual(matchStringAnyNone('matches', ['Holz', 'Stahl'], 'Bet.*'), false);
  });

  it('multi-valued notMatches holds only when NO candidate matches', () => {
    assert.strictEqual(matchStringAnyNone('notMatches', ['Holz', 'Stahl'], 'Bet.*'), true);
    assert.strictEqual(matchStringAnyNone('notMatches', ['Beton', 'Stahl'], 'Bet.*'), false);
  });

  it('an empty candidate set never matches, negative ops included', () => {
    assert.strictEqual(matchStringAnyNone('matches', [], 'Bet.*'), false);
    assert.strictEqual(matchStringAnyNone('notMatches', [], 'Bet.*'), false);
  });
});

describe('a rule carrying a regex op survives the saved-filter JSON guard', () => {
  it('isFilterRule accepts it and parseFilterRules keeps it', () => {
    const rule = Rule.name('matches', 'D[0-9]{2}');
    const roundTripped = JSON.parse(JSON.stringify([rule])) as unknown;
    assert.strictEqual(isFilterRule(rule), true);
    assert.deepStrictEqual(parseFilterRules(roundTripped), [rule]);
  });
});
