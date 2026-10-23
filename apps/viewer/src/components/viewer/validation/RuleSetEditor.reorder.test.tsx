/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { render, cleanup, click, type } from '@/test/render.js';
import { parseRuleSetFile, serializeRuleSet, type RuleSetFile } from '@ifc-lite/rules';
import { RuleSetEditor } from './RuleSetEditor.js';

function fixture(): RuleSetFile {
  return {
    version: 1, name: 'Ordered checks', description: 'Keep metadata',
    targets: { modelFingerprints: ['model-a'] },
    rules: ['Walls', 'Doors', 'Windows'].map((name, i) => ({
      id: `rule-${i}`, name, description: `Check ${name}`, severity: 'warning',
      caseSensitive: false, tolerance: 0.01, cardinality: { minApplicable: 1 },
      applicability: {
        groups: [{ rules: [{ kind: 'ifcType', op: 'in', values: [`Ifc${['Wall', 'Door', 'Window'][i]}`] }], combinator: 'AND' }],
        authoredAs: 'chips',
      },
      requirement: { kind: 'unique', subject: { kind: 'name' } },
    })),
  };
}

function Harness({ initial, onChange }: { initial: RuleSetFile; onChange: (file: RuleSetFile) => void }) {
  const [file, setFile] = useState(initial);
  return <RuleSetEditor file={file} models={[]} onChange={(next) => { setFile(next); onChange(next); }} />;
}

function moveButton(container: HTMLElement, name: string, direction: 'up' | 'down'): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label='Move rule "${name}" ${direction}']`);
  assert.ok(button);
  return button;
}

function names(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLInputElement>('input[aria-label="Rule name"]')].map((input) => input.value);
}

describe('Information check reordering (#7975)', () => {
  afterEach(cleanup);

  it('moves checks repeatedly, retains their contents and serializes the displayed order', () => {
    const initial = fixture();
    const original = structuredClone(initial);
    let latest = initial;
    const ui = render(<Harness initial={initial} onChange={(next) => { latest = next; }} />);

    assert.equal(moveButton(ui, 'Walls', 'up').disabled, true);
    assert.equal(moveButton(ui, 'Windows', 'down').disabled, true);
    click(moveButton(ui, 'Windows', 'up'));
    assert.deepEqual(names(ui), ['Walls', 'Windows', 'Doors']);
    click(moveButton(ui, 'Windows', 'up'));
    assert.deepEqual(names(ui), ['Windows', 'Walls', 'Doors']);
    assert.equal(moveButton(ui, 'Windows', 'up').disabled, true);
    click(moveButton(ui, 'Windows', 'down'));
    assert.deepEqual(names(ui), ['Walls', 'Windows', 'Doors']);
    assert.deepEqual(latest, { ...original, rules: [original.rules[0], original.rules[2], original.rules[1]] });
    assert.deepEqual(initial, original, 'reordering must not mutate the supplied file');

    const parsed = parseRuleSetFile(JSON.parse(serializeRuleSet(latest)));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.file.rules, latest.rules);

    // An edit after a move must still target the moved rule, not its old slot.
    const inputs = ui.querySelectorAll<HTMLInputElement>('input[aria-label="Rule name"]');
    type(inputs[1], 'Window identifiers');
    assert.equal(latest.rules[1].id, 'rule-2');
    assert.equal(latest.rules[1].name, 'Window identifiers');
    assert.equal(latest.rules[2].name, 'Doors');
  });

  it('keeps an open Advanced editor attached to its rule during a move', () => {
    const ui = render(<Harness initial={fixture()} onChange={() => {}} />);
    const advanced = [...ui.querySelectorAll('button')].find((button) => button.textContent === 'Advanced');
    assert.ok(advanced);
    click(advanced);
    const before = ui.querySelector<HTMLInputElement>('input[aria-label="Min applicable"]');
    assert.ok(before);
    click(moveButton(ui, 'Walls', 'down'));
    assert.deepEqual(names(ui), ['Doors', 'Walls', 'Windows']);
    assert.equal(ui.querySelector('input[aria-label="Min applicable"]'), before);
  });

  it('disables both directions for a single check and has no move controls when empty', () => {
    const initial = fixture();
    initial.rules = initial.rules.slice(0, 1);
    let changes = 0;
    const ui = render(<Harness initial={initial} onChange={() => { changes++; }} />);
    for (const direction of ['up', 'down'] as const) {
      const button = moveButton(ui, 'Walls', direction);
      assert.equal(button.disabled, true);
      click(button);
    }
    assert.equal(changes, 0);
    cleanup();
    const empty = render(<Harness initial={{ ...initial, rules: [] }} onChange={() => { changes++; }} />);
    assert.equal(empty.querySelector('button[aria-label^="Move rule"]'), null);
  });
});
