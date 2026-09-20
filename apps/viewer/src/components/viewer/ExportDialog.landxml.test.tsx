/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { useViewerStore } from '@/store';
import { render, cleanup, click } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { ExportDialog } from './ExportDialog.js';

const initialState = useViewerStore.getState();

afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState);
});

function landXmlModel(id: string) {
  const model = fixtureModel(id);
  model.sourceSchema = 'LandXML-1.2';
  model.schemaVersion = 'IFC4';
  return model;
}

function openDialog(): void {
  const trigger = [...document.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('Export IFC'));
  assert.ok(trigger, 'the export trigger is available');
  click(trigger);
}

function exportButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === 'Export');
  assert.ok(button, 'the dialog renders its export action');
  return button;
}

describe('ExportDialog LandXML source fidelity (#5042)', () => {
  it('refuses IFC export from a LandXML-only model instead of synthesizing IFC', () => {
    const terrain = landXmlModel('survey.xml');
    useViewerStore.setState({ ...fixtureModels(terrain), dirtyModels: new Set() });
    render(<ExportDialog />);
    openDialog();

    assert.match(document.body.textContent ?? '', /LandXML cannot be exported as IFC/);
    assert.match(document.body.textContent ?? '', /no IFC entities are synthesized for export/);
    assert.equal(exportButton().disabled, true, 'a LandXML source has no IFC export action');
  });

  it('refuses merged IFC export when any participating model is LandXML', () => {
    const authored = fixtureModel('building.ifc');
    authored.schemaVersion = 'IFC4';
    const terrain = landXmlModel('survey.xml');
    useViewerStore.setState({ ...fixtureModels(authored, terrain), dirtyModels: new Set() });
    render(<ExportDialog />);
    openDialog();

    const scope = document.querySelector('[role="combobox"]');
    assert.ok(scope, 'multiple models expose a scope selector');
    click(scope);
    const merged = [...document.querySelectorAll('[role="option"]')]
      .find((option) => option.textContent?.includes('Merged (All Models)'));
    assert.ok(merged, 'merged scope is offered before the source-aware guard evaluates it');
    click(merged);

    assert.match(document.body.textContent ?? '', /LandXML cannot be exported as IFC/);
    assert.equal(exportButton().disabled, true, 'a mixed IFC/LandXML merge cannot fabricate terrain IFC entities');
  });
});
