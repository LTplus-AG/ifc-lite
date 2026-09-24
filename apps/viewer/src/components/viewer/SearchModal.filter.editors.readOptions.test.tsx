/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The SI toggle on property and quantity rows (#5225): an imported IDS rule
 * shows as SI, and toggling writes or clears `valueUnit` without touching
 * the rest of the rule.
 */

import '@/test/setup-dom.js';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click } from '@/test/render.js';
import type { FilterRule } from '@ifc-lite/rules';
import { RuleRow } from './SearchModal.filter.editors.js';

afterEach(cleanup);

function renderRow(rule: FilterRule, commits: FilterRule[]): HTMLElement {
  return render(
    <RuleRow
      rule={rule}
      tagOptions={new Map()}
      modelOptions={[]}
      ifcTypeOptions={[]}
      storeyOptions={[]}
      psetQto={null}
      valueSchema={null}
      onChange={(next) => commits.push(next)}
      onRemove={() => {}}
    />,
  );
}

function siButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent === 'SI');
  assert.ok(button, 'no SI toggle rendered');
  return button as HTMLButtonElement;
}

describe('RuleRow — SI toggle (#5225)', () => {
  it('turns SI on for a quantity rule and keeps everything else', () => {
    const commits: FilterRule[] = [];
    const rule: FilterRule = { kind: 'quantity', setName: 'Qto_WallBaseQuantities', quantityName: 'Width', op: 'gte', value: 0.2 };
    const container = renderRow(rule, commits);
    assert.equal(siButton(container).getAttribute('aria-pressed'), 'false');
    click(siButton(container));
    assert.deepEqual(commits.at(-1), { ...rule, valueUnit: 'si' });
  });

  it('shows an SI property rule as pressed and clears it', () => {
    const commits: FilterRule[] = [];
    const rule: FilterRule = { kind: 'property', setName: 'Pset_Dims', propertyName: 'Height', op: 'gte', value: '2', valueUnit: 'si' };
    const container = renderRow(rule, commits);
    assert.equal(siButton(container).getAttribute('aria-pressed'), 'true');
    click(siButton(container));
    assert.equal((commits.at(-1) as { valueUnit?: string }).valueUnit, undefined);
  });
});
