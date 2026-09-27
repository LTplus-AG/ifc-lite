/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from '@/i18n/registry';
import { cleanup, render } from '@/test/render';
import { surfaceCommand } from '../surface-commands';
import type { RibbonCommandButtonProps } from './command-button';

// The production-revert oracle must run the assertion even when it removes
// the new wrapper module; a static import would fail before the test starts.
const loadButtons = async () => import('./command-button.js').catch(() => null);

afterEach(cleanup);

it('uses the registry name, icon, and shortcut for ribbon commands (#5878)', async () => {
  const buttons = await loadButtons();
  assert.ok(buttons, 'registry-backed ribbon buttons are available');
  const { RibbonCommandLargeButton, RibbonCommandSmallButton } = buttons;
  const large = surfaceCommand('file:save-federation-setup', 'ribbon');
  const small = surfaceCommand('vis:toggle-iso', 'ribbon');
  render(<>
    <RibbonCommandLargeButton commandId={large.id} tooltip="A longer explanation" />
    <RibbonCommandSmallButton commandId={small.id} />
  </>);

  for (const command of [large, small]) {
    const button = document.querySelector<HTMLButtonElement>(`[data-command-id="${command.id}"]`);
    assert.ok(button, `${command.id} is rendered`);
    assert.equal(button.getAttribute('aria-label'), resolve(command.labelKey),
      'the accessible name comes from the registry, not the tooltip');
    assert.ok(button.querySelector('svg'), `${command.id} renders the registered icon`);
  }
  const descriptionId = document.querySelector<HTMLElement>('[data-command-id="file:save-federation-setup"]')
    ?.getAttribute('aria-describedby');
  assert.ok(descriptionId);
  assert.equal(document.getElementById(descriptionId)?.textContent, 'A longer explanation');
});

it('rejects a command not registered for the ribbon (#5878)', async () => {
  const buttons = await loadButtons();
  assert.ok(buttons);
  const { RibbonCommandLargeButton } = buttons;
  assert.throws(() => render(<RibbonCommandLargeButton commandId="panel:tree" />),
    /not registered for ribbon/);
});

// These are checked by the root test-source typecheck, not by Vitest transpilation.
// @ts-expect-error A caller cannot hand-write a command label.
const labelOverride: RibbonCommandButtonProps = { commandId: 'vis:toggle-iso', label: 'Foo' };
// @ts-expect-error A caller cannot invent a command ID.
const unregisteredId: RibbonCommandButtonProps = { commandId: 'ribbon:made-up' };
// @ts-expect-error A mounted registered control cannot bypass the shared execution boundary.
const directAction: RibbonCommandButtonProps = { commandId: 'view:home', onClick: () => {} };
void labelOverride;
void unregisteredId;
void directAction;
