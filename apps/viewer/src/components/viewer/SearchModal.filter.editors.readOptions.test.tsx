/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The SI toggle (#5225), the inherit selector (#5433) and the
 * complex-property member field (#5475) on property and quantity rows: each
 * writes or clears its own field without touching the rest of the rule, and
 * a property row offers no no-op 'type' choice.
 */

import '@/test/setup-dom.js';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click } from '@/test/render.js';
import { act } from 'react';
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

function inheritSelect(container: HTMLElement): HTMLSelectElement {
  const select = container.querySelector('select[aria-label="Where a missing value may come from"]');
  assert.ok(select instanceof window.HTMLSelectElement, 'no inherit selector rendered');
  return select;
}

function choose(select: HTMLSelectElement, value: string): void {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('RuleRow — inherit selector (#5433)', () => {
  it('a quantity row offers type and aggregation and writes the choice', () => {
    const commits: FilterRule[] = [];
    const rule: FilterRule = { kind: 'quantity', setName: 'Qto_BeamBaseQuantities', quantityName: 'Length', op: 'gte', value: 5 };
    const select = inheritSelect(renderRow(rule, commits));
    assert.deepEqual([...select.options].map((o) => o.value), ['', 'type', 'aggregation']);
    choose(select, 'type');
    assert.deepEqual(commits.at(-1), { ...rule, inherit: 'type' });
  });

  it('a property row offers only aggregation, and clearing removes the field', () => {
    const commits: FilterRule[] = [];
    const rule: FilterRule = { kind: 'property', setName: 'Pset_Asm', propertyName: 'FireRating', op: 'isSet', value: '', inherit: 'aggregation' };
    const select = inheritSelect(renderRow(rule, commits));
    assert.deepEqual([...select.options].map((o) => o.value), ['', 'aggregation']);
    assert.equal(select.value, 'aggregation');
    choose(select, '');
    assert.equal((commits.at(-1) as { inherit?: string }).inherit, undefined);
  });
});

function memberInput(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector('input[aria-label="Complex property member"]');
}

function typeAndBlur(input: HTMLInputElement, text: string): void {
  act(() => {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setValue?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

describe('RuleRow — complex property member (#5475)', () => {
  it('a property row writes a /-separated member path, and clearing removes it', () => {
    const commits: FilterRule[] = [];
    const rule: FilterRule = { kind: 'property', setName: 'Pset_Test', propertyName: 'Dims', op: 'eq', value: '300' };
    const input = memberInput(renderRow(rule, commits));
    assert.ok(input, 'no member field rendered');
    typeAndBlur(input, ' Frame / Width ');
    assert.deepEqual(commits.at(-1), { ...rule, memberPath: ['Frame', 'Width'] });

    const withPath: FilterRule = { ...rule, memberPath: ['Width'] };
    const shown = memberInput(renderRow(withPath, commits));
    assert.equal(shown?.value, 'Width');
    typeAndBlur(shown as HTMLInputElement, '');
    assert.equal((commits.at(-1) as { memberPath?: string[] }).memberPath, undefined);
  });

  it('a quantity row has no member field', () => {
    const rule: FilterRule = { kind: 'quantity', setName: 'Qto_WallBaseQuantities', quantityName: 'Width', op: 'gte', value: 0.2 };
    assert.equal(memberInput(renderRow(rule, [])), null);
  });
});
