/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5835: export labels say what the export contains. On main the JSON row
 * read "Export JSON (All Data)" while exporting only the active model, and the
 * IFC dialog's "Changes Only" toggle (a JSON delta, or an IFCX overlay for
 * IFC5) read like the toolbar's "Export Changes" (full IFC files).
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';
import { render, cleanup, click } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { resolveEnglish } from '@/i18n/registry';
import { buildExportCommands } from './commandPaletteExports';
import { EXPORT_COMMANDS } from './toolbar/export-commands';
import { ExportDialog } from './ExportDialog';

const initialState = useViewerStore.getState();
afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState);
});

function openDialogFor(schemaVersion: FederatedModel['schemaVersion']): string {
  const model = fixtureModel('model');
  model.schemaVersion = schemaVersion;
  useViewerStore.setState({ ...fixtureModels(model), dirtyModels: new Set() });
  const ui = render(<ExportDialog />);
  const trigger = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('Export IFC'));
  assert.ok(trigger, 'the dialog trigger must render');
  click(trigger);
  return document.body.textContent ?? '';
}

describe('export labels say what the export contains (#5835)', () => {
  it('the JSON export is labelled as the active model only, in the menu and the palette', () => {
    const json = EXPORT_COMMANDS.find((c) => c.id === 'json');
    assert.ok(json);
    assert.equal(resolveEnglish(json.menuLabelKey), 'Export JSON (active model)');
    const row = buildExportCommands(() => {}).find((cmd) => cmd.id === 'export:json');
    assert.equal(row?.label, 'Export JSON (active model)');
  });

  it('the IFC dialog names the changes-only format: a JSON delta before IFC5', () => {
    const text = openDialogFor('IFC4');
    assert.match(text, /Changes only \(JSON delta\)/);
    assert.doesNotMatch(text, /Changes only \(IFCX overlay\)/);
  });

  it('the IFC dialog names the changes-only format: an IFCX overlay for IFC5', () => {
    const text = openDialogFor('IFC5');
    assert.match(text, /Changes only \(IFCX overlay\)/);
    assert.doesNotMatch(text, /JSON delta/);
  });

  it('the toolbar button that exports whole edited files says so', () => {
    assert.equal(resolveEnglish('exportChangesButton.buttonLabel'), 'Export modified IFC…');
  });
});
