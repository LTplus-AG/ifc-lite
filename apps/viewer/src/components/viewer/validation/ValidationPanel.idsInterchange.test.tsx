/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Data validation panel: import an IDS as rules, extend it, and export the
 * rule set back as IDS (#5225). Drives the real file input and the real
 * "Export as IDS" button; the downloaded bytes are parsed back with the
 * IDS package's own parser.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { parseIDS } from '@ifc-lite/ids';
import { cleanup, click, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { ValidationPanel } from './ValidationPanel.js';
import { resetValidationPanelFixture } from './validation-test-fixture.js';

const IDS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>BEP deliverable</title></info>
  <specifications>
    <specification name="Walls are rated" ifcVersion="IFC2X3 IFC4 IFC4X3_ADD2" identifier="EIR-001">
      <applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
      <requirements>
        <property cardinality="required" dataType="IFCLABEL"><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet><baseName><simpleValue>FireRating</simpleValue></baseName></property>
      </requirements>
    </specification>
    <specification name="Walls sit on a storey" ifcVersion="IFC2X3 IFC4 IFC4X3_ADD2">
      <applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
      <requirements>
        <partOf relation="IFCRELCONTAINEDINSPATIALSTRUCTURE" cardinality="required"><entity><name><simpleValue>IFCBUILDINGSTOREY</simpleValue></name></entity></partOf>
      </requirements>
    </specification>
  </specifications>
</ids>`;

async function selectFile(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition never became true');
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
}

function captureDownload(run: () => void): { filename: string; blob?: Blob } {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  let filename = '';
  let blob: Blob | undefined;
  URL.createObjectURL = ((b: Blob) => { blob = b; return 'blob:ids-test'; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { filename = this.download; };
  try {
    run();
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    HTMLAnchorElement.prototype.click = originalClick;
  }
  return { filename, blob };
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  assert.ok(button, `no button "${text}"`);
  return button as HTMLButtonElement;
}

beforeEach(resetValidationPanelFixture);

afterEach(cleanup);

describe('ValidationPanel — IDS import and export (#5225)', () => {
  it('imports the simple specification, lists the refused one with its reason, and exports back to IDS', async () => {
    useViewerStore.setState({ models: new Map() });
    const ui = render(<ValidationPanel />);

    const input = ui.querySelector('[data-testid="validation-import-ids-input"]') as HTMLInputElement;
    assert.ok(input, 'the Import IDS input is rendered in the empty state');
    await selectFile(input, new File([IDS_XML], 'bep.ids', { type: 'application/xml' }));
    await waitFor(() => (ui.textContent ?? '').includes('Imported 1 of 2 IDS specifications as rules.'));

    const summary = ui.querySelector('[data-testid="ids-interchange-summary"]')?.textContent ?? '';
    assert.ok(summary.includes('Walls sit on a storey'), 'the refused specification is named');
    assert.ok(summary.includes('partOf facet'), 'with its reason');
    assert.ok(summary.includes('Imported without these checks'), 'dropped checks are listed (#5225 decision)');
    assert.ok(summary.includes('Walls are rated: Pset_WallCommon.FireRating: data type IFCLABEL not checked'));

    const names = [...ui.querySelectorAll('input')].map((i) => (i as HTMLInputElement).value);
    assert.ok(names.includes('BEP deliverable'), 'the rule set is named after the IDS title');
    assert.ok(names.includes('Walls are rated'), 'the imported rule is in the editor');

    const { filename, blob } = captureDownload(() => click(buttonByText(ui, 'Export as IDS')));
    assert.equal(filename, 'BEP deliverable.ids');
    assert.ok(blob);
    const exported = parseIDS(await blob.text());
    assert.deepEqual(exported.specifications.map((s) => s.name), ['Walls are rated']);
    assert.equal(exported.specifications[0].identifier, 'EIR-001');
    assert.ok((ui.textContent ?? '').includes('Exported 1 of 1 rules to IDS.'));
  });

  it('reports an unreadable file instead of loading anything', async () => {
    useViewerStore.setState({ models: new Map() });
    const ui = render(<ValidationPanel />);
    const input = ui.querySelector('[data-testid="validation-import-ids-input"]') as HTMLInputElement;
    await selectFile(input, new File(['not xml'], 'broken.ids', { type: 'application/xml' }));
    await waitFor(() => (ui.textContent ?? '').includes('is not a readable IDS file'));
    assert.ok((ui.textContent ?? '').includes('"broken.ids"'));
  });
});
