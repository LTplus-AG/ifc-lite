/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5672: adding a property must never cost the user the properties already
 * there.
 *
 * Reported against the viewer as two symptoms:
 *   (a) adding a property in a NEW custom pset made every other custom pset
 *       disappear;
 *   (b) adding a property to an EXISTING custom pset dropped that pset's other
 *       properties while the other psets survived.
 *
 * Both came from one cause. The loader publishes the spatial-ready PARTIAL
 * store first (empty property table, no `onDemandPropertyMap`) and swaps in
 * the full store when property parsing finishes. A mutation view created in
 * between -- selecting an element while a large file is still parsing is
 * enough -- stayed bound to the partial store, so it saw no base psets on any
 * entity. Its first edit made the overlay's picture the whole picture: (a) in
 * the panel, and (b) in the panel AND the exported IFC, whose regenerated pset
 * held only the new property.
 *
 * Everything here runs through the real code: a real parsed store delivered in
 * the loader's partial-then-full order, the real `PropertiesPanel` (which
 * creates its view on mount), the real "Add property" dialog, and the real
 * "Export changes" STEP path, re-parsed so the assertions read the FILE.
 */

import '@/test/setup-dom.js';

import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { advance, cleanup, render, type } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { extractPropertiesOnDemand, extractTypeEntityOwnProperties, type IfcDataStore } from '@ifc-lite/parser';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import {
  addPropertyThroughDialog, clickRowAction, exportAndReparse as exportModelAndReparse, fileRows, openInlineEditor,
  panelRows, parseStep, seedModel as seedHarnessModel,
} from '@/test/properties-panel-harness.js';
import { PropertiesPanel } from './PropertiesPanel.js';

const MODEL_ID = 'm1';
const ID_OFFSET = 1_000_000;
const WALL = 72;
const WALL_TYPE = 90;

const guid = (mnemonic: string): string => (mnemonic + '0'.repeat(22)).slice(0, 22);

// Wall #72 carries two custom psets from the file (Custom_A: A1, A2 and
// Custom_B: B1). Its type #90 owns Custom_T (T1, T2) through HasPropertySets.
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
#90= IFCWALLTYPE('${guid('WTYP')}',$,'WT',$,$,(#91),$,$,$,.STANDARD.);
#92= IFCPROPERTYSINGLEVALUE('T1',$,IFCLABEL('t1'),$);
#93= IFCPROPERTYSINGLEVALUE('T2',$,IFCLABEL('t2'),$);
#91= IFCPROPERTYSET('${guid('PST')}',$,'Custom_T',$,(#92,#93));
#94= IFCRELDEFINESBYTYPE('${guid('RDT')}',$,$,$,(#72),#90);
ENDSEC;
END-ISO-10303-21;
`;

/** The loader's two store publications, in its order. */
async function parseLikeTheLoader(): Promise<{ partial: IfcDataStore; full: IfcDataStore }> {
  let partial: IfcDataStore | null = null;
  const full = await parseStep(MODEL, (p) => { partial = p; });
  assert.ok(partial, 'the parser must publish a spatial-ready partial store');
  return { partial, full };
}

function seedModel(store: IfcDataStore, selected: number): void {
  seedHarnessModel(MODEL_ID, ID_OFFSET, store, selected);
}

const TYPE_ROWS = ['90:Custom_T:T1', '90:Custom_T:T2'];

const exportAndReparse = (store: IfcDataStore): Promise<IfcDataStore> => exportModelAndReparse(MODEL_ID, store);

let initialState: ReturnType<typeof useViewerStore.getState>;

describe('Add property keeps every existing property set and property (#5672)', () => {
  before(() => {
    initialState = useViewerStore.getState();
  });

  afterEach(() => {
    cleanup();
    useViewerStore.setState(initialState, true);
  });

  for (const timing of ['while the file is still parsing', 'after parsing finished'] as const) {
    it(`new set, then a property on a file set, then one on the session set -- panel opened ${timing}`, async () => {
      const { partial, full } = await parseLikeTheLoader();
      seedModel(timing === 'after parsing finished' ? full : partial, WALL);
      const container = render(<PropertiesPanel />);
      await advance(0);
      // The loader's `onFullDataStore` -> `setIfcDataStore(full)`.
      useViewerStore.getState().setIfcDataStore(full);
      await advance(0);
      assert.deepEqual(panelRows(container), ['72:Custom_A:A1', '72:Custom_A:A2', '72:Custom_B:B1', ...TYPE_ROWS]);

      // (a) a property in a NEW custom set: the file's sets stay.
      await addPropertyThroughDialog(container, 'Custom_New', 'N1', 'n1');
      assert.deepEqual(panelRows(container), ['72:Custom_A:A1', '72:Custom_A:A2', '72:Custom_B:B1', '72:Custom_New:N1', ...TYPE_ROWS]);

      // (b) a property in an EXISTING custom set from the file: its siblings stay.
      await addPropertyThroughDialog(container, 'Custom_A', 'A3', 'a3');
      assert.deepEqual(panelRows(container), ['72:Custom_A:A1', '72:Custom_A:A2', '72:Custom_A:A3', '72:Custom_B:B1', '72:Custom_New:N1', ...TYPE_ROWS]);

      // ...and the same for a custom set created earlier in this session.
      await addPropertyThroughDialog(container, 'Custom_New', 'N2', 'n2');
      assert.deepEqual(panelRows(container), ['72:Custom_A:A1', '72:Custom_A:A2', '72:Custom_A:A3', '72:Custom_B:B1', '72:Custom_New:N1', '72:Custom_New:N2', ...TYPE_ROWS]);

      // The exported file carries every set and every property.
      const reparsed = await exportAndReparse(full);
      assert.deepEqual(fileRows(extractPropertiesOnDemand(reparsed, WALL)), [
        'Custom_A.A1=a1', 'Custom_A.A2=a2', 'Custom_A.A3=a3',
        'Custom_B.B1=b1',
        'Custom_New.N1=n1', 'Custom_New.N2=n2',
      ]);
    });
  }

  it('editing and deleting a file property keep its siblings -- panel opened while the file is still parsing', async () => {
    const { partial, full } = await parseLikeTheLoader();
    seedModel(partial, WALL);
    const container = render(<PropertiesPanel />);
    await advance(0);
    useViewerStore.getState().setIfcDataStore(full);
    await advance(0);

    const a1 = await openInlineEditor(container, '72:Custom_A:A1');
    const input = a1.querySelector('input[placeholder="Enter value"]');
    assert.ok(input, 'the inline editor must offer a value input');
    type(input as HTMLInputElement, 'a1-edited');
    await clickRowAction(a1, 'lucide-check');

    const a2 = await openInlineEditor(container, '72:Custom_A:A2');
    await clickRowAction(a2, 'lucide-trash-2');

    assert.deepEqual(panelRows(container), ['72:Custom_A:A1', '72:Custom_B:B1', ...TYPE_ROWS]);
    const reparsed = await exportAndReparse(full);
    assert.deepEqual(fileRows(extractPropertiesOnDemand(reparsed, WALL)), ['Custom_A.A1=a1-edited', 'Custom_B.B1=b1']);
  });

  it('a type whose view the SDK adapter created after parsing finished still reads its own sets', async () => {
    const { full } = await parseLikeTheLoader();
    seedModel(full, WALL_TYPE);
    // No store swap here: this isolates the SDK adapter's own configuration,
    // which used to install the occurrence extractor for a type entity too.
    assert.ok(getOrCreateMutationView(useViewerStore, MODEL_ID));
    const container = render(<PropertiesPanel />);
    await advance(0);
    assert.deepEqual(panelRows(container), ['90:Custom_T:T1', '90:Custom_T:T2']);

    await addPropertyThroughDialog(container, 'Custom_TNew', 'X1', 'x1');
    assert.deepEqual(panelRows(container), ['90:Custom_T:T1', '90:Custom_T:T2', '90:Custom_TNew:X1']);
  });

  it('a type whose view the SDK adapter created keeps its own sets when a new one is added', async () => {
    const { partial, full } = await parseLikeTheLoader();
    seedModel(partial, WALL_TYPE);
    // A non-panel creator got there first (authoring, appearance, flow tables
    // all use `getOrCreateMutationView`), while the file was still parsing.
    assert.ok(getOrCreateMutationView(useViewerStore, MODEL_ID));
    const container = render(<PropertiesPanel />);
    await advance(0);
    useViewerStore.getState().setIfcDataStore(full);
    await advance(0);
    assert.deepEqual(panelRows(container), ['90:Custom_T:T1', '90:Custom_T:T2']);

    await addPropertyThroughDialog(container, 'Custom_TNew', 'X1', 'x1');
    assert.deepEqual(panelRows(container), ['90:Custom_T:T1', '90:Custom_T:T2', '90:Custom_TNew:X1']);

    await addPropertyThroughDialog(container, 'Custom_T', 'T3', 't3');
    assert.deepEqual(panelRows(container), ['90:Custom_T:T1', '90:Custom_T:T2', '90:Custom_T:T3', '90:Custom_TNew:X1']);

    const reparsed = await exportAndReparse(full);
    assert.deepEqual(fileRows(extractTypeEntityOwnProperties(reparsed, WALL_TYPE)), [
      'Custom_T.T1=t1', 'Custom_T.T2=t2', 'Custom_T.T3=t3', 'Custom_TNew.X1=x1',
    ]);
  });
});
