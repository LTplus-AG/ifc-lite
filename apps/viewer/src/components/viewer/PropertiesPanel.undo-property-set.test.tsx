/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5965: Ctrl+Z / Ctrl+Shift+Z must undo and redo creating or deleting a whole
 * property set, in the panel AND in the exported file.
 *
 * Undo and redo had no branch for the whole-set mutation types, so the entry
 * was moved between the stacks and the view never changed: a set the user
 * "undid" still shipped in "Export changes", and an undone deletion stayed
 * deleted. Each step here goes through the real code: the real
 * `PropertiesPanel` and its "Add property" dialog, the store action the SDK
 * uses for a set deletion, `replayWorkspaceHistory` (what Ctrl+Z calls), and
 * the real "Export changes" STEP path, re-parsed so assertions read the FILE.
 */

import '@/test/setup-dom.js';

import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QuantityType } from '@ifc-lite/data';
import { advance, cleanup, render, type } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { extractPropertiesOnDemand, extractQuantitiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { replayWorkspaceHistory } from '@/lib/model-placement/history';
import {
  addPropertyThroughDialog, clickRowAction, exportAndReparse, fileRows, openInlineEditor, panelRows, parseStep, seedModel,
} from '@/test/properties-panel-harness.js';
import { latestToast } from '@/test/toasts.js';
import { Toaster } from '@/components/ui/toast';
import { PropertiesPanel } from './PropertiesPanel.js';

const MODEL_ID = 'm1';
const ID_OFFSET = 1_000_000;
const WALL = 72;

const guid = (mnemonic: string): string => (mnemonic + '0'.repeat(22)).slice(0, 22);

// Wall #72 carries two custom psets from the file: Custom_A (A1, A2) and Custom_B (B1).
const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCBUILDINGSTOREY('${guid('STOR')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#42= IFCBUILDING('${guid('BLDG')}',$,'B',$,$,#40,$,$,.ELEMENT.,$,$,$);
#43= IFCRELAGGREGATES('${guid('AGG1')}',$,$,$,#1,(#42));
#44= IFCRELAGGREGATES('${guid('AGG2')}',$,$,$,#42,(#41));
#45= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELC')}',$,$,$,(#72),#41);
#72= IFCWALL('${guid('WALA')}',$,'Wall A',$,$,#40,$,'tagA',$);
#81= IFCPROPERTYSINGLEVALUE('A1',$,IFCLABEL('a1'),$);
#82= IFCPROPERTYSINGLEVALUE('A2',$,IFCLABEL('a2'),$);
#80= IFCPROPERTYSET('${guid('PSA')}',$,'Custom_A',$,(#81,#82));
#83= IFCRELDEFINESBYPROPERTIES('${guid('RDA')}',$,$,$,(#72),#80);
#85= IFCPROPERTYSINGLEVALUE('B1',$,IFCLABEL('b1'),$);
#84= IFCPROPERTYSET('${guid('PSB')}',$,'Custom_B',$,(#85));
#86= IFCRELDEFINESBYPROPERTIES('${guid('RDB')}',$,$,$,(#72),#84);
ENDSEC;
END-ISO-10303-21;
`;

const FILE_ROWS = ['Custom_A.A1=a1', 'Custom_A.A2=a2', 'Custom_B.B1=b1'];
const PANEL_ROWS = ['72:Custom_A:A1', '72:Custom_A:A2', '72:Custom_B:B1'];

async function mountPanel(): Promise<{ store: IfcDataStore; container: HTMLElement }> {
  const store = await parseStep(MODEL);
  seedModel(MODEL_ID, ID_OFFSET, store, WALL);
  const container = render(<PropertiesPanel />);
  await advance(0);
  assert.deepEqual(panelRows(container), PANEL_ROWS);
  return { store, container };
}

/** What Ctrl+Z / Ctrl+Shift+Z do (`useKeyboardShortcuts`). */
async function press(direction: 'undo' | 'redo'): Promise<void> {
  replayWorkspaceHistory(useViewerStore.getState(), direction);
  await advance(0);
}

async function exportedPsets(store: IfcDataStore): Promise<string[]> {
  return fileRows(extractPropertiesOnDemand(await exportAndReparse(MODEL_ID, store), WALL));
}

let initialState: ReturnType<typeof useViewerStore.getState>;

describe('undo / redo of a whole property set reach the panel and the export (#5965)', () => {
  before(() => {
    initialState = useViewerStore.getState();
  });

  afterEach(() => {
    cleanup();
    useViewerStore.setState(initialState, true);
  });

  it('a set created through "Add property": undo removes it, redo brings it back', async () => {
    const { store, container } = await mountPanel();

    await addPropertyThroughDialog(container, 'Custom_New', 'N1', 'n1');
    assert.deepEqual(panelRows(container), [...PANEL_ROWS, '72:Custom_New:N1'].sort());

    await press('undo');
    assert.deepEqual(panelRows(container), PANEL_ROWS);
    assert.deepEqual(await exportedPsets(store), FILE_ROWS);

    await press('redo');
    assert.deepEqual(panelRows(container), [...PANEL_ROWS, '72:Custom_New:N1'].sort());
    assert.deepEqual(await exportedPsets(store), [...FILE_ROWS, 'Custom_New.N1=n1'].sort());
  });

  it('a deleted file set with an edited member: undo restores every property, edit included; redo deletes again', async () => {
    const { store, container } = await mountPanel();

    const a1 = await openInlineEditor(container, '72:Custom_A:A1');
    const input = a1.querySelector('input[placeholder="Enter value"]');
    assert.ok(input, 'the inline editor must offer a value input');
    type(input as HTMLInputElement, 'a1-edited');
    await clickRowAction(a1, 'lucide-check');

    assert.ok(useViewerStore.getState().deletePropertySet(MODEL_ID, WALL, 'Custom_A'));
    await advance(0);
    assert.deepEqual(panelRows(container), ['72:Custom_B:B1']);
    assert.deepEqual(await exportedPsets(store), ['Custom_B.B1=b1']);

    await press('undo');
    assert.deepEqual(panelRows(container), PANEL_ROWS);
    assert.deepEqual(await exportedPsets(store), ['Custom_A.A1=a1-edited', 'Custom_A.A2=a2', 'Custom_B.B1=b1']);

    await press('redo');
    assert.deepEqual(panelRows(container), ['72:Custom_B:B1']);
    assert.deepEqual(await exportedPsets(store), ['Custom_B.B1=b1']);

    // Unwinding past the deletion still reaches the edit beneath it.
    await press('undo');
    await press('undo');
    assert.deepEqual(await exportedPsets(store), FILE_ROWS);
  });

  it('a created quantity set: undo removes it from the export, redo writes it again', async () => {
    const { store } = await mountPanel();
    const quantityRows = async () => (extractQuantitiesOnDemand(await exportAndReparse(MODEL_ID, store), WALL))
      .flatMap((q) => q.quantities.map((x) => `${q.name}.${x.name}=${x.value}`));

    assert.ok(useViewerStore.getState().createQuantitySet(MODEL_ID, WALL, 'Qto_Custom', [
      { name: 'Volume', value: 12, quantityType: QuantityType.Volume },
    ]));
    assert.deepEqual(await quantityRows(), ['Qto_Custom.Volume=12']);

    await press('undo');
    assert.deepEqual(await quantityRows(), []);

    await press('redo');
    assert.deepEqual(await quantityRows(), ['Qto_Custom.Volume=12']);
  });

  it('a whole-set record with no snapshot to restore tells the user instead of passing for done', async () => {
    const { container } = await mountPanel();
    render(<Toaster />);
    // Hand-built, as only a caller bypassing `MutablePropertyView` could make it.
    useViewerStore.setState((s) => ({
      undoStacks: new Map(s.undoStacks).set(MODEL_ID, [{
        id: 'hand-built', type: 'DELETE_PROPERTY_SET', timestamp: Date.now(), modelId: MODEL_ID, entityId: WALL, psetName: 'Custom_A',
      }]),
    }));
    await press('undo');
    assert.match(latestToast(), /Could not undo this change/);
    assert.deepEqual(panelRows(container), PANEL_ROWS);
  });
});
