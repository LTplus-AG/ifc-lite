/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render } from '@/test/render.js';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { resolveEnglish } from '@/i18n/registry.js';
import { surfaceCommand } from './surface-commands.js';
import type { CommandMenuItemProps } from './EntityContextMenuItems.js';

// #5878: built-in context rows cannot supply a second label or invent an id.
function commandMenuTypeContract(): void {
  // @ts-expect-error Registry-backed menu rows have no literal label prop.
  const manualLabel: CommandMenuItemProps = { commandId: 'vis:show', commandState: { canEditInSession: false }, label: 'Foo', onClick: () => {} };
  // @ts-expect-error Only registered ids can be rendered as commands.
  const unregisteredId: CommandMenuItemProps = { commandId: 'context:made-up', commandState: { canEditInSession: false }, onClick: () => {} };
  void manualLabel;
  void unregisteredId;
}
void commandMenuTypeContract;

afterEach(cleanup);

it('derives a built-in context item name, icon, and shortcut from its registry id (#5878)', async () => {
  const menuItems = await import('./EntityContextMenuItems.js').catch(() => null);
  const CommandMenuItem = menuItems?.CommandMenuItem;
  assert.ok(CommandMenuItem, 'a typed built-in context item is available');
  let invoked = 0;
  render(
    <ContextMenu open modal={false} onOpenChange={() => {}}>
      <ContextMenuTrigger>Model</ContextMenuTrigger>
      <ContextMenuContent>
        <CommandMenuItem commandId="view:frame" commandState={{ canEditInSession: false }}
          onClick={() => { invoked++; }} />
      </ContextMenuContent>
    </ContextMenu>,
  );
  const row = document.querySelector<HTMLButtonElement>('[data-command-id="view:frame"]');
  assert.ok(row);
  const definition = surfaceCommand('view:frame', 'context');
  const name = resolveEnglish(definition.contextLabelKey ?? definition.labelKey);
  assert.equal(row.getAttribute('aria-label'), name);
  assert.equal(row.querySelector('span')?.textContent, name);
  assert.ok(row.querySelector('svg.lucide-maximize-2'), 'the context-specific Frame icon is rendered');
  assert.equal(row.querySelectorAll('span')[1]?.textContent, 'F');
  click(row);
  assert.equal(invoked, 1);
});
