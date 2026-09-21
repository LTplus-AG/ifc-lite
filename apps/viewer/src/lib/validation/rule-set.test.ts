/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `.rules.json` format round-trip + validation (#5138 plan §3): the rule
 * set file is the load-bearing artifact of the whole feature, so this locks
 * in that every requirement kind and every allowed `Subject` kind survives
 * `parseRuleSetFile` → `serializeRuleSet` → `parseRuleSetFile` unchanged,
 * and that every forward-compat/rejection rule the plan specifies actually
 * fires.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RULE_SET_VERSION, type RuleSetFile, type RuleBlock } from './rule-set.js';
import { parseRuleSetFile, serializeRuleSet } from './rule-set-io.js';
import { Rule } from '../search/filter-rules.js';

function block(groups: RuleBlock['groups']): RuleBlock {
  return { groups, authoredAs: 'chips' };
}
/** "No restriction" applicability: one empty AND group, matching everything
 *  — `parseFilterGroups` (and the chip UI) never accept a zero-length
 *  `groups` array, only a group with zero rules. */
function emptyBlock(): RuleBlock {
  return block([{ combinator: 'AND', rules: [] }]);
}

/** One rule set exercising every `Requirement` kind and every `Subject`
 *  kind the plan allows (§3), plus applicability-only kinds
 *  (`model`/`modelTag`/`storey`/`globalId`) and `exactClass`. */
function fullRuleSet(): RuleSetFile {
  return {
    version: RULE_SET_VERSION,
    name: 'Full coverage (#5138)',
    description: 'exercises every requirement + subject kind',
    targets: { modelFingerprints: ['fp-1'], modelTagIds: ['tag-1'] },
    rules: [
      {
        id: 'r-element', name: 'Element requirement',
        applicability: block([{
          combinator: 'AND',
          rules: [
            { ...Rule.ifcType(['IfcWall'], 'in'), exactClass: true },
            Rule.storey(['Level 1'], 'in'),
            Rule.model(['fp-1'], 'in'),
            Rule.modelTag('hasAny', ['tag-1']),
            Rule.globalId(['325Q7Fhnf67OZC$$r43uzK'], 'in'),
          ],
        }]),
        requirement: {
          kind: 'element',
          block: block([{
            combinator: 'AND',
            rules: [
              Rule.property('Pset_WallCommon', 'FireRating', 'isSet', ''),
              Rule.quantity('Qto_WallBaseQuantities', 'NetVolume', 'gt', 0),
              Rule.attribute('Description', 'isSet', ''),
              Rule.name('eq', 'W-01'),
              Rule.material('eq', 'Concrete'),
              Rule.classification('Uniclass 2015', 'isSet', ''),
              Rule.typeName('eq', 'WT01'),
              Rule.parent('eq', 'Building A'),
              Rule.predefinedType(['SOLIDWALL'], 'in'),
              Rule.ifcType(['IfcWall'], 'in'),
            ],
          }]),
        },
        cardinality: { minApplicable: 1 },
        caseSensitive: false,
        tolerance: 0.001,
      },
      {
        id: 'r-unique-material', name: 'Unique material', applicability: emptyBlock(),
        requirement: { kind: 'unique', subject: { kind: 'material' }, scope: 'perModel' },
      },
      {
        id: 'r-unique-globalid', name: 'Unique GlobalId', applicability: emptyBlock(),
        requirement: { kind: 'unique', subject: { kind: 'globalId' } },
      },
      {
        id: 'r-unique-type', name: 'Unique type', applicability: emptyBlock(),
        requirement: { kind: 'unique', subject: { kind: 'type' } },
      },
      {
        id: 'r-unique-predefinedtype', name: 'Unique predefinedType', applicability: emptyBlock(),
        requirement: { kind: 'unique', subject: { kind: 'predefinedType' } },
      },
      {
        id: 'r-unique-ifctype', name: 'Unique ifcType', applicability: emptyBlock(),
        requirement: { kind: 'unique', subject: { kind: 'ifcType' } },
      },
      {
        id: 'r-agg-count-groupby', name: 'Count plates per assembly', applicability: emptyBlock(),
        requirement: {
          kind: 'aggregate', fn: 'count', subject: { kind: 'classification' },
          groupBy: {
            subject: { kind: 'parent' },
            universe: block([{ combinator: 'AND', rules: [Rule.ifcType(['IfcElementAssembly'], 'in')] }]),
          },
          op: 'gte', value: 1,
        },
      },
      {
        id: 'r-agg-sum', name: 'Total floor area', applicability: emptyBlock(),
        requirement: {
          kind: 'aggregate', fn: 'sum',
          subject: { kind: 'quantity', setName: 'Qto_SpaceBaseQuantities', quantityName: 'NetFloorArea' },
          op: 'gt', value: 300,
        },
      },
      {
        id: 'r-agg-avg', name: 'Average score per storey', applicability: emptyBlock(),
        requirement: {
          kind: 'aggregate', fn: 'avg',
          subject: { kind: 'property', setName: 'Pset_X', propertyName: 'Score' },
          groupBy: { subject: { kind: 'storey' } },
          op: 'lte', value: 10,
        },
      },
      {
        id: 'r-agg-min', name: 'Min description length', applicability: emptyBlock(),
        requirement: { kind: 'aggregate', fn: 'min', subject: { kind: 'attribute', name: 'Description' }, op: 'eq', value: 5 },
      },
      {
        id: 'r-agg-max', name: 'Max name', applicability: emptyBlock(),
        requirement: { kind: 'aggregate', fn: 'max', subject: { kind: 'name' }, op: 'lt', value: 100 },
      },
      {
        id: 'r-compare-number', name: 'Gross > net volume', applicability: emptyBlock(),
        requirement: {
          kind: 'compare',
          left: { kind: 'quantity', setName: 'Qto_WallBaseQuantities', quantityName: 'GrossVolume' },
          right: { kind: 'quantity', setName: 'Qto_WallBaseQuantities', quantityName: 'NetVolume' },
          op: 'gt',
        },
      },
      {
        id: 'r-compare-date', name: 'End after start', applicability: emptyBlock(),
        requirement: {
          kind: 'compare',
          left: { kind: 'property', setName: 'Pset_X', propertyName: 'End' },
          right: { kind: 'property', setName: 'Pset_X', propertyName: 'Start' },
          op: 'gt', valueType: 'date',
        },
      },
    ],
  };
}

describe('rule-set-io — round-trip identity (#5138)', () => {
  it('parse -> serialize -> parse is identical for every requirement + subject kind', () => {
    const raw = fullRuleSet();
    const first = parseRuleSetFile(raw);
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const json = serializeRuleSet(first.file);
    const second = parseRuleSetFile(JSON.parse(json));
    assert.equal(second.ok, true);
    if (!second.ok) return;

    assert.deepEqual(second.file, first.file);
  });

  it('exactClass on an ifcType applicability rule survives the JSON round-trip (#5138)', () => {
    const raw = fullRuleSet();
    const result = parseRuleSetFile(raw);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const rule = result.file.rules.find((r) => r.id === 'r-element');
    const ifcTypeRule = rule?.applicability.groups[0]?.rules.find((r) => r.kind === 'ifcType');
    assert.equal((ifcTypeRule as { exactClass?: boolean } | undefined)?.exactClass, true);
  });

  it('targets are opaque strings, never a loaded model id — no resolution attempted here (#5138)', () => {
    // `parseTargets` only checks shape (string arrays); it never looks a
    // fingerprint/tag id up against any model registry, so a string that
    // could never be a real `sourceFingerprint` or runtime model id round-
    // trips unchanged — this module has no notion of "loaded".
    const raw = { ...fullRuleSet(), targets: { modelFingerprints: ['not-a-real-model !! 42'], modelTagIds: [] } };
    const result = parseRuleSetFile(raw);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.file.targets, { modelFingerprints: ['not-a-real-model !! 42'], modelTagIds: [] });
  });
});

describe('rule-set-io — rejections (#5138)', () => {
  it('"sum" over a multi-valued subject (material) is rejected', () => {
    const raw = fullRuleSet();
    raw.rules = [{
      id: 'bad', name: 'bad', applicability: emptyBlock(),
      requirement: { kind: 'aggregate', fn: 'sum', subject: { kind: 'material' }, op: 'gt', value: 1 },
    }];
    const result = parseRuleSetFile(raw);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /multi-valued/);
  });

  it('"count" with no subject is accepted', () => {
    const raw = fullRuleSet();
    raw.rules = [{
      id: 'ok', name: 'ok', applicability: emptyBlock(),
      requirement: { kind: 'aggregate', fn: 'count', op: 'gte', value: 1 },
    }];
    const result = parseRuleSetFile(raw);
    assert.equal(result.ok, true);
  });

  it('version: 2 is rejected (this build only understands 1)', () => {
    const raw = { ...fullRuleSet(), version: 2 };
    const result = parseRuleSetFile(raw);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /version/i);
  });

  it('an unknown top-level key is rejected', () => {
    const raw = { ...fullRuleSet(), extra: 'nope' };
    const result = parseRuleSetFile(raw);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /extra/);
  });

  it('an unknown optional rule field is ignored, with exactly one console.warn for the whole parse', (t) => {
    const warn = t.mock.method(console, 'warn', () => undefined);
    const raw = fullRuleSet();
    // Two rules carry a future/unknown field: both drop it, but the whole
    // parse warns exactly once (plan §3: "one console warning", not one per hit).
    (raw.rules[1] as unknown as Record<string, unknown>).futureField = 'x';
    (raw.rules[2] as unknown as Record<string, unknown>).anotherFutureField = 'y';
    const result = parseRuleSetFile(raw);
    assert.equal(result.ok, true);
    assert.equal(warn.mock.calls.length, 1);
  });

  it('an "elevation" applicability rule is rejected (no aggregate meaning, plan §3)', () => {
    const raw = fullRuleSet();
    raw.rules = [{
      id: 'bad', name: 'bad',
      applicability: block([{ combinator: 'AND', rules: [{ kind: 'elevation', op: 'gt', value: 0 }] }]),
      requirement: { kind: 'unique', subject: { kind: 'name' } },
    }];
    const result = parseRuleSetFile(raw);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /elevation/);
  });

  it('a legacy "requirements: RuleBlock" rule shape is rejected with a message, no silent migration', () => {
    const raw = fullRuleSet();
    raw.rules = [{
      id: 'legacy', name: 'legacy', applicability: emptyBlock(),
      requirements: block([{ combinator: 'AND', rules: [Rule.ifcType(['IfcWall'], 'in')] }]),
    } as unknown as RuleSetFile['rules'][number]];
    const result = parseRuleSetFile(raw);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /legacy/);
    assert.match(result.error, /requirements/);
  });

  it('a "compare" between two multi-valued subjects (material) is rejected', () => {
    const raw = fullRuleSet();
    raw.rules = [{
      id: 'bad', name: 'bad', applicability: emptyBlock(),
      requirement: {
        kind: 'compare', left: { kind: 'material' }, right: { kind: 'classification' }, op: 'eq',
      },
    }];
    const result = parseRuleSetFile(raw);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /multi-valued/);
  });

  it('an element requirement using an applicability-only kind (storey) is rejected', () => {
    const raw = fullRuleSet();
    raw.rules = [{
      id: 'bad', name: 'bad', applicability: emptyBlock(),
      requirement: {
        kind: 'element',
        block: block([{ combinator: 'AND', rules: [Rule.storey(['Level 1'], 'in')] }]),
      },
    }];
    const result = parseRuleSetFile(raw);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /storey/);
  });
});

describe('rule-set-io — applicability groups round-trip through the selector (#5138)', () => {
  // `groupsToSelectorText`/`readSelector` only spell single-rule groups of
  // `ifcType`/`globalId` (`filter-groups.ts`'s `ruleToSelectorClause`) — every
  // other allowed applicability kind (model, modelTag, storey, name,
  // attribute, property, quantity, material, classification, type, parent,
  // predefinedType) has no selector-text spelling and echoes as `''`
  // (`groupsToSelectorText`'s all-or-nothing rule), so only the two kinds
  // below round-trip through text. `exactClass` is exactly one of the kinds
  // the selector cannot spell: it is silently dropped by `ruleToSelectorClause`.
  it('an ifcType group round-trips through groupsToSelectorText -> readSelector, but loses exactClass', async () => {
    const { groupsToSelectorText } = await import('../search/filter-groups.js');
    const { readSelector } = await import('../search/selector-to-rules.js');
    const groups = [{ combinator: 'AND' as const, rules: [{ ...Rule.ifcType(['IfcWall'], 'in'), exactClass: true }] }];
    const text = groupsToSelectorText(groups);
    assert.equal(text, 'IfcWall');
    const reading = readSelector(text);
    assert.equal(reading.ok, true);
    if (!reading.ok) return;
    const rule = reading.groups[0]?.rules[0];
    assert.equal(rule?.kind, 'ifcType');
    assert.equal((rule as { exactClass?: boolean }).exactClass, undefined);
  });

  it('a globalId group round-trips through groupsToSelectorText -> readSelector', async () => {
    const { groupsToSelectorText } = await import('../search/filter-groups.js');
    const { readSelector } = await import('../search/selector-to-rules.js');
    const groups = [{ combinator: 'AND' as const, rules: [Rule.globalId(['325Q7Fhnf67OZC$$r43uzK'], 'in')] }];
    const text = groupsToSelectorText(groups);
    assert.equal(text, '325Q7Fhnf67OZC$$r43uzK');
    const reading = readSelector(text);
    assert.equal(reading.ok, true);
    if (!reading.ok) return;
    assert.deepEqual(reading.groups[0]?.rules[0], Rule.globalId(['325Q7Fhnf67OZC$$r43uzK'], 'in'));
  });
});
