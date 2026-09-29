/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { FolderOpen } from 'lucide-react';
import { cleanup, click, render } from '@/test/render.js';
import { resolveEnglish } from '@/i18n/registry.js';
import { shortcutLabel } from '@/lib/commands/shortcut-label.js';
import { surfaceCommand } from './surface-commands.js';
import { EXPORT_SURFACE_COMMANDS } from './commandPaletteExports.js';
import type { Command } from './commandPaletteSearch.js';
import type { DynamicPaletteOptionProps, RegisteredPaletteOptionProps } from './command-palette-option.js';

/** Loaded dynamically so a missing primitive fails an assertion, not the module graph. */
async function loadOptions() {
  const options = await import('./command-palette-option.js').catch(() => null);
  assert.ok(options, 'the typed palette option primitive exists');
  return options;
}

const placement = { index: 0, selected: true, onActivate: () => {}, onHover: () => {} };

// #5878: a registered palette option cannot acquire a second name or invented id.
function paletteOptionTypeContract(runtime: Extract<Command, { runtimeSource: string }>): void {
  // @ts-expect-error Registry-backed palette rows do not take a literal label.
  const manualLabel: RegisteredPaletteOptionProps = { commandId: 'view:frame', label: 'Foo', ...placement };
  // @ts-expect-error Unknown commands cannot be rendered as registered rows.
  const unknownId: RegisteredPaletteOptionProps = { commandId: 'palette:made-up', ...placement };
  // The Model workspace rail commands (#6232) are registered palette ids too.
  const railIds: RegisteredPaletteOptionProps['commandId'][] = ['tool:wall', 'tool:slab', 'tool:column', 'tool:beam'];
  // @ts-expect-error A runtime row cannot be rendered without its runtime owner.
  const unowned: DynamicPaletteOptionProps = { command: { ...runtime, runtimeSource: undefined }, ...placement };
  const registered = { id: 'view:frame', label: 'Frame', labelKey: 'commandPalette.tool.wall.label', keywords: '',
    category: 'View', icon: FolderOpen, registryOwned: true, action: () => {} } as const;
  // @ts-expect-error A registered row renders only its registry label, so it takes no label parameters.
  const withParams: Command = { ...registered, labelKeyParams: { count: 1 } };
  // @ts-expect-error A registered row has no runtime detail to drop.
  const withDetail: Command = { ...registered, detail: '1.4 MB' };
  void manualLabel; void unknownId; void railIds; void unowned; void withParams; void withDetail;
}
void paletteOptionTypeContract;

afterEach(cleanup);

const runtime: Extract<Command, { runtimeSource: string }> = {
  id: 'file:recent:authoring-model', label: 'Authoring model.ifc', detail: '1.4 MB',
  keywords: '', category: 'File', icon: FolderOpen, runtimeSource: 'recent-file',
  action: () => {},
};

function registeredRow(id: string): Extract<Command, { registryOwned: true }> {
  return { id, label: id, labelKey: 'commandPalette.tool.wall.label', keywords: '', category: 'Tools',
    icon: FolderOpen, registryOwned: true, action: () => {} };
}

it('renders a registered palette action by id and keeps runtime rows separate (#5878)', async () => {
  const { RegisteredPaletteOption, DynamicPaletteOption } = await loadOptions();
  const command = surfaceCommand('view:frame', 'palette');
  let registeredClicks = 0;
  let runtimeClicks = 0;
  render(<>
    <RegisteredPaletteOption commandId={command.id} {...placement}
      onActivate={() => { registeredClicks++; }} />
    <DynamicPaletteOption command={runtime} {...placement} index={1} selected={false}
      onActivate={() => { runtimeClicks++; }} />
    <RegisteredPaletteOption commandId="export:ifc" {...placement} index={2} selected={false} />
  </>);
  const registered = document.querySelector<HTMLButtonElement>('[data-command-id="view:frame"]');
  assert.ok(registered);
  assert.equal(registered.getAttribute('aria-label'), resolveEnglish(command.labelKey));
  assert.equal(registered.hasAttribute('data-runtime-source'), false);
  assert.ok(registered.querySelector('svg.lucide-crosshair'));
  assert.equal(registered.querySelector('kbd')?.textContent, 'F');
  click(registered);
  assert.equal(registeredClicks, 1);

  const dynamic = document.querySelector<HTMLButtonElement>('[data-runtime-source="recent-file"]');
  assert.ok(dynamic);
  assert.equal(dynamic.dataset.runtimeCommandId, runtime.id);
  assert.equal(dynamic.hasAttribute('aria-label'), false, 'runtime rows keep their native name and detail');
  assert.ok(dynamic.textContent?.includes(runtime.label));
  assert.ok(dynamic.textContent?.includes('1.4 MB'));
  assert.equal(dynamic.hasAttribute('data-command-id'), false);
  click(dynamic);
  assert.equal(runtimeClicks, 1);

  const exportDefinition = EXPORT_SURFACE_COMMANDS.find((item) => item.id === 'export:ifc');
  assert.ok(exportDefinition);
  assert.equal(document.querySelector('[data-command-id="export:ifc"]')?.getAttribute('aria-label'),
    resolveEnglish(exportDefinition.labelKey));
});

it('resolves the Model workspace rail commands through the registry (#5878, #6232)', async () => {
  const { RegisteredPaletteOption } = await loadOptions();
  for (const id of ['tool:wall', 'tool:slab', 'tool:column', 'tool:beam'] as const) {
    const definition = surfaceCommand(id, 'palette');
    const shortcut = definition.shortcut;
    assert.ok(shortcut && shortcut.startsWith('model.'), `${id} shows its workspace key`);
    render(<RegisteredPaletteOption commandId={id} {...placement} />);
    const row = document.querySelector<HTMLButtonElement>(`[data-command-id="${id}"]`);
    assert.ok(row, id);
    assert.equal(row.getAttribute('aria-label'), resolveEnglish(definition.labelKey), id);
    assert.equal(row.querySelector('kbd')?.textContent, shortcutLabel(shortcut), id);
    cleanup();
  }
});

it('rejects fabricated and unowned palette ids (#5878)', async () => {
  const { DynamicPaletteOption, registeredPaletteId } = await loadOptions();
  assert.equal(registeredPaletteId(registeredRow('view:frame')), 'view:frame');
  assert.equal(registeredPaletteId(registeredRow('tool:wall')), 'tool:wall');
  assert.equal(registeredPaletteId(registeredRow('export:ifc')), 'export:ifc');
  assert.throws(() => registeredPaletteId(registeredRow('palette:made-up')), /Unknown registered palette command/);
  // A known registry or export id cannot bypass the registered option as a runtime row.
  for (const id of ['view:frame', 'tool:wall', 'export:ifc']) {
    assert.throws(() => render(<DynamicPaletteOption command={{ ...runtime, id }} {...placement} />),
      /must render as a registered palette option/, id);
    cleanup();
  }
});
