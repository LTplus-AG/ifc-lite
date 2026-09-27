/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6190: a `listCondition` rule needs the Lists data provider to evaluate, so
 * builders without one (Search, Lens, clash sets) must not offer it; a builder
 * that names it in `allowedKinds` does.
 */

import '@/test/setup-dom.js';

import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { FilterRule } from '@ifc-lite/rules';
import { render, cleanup } from '@/test/render.js';
import { AddRuleMenu } from './FilterRuleControls.js';

afterEach(cleanup);

function offered(allowedKinds?: ReadonlySet<FilterRule['kind']>): string[] {
  const container = render(<AddRuleMenu onAdd={() => {}} allowedKinds={allowedKinds} />);
  const trigger = container.querySelector('button')!;
  act(() => trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
  act(() => trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
  const items = [...document.body.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim() ?? '');
  cleanup();
  return items;
}

it('offers "List value" only to a builder that allows it (#6190)', () => {
  const unrestricted = offered();
  assert.ok(unrestricted.includes('Property'), 'the ordinary kinds are still offered');
  assert.ok(!unrestricted.includes('List value'));
  assert.deepEqual(offered(new Set<FilterRule['kind']>(['property', 'listCondition'])), ['Property', 'List value']);
});
