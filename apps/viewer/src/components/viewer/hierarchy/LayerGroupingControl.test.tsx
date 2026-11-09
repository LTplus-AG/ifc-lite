/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useState } from 'react';
import { cleanup, press, render, waitFor } from '@/test/render.js';
import { registerEnglish } from '@/i18n';
import { hierarchyEn } from '@/i18n/catalogues/hierarchy.en';
import { LayerGroupingControl } from './LayerGroupingControl';
import type { LayerGrouping } from './presentationLayerGroups';

registerEnglish(hierarchyEn);
afterEach(cleanup);

test('#9383 layer grouping preserves its accessible name, keyboard choices and cancellation', async () => {
  const changes: LayerGrouping[] = [];
  function Editor() {
    const [value, setValue] = useState<LayerGrouping>('none');
    return <LayerGroupingControl value={value} onChange={next => { changes.push(next); setValue(next); }} />;
  }
  const container = render(<Editor />);
  const trigger = container.querySelector<HTMLElement>('[role="combobox"]');
  assert.ok(trigger);
  assert.equal(trigger.getAttribute('aria-label'), 'Group layer elements');
  assert.equal(trigger.textContent, 'None');

  const focusedOption = async (name: string) => {
    await waitFor(() => document.activeElement?.getAttribute('role') === 'option'
      && document.activeElement.textContent === name, `${name} receives keyboard focus`);
    assert.ok(document.activeElement instanceof HTMLElement);
    return document.activeElement;
  };
  const open = async (selected: string) => {
    press(trigger, 'ArrowDown');
    await waitFor(() => trigger.getAttribute('aria-expanded') === 'true', 'grouping list opens');
    assert.deepEqual([...document.querySelectorAll('[role="option"]')].map(option => option.textContent),
      ['None', 'Class', 'Classification']);
    return focusedOption(selected);
  };
  const commit = async (name: string) => {
    press(await focusedOption(name), 'Enter');
    await waitFor(() => trigger.getAttribute('aria-expanded') === 'false', 'Enter commits and closes');
    assert.equal(trigger.textContent, name);
  };

  press(await open('None'), 'ArrowDown');
  await commit('Class');
  press(await open('Class'), 'ArrowDown');
  await commit('Classification');
  assert.deepEqual(changes, ['class', 'classification']);

  press(await open('Classification'), 'Home');
  press(await focusedOption('None'), 'Escape');
  await waitFor(() => document.activeElement === trigger, 'Escape returns focus to the labelled control');
  assert.equal(trigger.textContent, 'Classification', 'cancellation keeps the previous selection');
  assert.deepEqual(changes, ['class', 'classification']);

  press(await open('Classification'), 'Home');
  await commit('None');
  assert.deepEqual(changes, ['class', 'classification', 'none']);
});
