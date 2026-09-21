/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Between" in the Element requirement's operator menu (#5138 plan §6's
 * operator table): a `gte` rule and an `lte` rule on the identical
 * property/quantity subject render as ONE range chip on load, and adding
 * the pair through the chip editor (two separate rows on the same
 * subject) emits exactly `gte`+`lte` into `RuleBlock.groups` — the
 * two-rule shape `rule-set-io.ts` persists, never a third "between" rule
 * kind (plan §3: `FilterRule` gains no new kind for this).
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, type } from '@/test/render.js';
import type { InformationRule, RuleSetFile } from '@/lib/validation/rule-set';
import { RuleSetEditor } from './RuleSetEditor.js';

function fileWithRule(rule: InformationRule): RuleSetFile {
  return { version: 1, name: 'Between fixture', rules: [rule] };
}

function baseRule(): InformationRule {
  return {
    id: 'r1', name: 'Wall width range',
    applicability: { groups: [{ rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }], combinator: 'AND' }], authoredAs: 'chips' },
    requirement: {
      kind: 'element',
      block: {
        groups: [{
          rules: [
            { kind: 'quantity', setName: 'Qto_WallBaseQuantities', quantityName: 'Width', op: 'gte', value: 100 },
            { kind: 'quantity', setName: 'Qto_WallBaseQuantities', quantityName: 'Width', op: 'lte', value: 300 },
          ],
          combinator: 'AND',
        }],
        authoredAs: 'chips',
      },
    },
  };
}

function mount(rule: InformationRule): HTMLElement {
  return render(<RuleSetEditor file={fileWithRule(rule)} onChange={() => {}} models={[]} />);
}

describe('RuleSetEditor — "between" folding (#5138)', () => {
  afterEach(cleanup);

  it('a persisted gte+lte pair on one subject renders as a single "Between" chip', () => {
    const container = mount(baseRule());
    const chips = [...container.querySelectorAll('span')].filter((el) => el.textContent === 'Between');
    assert.equal(chips.length, 1, 'expected exactly one folded "Between" chip');
    // The two underlying quantity rows must NOT also render separately.
    const minInput = container.querySelector('input[aria-label="Range minimum"]') as HTMLInputElement | null;
    const maxInput = container.querySelector('input[aria-label="Range maximum"]') as HTMLInputElement | null;
    assert.ok(minInput);
    assert.ok(maxInput);
    assert.equal(minInput!.value, '100');
    assert.equal(maxInput!.value, '300');
  });

  it('editing the chip emits gte+lte into the same block, and reloading folds it back into one chip', () => {
    let current = fileWithRule(baseRule());
    const onChange = (next: RuleSetFile) => { current = next; };
    const container = render(<RuleSetEditor file={current} onChange={onChange} models={[]} />);

    const maxInput = container.querySelector('input[aria-label="Range maximum"]') as HTMLInputElement;
    type(maxInput, '350');

    const requirement = current.rules[0].requirement;
    assert.equal(requirement.kind, 'element');
    if (requirement.kind !== 'element') return;
    const rules = requirement.block.groups[0].rules;
    assert.equal(rules.length, 2, 'the chip must unfold into exactly two rules on save');
    const ops = rules.map((r) => ('op' in r ? r.op : undefined)).sort();
    assert.deepEqual(ops, ['gte', 'lte']);
    const lte = rules.find((r) => 'op' in r && r.op === 'lte');
    assert.ok(lte && 'value' in lte && lte.value === 350);

    // Reload: mount a FRESH editor over the just-saved file and confirm it
    // folds back into one chip rather than showing two rows.
    cleanup();
    const reloaded = render(<RuleSetEditor file={current} onChange={() => {}} models={[]} />);
    const chips = [...reloaded.querySelectorAll('span')].filter((el) => el.textContent === 'Between');
    assert.equal(chips.length, 1, 'the saved pair must fold back into one chip on reload');
  });

  it('a lone gte (no matching lte) never folds into a chip', () => {
    const rule = baseRule();
    if (rule.requirement.kind === 'element') {
      rule.requirement.block.groups[0].rules = [rule.requirement.block.groups[0].rules[0]];
    }
    const container = mount(rule);
    const chips = [...container.querySelectorAll('span')].filter((el) => el.textContent === 'Between');
    assert.equal(chips.length, 0);
  });

  it('an lte-before-gte pair (#5157 review) still folds to one chip, and unfolds to exactly two rules', () => {
    const rule = baseRule();
    if (rule.requirement.kind === 'element') {
      // Same pair as `baseRule`, stored lte-first — a bug fixed after
      // review pushed the lte as a plain rule immediately (since it is not
      // itself a `gte`) and ALSO folded it into the chip once the `gte`
      // was reached, so it rendered fine but unfolded to three rules.
      rule.requirement.block.groups[0].rules = [
        { kind: 'quantity', setName: 'Qto_WallBaseQuantities', quantityName: 'Width', op: 'lte', value: 300 },
        { kind: 'quantity', setName: 'Qto_WallBaseQuantities', quantityName: 'Width', op: 'gte', value: 100 },
      ];
    }
    let current = fileWithRule(rule);
    const onChange = (next: RuleSetFile) => { current = next; };
    const container = render(<RuleSetEditor file={current} onChange={onChange} models={[]} />);

    const chips = [...container.querySelectorAll('span')].filter((el) => el.textContent === 'Between');
    assert.equal(chips.length, 1, 'expected exactly one folded "Between" chip regardless of storage order');

    // Nudging the max input re-emits the block through onChange — assert
    // the unfold produced exactly two rules, not three.
    const maxInput = container.querySelector('input[aria-label="Range maximum"]') as HTMLInputElement;
    type(maxInput, '400');
    const requirement = current.rules[0].requirement;
    assert.equal(requirement.kind, 'element');
    if (requirement.kind !== 'element') return;
    assert.equal(requirement.block.groups[0].rules.length, 2, 'unfold must emit exactly two rules, not three');
  });
});
