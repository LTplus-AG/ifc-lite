/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Switching a rule's requirement kind (#5138 plan §6's segmented control:
 * Element / Unique / Aggregate / Compare):
 *  - `applicability` is untouched by the switch — only `requirement`
 *    changes (`RequirementEditor`'s `blankRequirementOfKind` never reads
 *    or writes `applicability`).
 *  - an `ifcType` chip's `exactClass` forces the applicability block to
 *    chips mode and shows the "can't express this" notice, because
 *    `groupsToSelectorText` has no spelling for it.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { render, cleanup, click, type } from '@/test/render.js';
import type { InformationRule, RuleSetFile } from '@ifc-lite/rules';
import { RuleSetEditor } from './RuleSetEditor.js';

function fixtureRule(exactClass = false): InformationRule {
  return {
    id: 'r1', name: 'Kind-switch fixture',
    applicability: {
      groups: [{ rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in', ...(exactClass ? { exactClass: true } : {}) }], combinator: 'AND' }],
      authoredAs: 'chips',
    },
    requirement: {
      kind: 'element',
      block: {
        groups: [{ rules: [{ kind: 'name', op: 'contains', value: 'Wall' }], combinator: 'AND' }],
        authoredAs: 'chips',
      },
    },
  };
}

/** A controlled `RuleSetEditor` over local `useState`, the way its real
 *  parent (`ValidationPanel`, PR 4) will drive it — a click must see the
 *  PREVIOUS click's committed state, not the mount-time snapshot. */
function Harness({ initial, onFileChange }: { initial: RuleSetFile; onFileChange?: (f: RuleSetFile) => void }) {
  const [file, setFile] = useState(initial);
  return (
    <RuleSetEditor
      file={file}
      onChange={(next) => { setFile(next); onFileChange?.(next); }}
      models={[]}
    />
  );
}

function kindButton(container: HTMLElement, label: string): HTMLElement {
  const el = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  assert.ok(el, `no "${label}" segmented-control button rendered`);
  return el!;
}

describe('RuleSetEditor — requirement kind switching (#5138)', () => {
  afterEach(cleanup);

  it('switching Element -> Unique -> Aggregate -> Compare leaves applicability untouched', () => {
    const initial: RuleSetFile = { version: 1, name: 'fixture', rules: [fixtureRule()] };
    const originalApplicability = initial.rules[0].applicability;
    let current = initial;
    const container = render(<Harness initial={initial} onFileChange={(f) => { current = f; }} />);

    click(kindButton(container, 'Unique'));
    const afterUnique: string = current.rules[0].requirement.kind;
    assert.equal(afterUnique, 'unique');
    assert.deepEqual(current.rules[0].applicability, originalApplicability);

    click(kindButton(container, 'Aggregate'));
    const afterAggregate: string = current.rules[0].requirement.kind;
    assert.equal(afterAggregate, 'aggregate');
    assert.deepEqual(current.rules[0].applicability, originalApplicability);

    click(kindButton(container, 'Compare'));
    const afterCompare: string = current.rules[0].requirement.kind;
    assert.equal(afterCompare, 'compare');
    assert.deepEqual(current.rules[0].applicability, originalApplicability);

    click(kindButton(container, 'Element'));
    const afterElement: string = current.rules[0].requirement.kind;
    assert.equal(afterElement, 'element');
    assert.deepEqual(current.rules[0].applicability, originalApplicability);
  });

  it('the Unit kind authors { kind: "unit", subject, unit } and keeps applicability (#5300)', () => {
    const initial: RuleSetFile = { version: 1, name: 'fixture', rules: [fixtureRule()] };
    const originalApplicability = initial.rules[0].applicability;
    let current = initial;
    const container = render(<Harness initial={initial} onFileChange={(f) => { current = f; }} />);

    click(kindButton(container, 'Unit'));
    assert.deepEqual(current.rules[0].requirement, {
      kind: 'unit', subject: { kind: 'quantity', setName: '', quantityName: '' }, unit: '',
    });
    assert.deepEqual(current.rules[0].applicability, originalApplicability);

    const unitInput = container.querySelector('input[aria-label="Required unit"]') as HTMLInputElement | null;
    assert.ok(unitInput, 'the required-unit field is rendered');
    type(unitInput, 'mm');
    const requirement = current.rules[0].requirement;
    assert.equal(requirement.kind === 'unit' ? requirement.unit : undefined, 'mm');
  });

  it('an exactClass ifcType chip forces the applicability block to chips mode with a notice', () => {
    const withoutExactClass: RuleSetFile = { version: 1, name: 'fixture', rules: [fixtureRule(false)] };
    const container = render(<Harness initial={withoutExactClass} />);
    assert.equal(container.textContent?.includes('can’t express this'), false);
    cleanup();

    const withExactClass: RuleSetFile = { version: 1, name: 'fixture', rules: [fixtureRule(true)] };
    const forced = render(<Harness initial={withExactClass} />);
    assert.ok(forced.textContent?.includes('can’t express this'));

    // The applicability block's own "Selector text" toggle must be disabled.
    const selectorToggles = [...forced.querySelectorAll('button')].filter(
      (b) => b.textContent?.trim() === 'Selector text',
    );
    assert.ok(selectorToggles.length >= 1);
    assert.ok(
      selectorToggles.some((b) => (b as HTMLButtonElement).disabled),
      'the forced block’s Selector text toggle must be disabled',
    );
  });
});
