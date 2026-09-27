/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5821: the native Model/Types radios remain usable through their visible labels. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { TYPE_VIEW_MODE_STORAGE_KEY } from '@/store/constants';
import { ClassVisibilityMenuContent } from './ClassVisibilityMenu.js';

afterEach(() => {
  cleanup();
  localStorage.removeItem(TYPE_VIEW_MODE_STORAGE_KEY);
  useViewerStore.setState({ hasTypeGeometry: false, typeViewMode: 'model' });
});

it('switches the 3D view through the visible radio label when type geometry exists (#5821)', () => {
  useViewerStore.setState({ hasTypeGeometry: true, typeViewMode: 'model' });
  render(
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger>Visibility</DropdownMenuTrigger>
      <ClassVisibilityMenuContent />
    </DropdownMenu>,
  );

  const radios = [...document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  assert.equal(radios.length, 2);
  assert.equal(radios[0].checked, true);
  assert.equal(radios[1].checked, false);
  const typesLabel = radios[1].closest('label');
  assert.ok(typesLabel);
  assert.match(typesLabel.textContent ?? '', /Types/);

  act(() => { typesLabel.click(); });
  assert.equal(useViewerStore.getState().typeViewMode, 'types');
  assert.equal(radios[1].checked, true);
  assert.equal(radios[0].checked, false);
});
