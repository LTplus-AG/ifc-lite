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
import { advance, cleanup, click, render, type } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { IfcParser, extractPropertiesOnDemand, extractTypeEntityOwnProperties, type IfcDataStore } from '@ifc-lite/parser';
import { exportChangedModelToStep } from '@/lib/export/changed-model-export';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
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

async function parseStep(step: string | Uint8Array, onSpatialReady?: (partial: IfcDataStore) => void): Promise<IfcDataStore> {
  const bytes = typeof step === 'string' ? new TextEncoder().encode(step) : step;
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    onSpatialReady ? { onSpatialReady } : undefined,
  );
}

/** The loader's two store publications, in its order. */
async function parseLikeTheLoader(): Promise<{ partial: IfcDataStore; full: IfcDataStore }> {
  let partial: IfcDataStore | null = null;
  const full = await parseStep(MODEL, (p) => { partial = p; });
  assert.ok(partial, 'the parser must publish a spatial-ready partial store');
  return { partial, full };
}

function seedModel(store: IfcDataStore, selected: number): void {
  useViewerStore.setState({
    models: new Map([[MODEL_ID, {
      id: MODEL_ID,
      name: MODEL_ID,
      ifcDataStore: store,
      geometryResult: null,
      visible: true,
      idOffset: ID_OFFSET,
      maxExpressId: 100_000,
      loadedAt: 1,
    }]]) as never,
    activeModelId: MODEL_ID,
    ifcDataStore: store,
    selectedEntity: { modelId: MODEL_ID, expressId: selected },
    selectedEntityId: selected + ID_OFFSET,
    selectedEntityIds: new Set<number>(),
    isolatedEntities: null,
    propertiesActiveTab: 'properties',
    editEnabled: true,
    collabRole: null,
  });
}

/**
 * Rendered property rows as PropertySetCard's `data-prop-key`,
 * "<entityId>:<Pset>:<Prop>". A wall's panel also lists its type's sets under
 * the type's id, so those rows show the type section survived too.
 */
function panelRows(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-prop-key]')]
    .map((el) => el.getAttribute('data-prop-key') ?? '')
    .sort();
}

const TYPE_ROWS = ['90:Custom_T:T1', '90:Custom_T:T2'];

function inputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = document.body.querySelector(`input[placeholder="${placeholder}"]`);
  assert.ok(input, `input "${placeholder}" must render`);
  return input as HTMLInputElement;
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  assert.ok(button, `button "${text}" must render`);
  return button as HTMLButtonElement;
}

/** What a user does: open "Add property", pick a custom set name, fill it in, submit. */
async function addPropertyThroughDialog(container: HTMLElement, psetName: string, propName: string, value: string): Promise<void> {
  const trigger = container.querySelector('button[title="Add property"]');
  assert.ok(trigger, 'the edit toolbar must offer "Add property"');
  click(trigger);
  await advance(0);
  click(buttonByText('Custom name'));
  await advance(0);
  type(inputByPlaceholder('e.g., Pset_MyCustomProperties'), psetName);
  type(inputByPlaceholder('e.g., FireRating'), propName);
  type(inputByPlaceholder('Property value'), value);
  await advance(0);
  const submit = buttonByText('Add Property');
  assert.equal(submit.disabled, false, 'submit must be enabled once set and property are named');
  click(submit);
  await advance(0);
}

/** Open the inline editor on one rendered row (a click on its value). */
async function openInlineEditor(container: HTMLElement, propKey: string): Promise<HTMLElement> {
  const row = container.querySelector(`[data-prop-key="${propKey}"]`);
  assert.ok(row, `row ${propKey} must render`);
  const value = row.querySelector('span[title="Click to edit"]');
  assert.ok(value, `row ${propKey} must be editable`);
  click(value);
  await advance(0);
  return row as HTMLElement;
}

async function clickRowAction(row: HTMLElement, iconClass: string): Promise<void> {
  const button = row.querySelector(`svg.${iconClass}`)?.closest('button');
  assert.ok(button, `row action ${iconClass} must render`);
  click(button);
  await advance(0);
}

async function exportAndReparse(store: IfcDataStore): Promise<IfcDataStore> {
  const view = useViewerStore.getState().mutationViews.get(MODEL_ID);
  assert.ok(view, 'the edits must live on a registered mutation view');
  const artifact = await exportChangedModelToStep(MODEL_ID, store, view, {
    schema: 'IFC4',
    scheduleState: null,
    description: 'ViewDefinition [CoordinationView]',
  });
  assert.equal(artifact.ext, 'ifc');
  const bytes = typeof artifact.content === 'string' ? new TextEncoder().encode(artifact.content) : artifact.content;
  return parseStep(bytes);
}

function fileRows(psets: Array<{ name: string; properties: Array<{ name: string; value: unknown }> }>): string[] {
  return psets.flatMap((p) => p.properties.map((q) => `${p.name}.${q.name}=${String(q.value)}`)).sort();
}

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
