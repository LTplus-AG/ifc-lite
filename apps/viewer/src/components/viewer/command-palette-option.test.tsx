/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { FolderOpen } from 'lucide-react';
import { cleanup, click, render } from '@/test/render.js';
import { resolveEnglish } from '@/i18n/registry.js';
import { surfaceCommand } from './surface-commands.js';
import { EXPORT_SURFACE_COMMANDS } from './commandPaletteExports.js';
import type { Command } from './commandPaletteSearch.js';
import type { RegisteredPaletteOptionProps } from './command-palette-option.js';

// #5878: a registered palette option cannot acquire a second name or invented id.
function paletteOptionTypeContract(): void {
  // @ts-expect-error Registry-backed palette rows do not take a literal label.
  const manualLabel: RegisteredPaletteOptionProps = { commandId: 'view:frame', label: 'Foo', index: 0, selected: true, onActivate: () => {}, onHover: () => {} };
  // @ts-expect-error Unknown commands cannot be rendered as registered rows.
  const unknownId: RegisteredPaletteOptionProps = { commandId: 'palette:made-up', index: 0, selected: true, onActivate: () => {}, onHover: () => {} };
  void manualLabel;
  void unknownId;
}
void paletteOptionTypeContract;

afterEach(cleanup);

it('renders a registered palette action by id and keeps runtime rows separate (#5878)', async () => {
  const options = await import('./command-palette-option.js').catch(() => null);
  assert.ok(options?.RegisteredPaletteOption && options.DynamicPaletteOption);
  const { RegisteredPaletteOption, DynamicPaletteOption, registeredPaletteId } = options;
  const command = surfaceCommand('view:frame', 'palette');
  let registeredClicks = 0;
  const runtime: Command = {
    id: 'recent:authoring-model', label: 'Authoring model.ifc', keywords: '', category: 'File', icon: FolderOpen,
    action: () => {},
  };
  let runtimeClicks = 0;
  render(<>
    <RegisteredPaletteOption commandId={command.id} index={0} selected
      onActivate={() => { registeredClicks++; }} onHover={() => {}} />
    <RegisteredPaletteOption commandId="export:ifc" index={2} selected={false}
      onActivate={() => {}} onHover={() => {}} />
    <DynamicPaletteOption command={runtime} index={1} selected={false}
      onActivate={() => { runtimeClicks++; }} onHover={() => {}} />
  </>);
  const registered = document.querySelector<HTMLButtonElement>('[data-command-id="view:frame"]');
  assert.ok(registered);
  assert.equal(registered.getAttribute('aria-label'), resolveEnglish(command.labelKey));
  assert.ok(registered.querySelector('svg.lucide-crosshair'));
  assert.equal(registered.querySelector('kbd')?.textContent, 'F');
  click(registered);
  assert.equal(registeredClicks, 1);
  const dynamic = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((item) => item.dataset.index === '1');
  assert.ok(dynamic);
  assert.equal(dynamic.getAttribute('aria-label'), runtime.label);
  assert.equal(dynamic.hasAttribute('data-command-id'), false);
  click(dynamic);
  assert.equal(runtimeClicks, 1);
  assert.equal(registeredPaletteId({ ...runtime, id: command.id, registryOwned: true }), command.id);
  const exportDefinition = EXPORT_SURFACE_COMMANDS.find((item) => item.id === 'export:ifc');
  assert.ok(exportDefinition);
  assert.equal(document.querySelector('[data-command-id="export:ifc"]')?.getAttribute('aria-label'),
    resolveEnglish(exportDefinition.labelKey));
  assert.equal(registeredPaletteId({ ...runtime, id: 'export:ifc', registryOwned: true }), 'export:ifc');
  assert.throws(() => registeredPaletteId({ ...runtime, id: command.id }), /must be registry-owned/);
  assert.throws(() => registeredPaletteId({ ...runtime, id: 'export:ifc' }), /must be registry-owned/);
  assert.throws(() => registeredPaletteId({ ...runtime, registryOwned: true }), /Unknown registered palette command/);
});
