/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9026 item 5: a session that authored elements read "N entities have been
 * modified" in the dialog and "Exported M entities (0 modified)" in the toast
 * after exporting them, because the toast read the exporter's count of source
 * lines rewritten in place. The dialog and the real exporter run here; only the
 * toast and the browser download are captured.
 */
import '@/test/setup-dom.js';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { render, cleanup, click, advance } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { clearDownloads, downloadedNames } from '@/test/download-capture';
import { stepExportSummary } from '@/lib/export/step-export-summary';
import { ExportDialog } from './ExportDialog.js';

const initialState = useViewerStore.getState();
afterEach(() => {
  cleanup();
  clearDownloads();
  mock.restoreAll();
  useViewerStore.setState(initialState);
});

const MODEL = 'export-counts';
const STOREY = 40;
const SOURCE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,(#20),#30);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#35=IFCSITE('1hQBAVPOr5VxhS3Jl0O47h',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#36=IFCBUILDING('3hQBAVPOr5VxhS3Jl0O47h',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#40=IFCBUILDINGSTOREY('2hQBAVPOr5VxhS3Jl0O47h',$,'L0',$,$,$,$,$,.ELEMENT.,0.);
#70=IFCRELAGGREGATES('0kTvXnbbzCWw8lcMd1dR4o',$,$,$,#1,(#35));
#71=IFCRELAGGREGATES('1kTvXnbbzCWw8lcMd1dR4o',$,$,$,#35,(#36));
#72=IFCRELAGGREGATES('2kTvXnbbzCWw8lcMd1dR4o',$,$,$,#36,(#40));
ENDSEC;
END-ISO-10303-21;`;

async function seedWithAuthoredWalls(): Promise<number> {
  const bytes = new TextEncoder().encode(SOURCE);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
  const model = { ...fixtureModel(MODEL), ifcDataStore: store, schemaVersion: 'IFC4' as const };
  const view = new MutablePropertyView(store.properties || null, MODEL);
  useViewerStore.setState({
    ...fixtureModels(model), activeModelId: MODEL, editEnabled: true,
    mutationViews: new Map([[MODEL, view]]), storeEditors: new Map(),
    undoStacks: new Map(), redoStacks: new Map(), dirtyModels: new Set(), mutationVersion: 0,
  });
  for (const x of [0, 5]) {
    const wall = useViewerStore.getState().addWall(MODEL, STOREY, { Start: [x, 0, 0], End: [x + 4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in wall);
  }
  return view.getModifiedEntityCount();
}

it('the toast after exporting authored elements repeats the count the dialog showed', async () => {
  const pending = await seedWithAuthoredWalls();
  assert.ok(pending > 2, 'two walls and their helper entities are pending');
  const success = mock.method(toast, 'success', () => undefined);

  const ui = render(<ExportDialog surface="ribbon" />);
  const trigger = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('Export IFC'));
  assert.ok(trigger);
  click(trigger);
  await advance(10);
  assert.match(document.body.textContent ?? '', new RegExp(`${pending} entities have been modified`));

  const run = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Export');
  assert.ok(run);
  click(run);
  for (let i = 0; i < 20 && success.mock.callCount() === 0; i++) await advance(50);

  assert.equal(downloadedNames().length, 1);
  const message = String(success.mock.calls[0]?.arguments[0]);
  assert.match(message, new RegExp(`\\(${pending} modified\\)$`));
  const written = Number(/^Exported (\d+) entities/.exec(message)?.[1]);
  assert.ok(written > pending, 'the file holds the source entities as well');
});

it('claims no change an export did not apply or may not have written', () => {
  const base = { entityCount: 431, pendingChanges: 399, applyMutations: true, visibleOnly: false };
  assert.equal(stepExportSummary(base), 'Exported 431 entities (399 modified)');
  assert.equal(stepExportSummary({ ...base, applyMutations: false }), 'Exported 431 entities (0 modified)');
  assert.equal(stepExportSummary({ ...base, visibleOnly: true }), 'Exported 431 entities');
});
