/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Round-trip identity for the `unique`/`aggregate`/`compare` text grammar
 * (#5138 plan §6): every documented example string parses to the exact
 * `TextRequirement` object the plan describes, and `requirementToText` of
 * that object reproduces the same text — including the `perModel`, `date`
 * and `by <subject>` modifiers, which are the parts most likely to get the
 * token order backwards.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { requirementToText, parseRequirementText, type TextRequirement } from './requirement-text.js';

function roundTrip(text: string, expected: TextRequirement): void {
  const parsed = parseRequirementText(text);
  assert.equal(parsed.ok, true, `expected ${JSON.stringify(text)} to parse`);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.requirement, expected);
  assert.equal(requirementToText(parsed.requirement), text);
}

describe('requirement-text — round-trip identity (#5138)', () => {
  it('unique(Name) — bare Name subject, default federation scope', () => {
    roundTrip('unique(Name)', { kind: 'unique', subject: { kind: 'name' } });
  });

  it('unique(Pset_X.AssetIdentifier) perModel — property subject + scope', () => {
    roundTrip('unique(Pset_X.AssetIdentifier) perModel', {
      kind: 'unique',
      subject: { kind: 'property', setName: 'Pset_X', propertyName: 'AssetIdentifier' },
      scope: 'perModel',
    });
  });

  it('count() >= 1 by parent — no subject, "by" group key after the comparison', () => {
    roundTrip('count() >= 1 by parent', {
      kind: 'aggregate', fn: 'count', op: 'gte', value: 1,
      groupBy: { subject: { kind: 'parent' } },
    });
  });

  it('sum(Qto_SpaceBaseQuantities.NetFloorArea) > 300 — quantity subject, no groupBy', () => {
    roundTrip('sum(Qto_SpaceBaseQuantities.NetFloorArea) > 300', {
      kind: 'aggregate', fn: 'sum',
      subject: { kind: 'quantity', setName: 'Qto_SpaceBaseQuantities', quantityName: 'NetFloorArea' },
      op: 'gt', value: 300,
    });
  });

  it('Pset_X.End > Pset_X.Start date — compare with the date modifier', () => {
    roundTrip('Pset_X.End > Pset_X.Start date', {
      kind: 'compare',
      left: { kind: 'property', setName: 'Pset_X', propertyName: 'End' },
      right: { kind: 'property', setName: 'Pset_X', propertyName: 'Start' },
      op: 'gt', valueType: 'date',
    });
  });

  it('Qto_X.Gross > Qto_X.Net — compare with no date modifier (plain number)', () => {
    roundTrip('Qto_X.Gross > Qto_X.Net', {
      kind: 'compare',
      left: { kind: 'quantity', setName: 'Qto_X', quantityName: 'Gross' },
      right: { kind: 'quantity', setName: 'Qto_X', quantityName: 'Net' },
      op: 'gt',
    });
  });

  it('avg(Pset_X.Score) <= 10 by storey — aggregate with both a subject and a groupBy', () => {
    roundTrip('avg(Pset_X.Score) <= 10 by storey', {
      kind: 'aggregate', fn: 'avg',
      subject: { kind: 'property', setName: 'Pset_X', propertyName: 'Score' },
      op: 'lte', value: 10,
      groupBy: { subject: { kind: 'storey' } },
    });
  });

  it('unique(globalId) — bare reserved-word subject other than Name', () => {
    roundTrip('unique(globalId)', { kind: 'unique', subject: { kind: 'globalId' } });
  });

  it('min(Description) = 5 — a non-reserved bare word reads as an attribute subject', () => {
    roundTrip('min(Description) = 5', {
      kind: 'aggregate', fn: 'min', subject: { kind: 'attribute', name: 'Description' }, op: 'eq', value: 5,
    });
  });
});

describe('requirement-text — parse errors name the offending token (#5138)', () => {
  it('rejects a missing operator', () => {
    const result = parseRequirementText('Name Description');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /operator/);
  });

  it('rejects an unterminated "fn(" call', () => {
    const result = parseRequirementText('sum(Qto_X.Net');
    assert.equal(result.ok, false);
  });

  it('rejects trailing garbage after a valid compare', () => {
    const result = parseRequirementText('Name = Name extra-junk');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /extra-junk/);
  });
});

describe('#5138 parentheses body', () => {
  it('rejects a second token inside the parentheses instead of dropping it', () => {
    for (const text of ['sum(Foo Bar) > 1', 'unique(Foo Bar)', 'count(Name x) >= 1']) {
      const r = parseRequirementText(text);
      assert.equal(r.ok, false, text);
      if (!r.ok) assert.match(r.error, /inside the parentheses/);
    }
  });
});

describe('requirement-text — aggregate subject invariant parity with the JSON parser (#5182)', () => {
  it('rejects a subjectless non-count aggregate ("sum() > 300")', () => {
    const result = parseRequirementText('sum() > 300');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /"subject" is required unless fn is "count"/);
  });

  it('rejects a subjectless "avg"/"min"/"max" the same way', () => {
    for (const text of ['avg() > 1', 'min() > 1', 'max() > 1']) {
      const result = parseRequirementText(text);
      assert.equal(result.ok, false, text);
      if (!result.ok) assert.match(result.error, /"subject" is required unless fn is "count"/);
    }
  });

  it('rejects a multi-valued subject on a numeric fn ("sum(material) > 1")', () => {
    const result = parseRequirementText('sum(material) > 1');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /needs a single-valued subject/);
    assert.match(result.error, /multi-valued/);
  });

  it('rejects a "compare" with a multi-valued side, as the JSON parser does', () => {
    for (const [text, side] of [['material = Name', 'left'], ['Name = classification', 'right']] as const) {
      const result = parseRequirementText(text);
      assert.equal(result.ok, false, text);
      if (result.ok) continue;
      assert.match(result.error, new RegExp(`^${side}: "compare" needs a single-valued subject`));
    }
  });

  it('still accepts "count() > 5" with no subject', () => {
    const result = parseRequirementText('count() > 5');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.requirement, { kind: 'aggregate', fn: 'count', op: 'gt', value: 5 });
  });

  it('still accepts a legitimate "sum(Qto_X.NetArea) > 300"', () => {
    const result = parseRequirementText('sum(Qto_X.NetArea) > 300');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.requirement, {
      kind: 'aggregate', fn: 'sum',
      subject: { kind: 'quantity', setName: 'Qto_X', quantityName: 'NetArea' },
      op: 'gt', value: 300,
    });
  });

  it('still accepts "count() > 5 by material" — count over a multi-valued groupBy is fine', () => {
    const result = parseRequirementText('count() > 5 by material');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.requirement, {
      kind: 'aggregate', fn: 'count', op: 'gt', value: 5,
      groupBy: { subject: { kind: 'material' } },
    });
  });
});
