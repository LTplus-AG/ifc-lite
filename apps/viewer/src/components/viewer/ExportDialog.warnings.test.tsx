/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import type { Renderer } from '@ifc-lite/renderer';
import { clearGlobalRefs, setGlobalRendererRef } from '@/hooks/useBCF';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { render, cleanup, click, press, advance, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { ensureWasm } from '@/test/scan-slab-fixture';
import { ExportDialog } from './ExportDialog';
import { ExportDialogShell } from './ExportDialogShell';
import { downloadedNames, clearDownloads } from '@/test/download-capture';
import { chooseMerged, exportButton, openExportDialog } from './export-dialog-scope.test-support';

const initialState = useViewerStore.getState();
afterEach(() => {
  cleanup();
  clearDownloads();
  clearGlobalRefs();
  mock.restoreAll();
  useViewerStore.setState(initialState);
});

// Same lost ConditionCoordinateSystem case as schema-converter-structural-r2.test.ts.
// Inline STEP keeps the real parser/exporter regression runnable without external fixtures.
const source = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [StructuralAnalysisView]'),'2;1');
FILE_NAME('structural.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);
#3=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#3,$,$);
#50=IFCSTRUCTURALPOINTCONNECTION('0XciGbSFPUkgAKmWK4M6tc',$,$,$,$,$,$,$,#4);
ENDSEC;
END-ISO-10303-21;`;

async function structuralModel(id: string, idOffset = 0) {
  const model = fixtureModel(id, { idOffset });
  model.schemaVersion = 'IFC4';
  model.ifcDataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer);
  return model;
}

function mockToasts() {
  return {
    success: mock.method(toast, 'success', () => {}),
    info: mock.method(toast, 'info', () => {}),
    error: mock.method(toast, 'error', () => {}),
  };
}

async function chooseIfc2x3() {
  const schema = [...document.querySelectorAll('[role="combobox"]')].find(b => b.textContent?.trim().startsWith('IFC4'));
  assert.ok(schema);
  press(schema, 'ArrowDown');
  await advance(0);
  const option = [...document.querySelectorAll('[role="option"]')].find(b => b.textContent?.trim() === 'IFC2X3');
  assert.ok(option, `schema options: ${[...document.querySelectorAll('[role="option"]')].map(b => b.textContent).join(', ')}`);
  click(option);
}

async function runExport(toasts: ReturnType<typeof mockToasts>) {
  click(exportButton());
  await waitFor(() => toasts.success.mock.callCount() + toasts.info.mock.callCount() + toasts.error.mock.callCount() > 0, 'the export never reported');
  assert.equal(toasts.error.mock.callCount(), 0);
  assert.equal(downloadedNames().length, 1);
}

const details = () => document.body.querySelector('details')?.textContent ?? '';

for (const convert of [true, false]) {
  it(`STEP export ${convert ? 'shows structural warnings without a success toast' : 'keeps a success toast for a warning-free export'} (#10606)`, async () => {
    useViewerStore.setState({ ...fixtureModels(await structuralModel('structural.ifc')), dirtyModels: new Set() });
    const toasts = mockToasts();
    const ui = render(<ExportDialog surface="ribbon" />);
    openExportDialog(ui, 'Export IFC');
    if (convert) await chooseIfc2x3();
    await runExport(toasts);
    assert.equal(toasts.success.mock.callCount(), convert ? 0 : 1);
    assert.equal(toasts.info.mock.callCount(), convert ? 1 : 0);
    if (convert) {
      assert.match(toasts.info.mock.calls[0].arguments[0] ?? '', /^Exported .*\. \d+ warnings?$/);
      assert.match(details(), /ConditionCoordinateSystem has no slot in IFC2X3/);
      assert.match(details(), /restraint directions in that coordinate system are not preserved/);
      const cancel = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Cancel');
      assert.ok(cancel);
      click(cancel);
      openExportDialog(ui, 'Export IFC');
      assert.equal(document.querySelector('details'), null, 'reopening clears diagnostics from the previous export');
    }
  });
}

it('merged STEP export shows its warnings like the single-model export (#10606)', async () => {
  const [first, second] = await Promise.all([structuralModel('structural.ifc'), structuralModel('annex.ifc', 1_000_000)]);
  useViewerStore.setState({ ...fixtureModels(first, second), dirtyModels: new Set() });
  const toasts = mockToasts();
  const ui = render(<ExportDialog surface="ribbon" />);
  openExportDialog(ui, 'Export IFC');
  await chooseMerged();
  await chooseIfc2x3();
  await runExport(toasts);
  assert.equal(toasts.success.mock.callCount(), 0);
  assert.equal(toasts.info.mock.callCount(), 1);
  assert.match(toasts.info.mock.calls[0].arguments[0] ?? '', /^Merged 2 models, .*\. \d+ warnings?$/);
  assert.match(details(), /ConditionCoordinateSystem has no slot in IFC2X3/);
});

it('sectioned merged STEP export keeps each cropped model\'s warnings (#10606)', async (t) => {
  if (!ensureWasm(t)) return;
  const [first, second] = await Promise.all([structuralModel('structural.ifc'), structuralModel('annex.ifc', 1_000_000)]);
  useViewerStore.setState({ ...fixtureModels(first, second), dirtyModels: new Set() });
  setGlobalRendererRef({ current: { getCamera: () => ({ getSceneBounds: () => ({ min: { x: -5, y: -4, z: -3 }, max: { x: 5, y: 4, z: 3 } }) }) } as unknown as Renderer });
  const plane = useViewerStore.getState().sectionPlane;
  useViewerStore.setState({ sectionPlane: { ...plane, enabled: true, flipped: false, custom: { normal: [1, 0, 0], distance: 0, pickedAt: [0, 0, 0], tangent: [0, 1, 0], bitangent: [0, 0, 1] } } });
  const toasts = mockToasts();
  const ui = render(<ExportDialog surface="ribbon" />);
  openExportDialog(ui, 'Export IFC');
  await chooseMerged();
  await chooseIfc2x3();
  const visible = [...document.querySelectorAll('label')].find(el => el.textContent === 'Export Visible Only');
  const visibleToggle = visible?.parentElement?.parentElement?.querySelector('[role="switch"]');
  assert.ok(visibleToggle);
  click(visibleToggle);
  assert.ok(document.getElementById('trim-section-export'), 'the merged export is sectioned');
  await runExport(toasts);
  assert.equal(toasts.success.mock.callCount(), 0);
  assert.equal(toasts.info.mock.callCount(), 1);
  assert.match(details(), /ConditionCoordinateSystem has no slot in IFC2X3/);
});

it('caps displayed diagnostics while retaining their total count (#10606)', async () => {
  const warnings = Array.from({ length: 1_234 }, (_, i) => `Diagnostic ${i + 1}`);
  render(
    <ExportDialogShell trigger={<button>Open export dialog</button>} icon={<span />} title="Export" description="" cancelLabel="Cancel"
      exportLabel="Export" exportingLabel="Exporting..." onExport={async () => ({ success: true, message: 'done', warnings, warningLimit: 5 })}>
      <div />
    </ExportDialogShell>,
  );
  click([...document.querySelectorAll('button')].find(b => b.textContent === 'Open export dialog')!);
  click(exportButton());
  await waitFor(() => document.querySelector('details') !== null, 'the warnings render with the result');
  assert.equal(document.querySelectorAll('details li').length, 5);
  assert.equal(document.querySelector('summary')?.textContent, '1,234 warnings');
  assert.match(details(), /and 1,229 more/);
  assert.doesNotMatch(details(), /Diagnostic 6/);
});
