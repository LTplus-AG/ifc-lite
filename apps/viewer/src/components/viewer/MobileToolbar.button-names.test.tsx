/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { render, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { MobileToolbar } from './MobileToolbar';

afterEach(cleanup);

it('names Open file, Add model, and More actions buttons with a model loaded (#5839)', () => {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('model', { idOffset: 0 })), loading: false });
  const toolbar = render(
    <BimReactContext.Provider value={{} as BimContext}>
      <MobileToolbar />
    </BimReactContext.Provider>,
  );

  const getByRole = (role: 'button', { name }: { name: string }) => {
    const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>(role)].filter(
      (button) => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === name,
    );
    assert.equal(buttons.length, 1, `expected one ${role} named "${name}"`);
    return buttons[0];
  };

  assert.ok(getByRole('button', { name: 'Open file' }));
  assert.ok(getByRole('button', { name: 'Add model' }));
  assert.ok(getByRole('button', { name: 'More actions' }));
});
