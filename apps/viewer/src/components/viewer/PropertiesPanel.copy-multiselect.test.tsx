/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5900: every attribute / property / quantity value row carries a copy
 * button that writes the displayed value (Shift: `Name=Value`) and confirms
 * with a toast, and a multi-selection is summarised instead of showing only
 * its primary element. Mounted over REAL parsed stores, two federated models.
 */

import '@/test/setup-dom.js';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { advance, cleanup, click, render } from '@/test/render.js';
import { parseStep } from '@/test/properties-panel-harness.js';
import { latestToast } from '@/test/toasts.js';
import { Toaster } from '@/components/ui/toast.js';
import { useViewerStore } from '@/store';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import type { IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { configureMutationView } from '@/utils/configureMutationView.js';
import { PropertiesPanel } from './PropertiesPanel.js';

const guid = (name: string) => (name + '0'.repeat(22)).slice(0, 22);

/** One model: walls with a shared FireRating, an AcousticRating per wall, and a Width quantity. */
function stepFor(prefix: string, walls: Array<{ id: number; name: string; acoustic: string }>): string {
  const wallIds = walls.map((w) => `#${w.id}`).join(',');
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('${prefix}','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('${guid(`${prefix}PROJ`)}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
${walls.map((w) => `#${w.id}= IFCWALL('${guid(`${prefix}W${w.id}`)}',$,'${w.name}',$,$,#40,$,'tag${w.id}',$);`).join('\n')}
#81= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI60'),$);
#80= IFCPROPERTYSET('${guid(`${prefix}PSF`)}',$,'Pset_WallCommon',$,(#81));
#83= IFCRELDEFINESBYPROPERTIES('${guid(`${prefix}RDF`)}',$,$,$,(${wallIds}),#80);
${walls.map((w, i) => `#${90 + i * 3}= IFCPROPERTYSINGLEVALUE('AcousticRating',$,IFCLABEL('${w.acoustic}'),$);
#${91 + i * 3}= IFCPROPERTYSET('${guid(`${prefix}PA${i}`)}',$,'Custom_Acoustic',$,(#${90 + i * 3}));
#${92 + i * 3}= IFCRELDEFINESBYPROPERTIES('${guid(`${prefix}RA${i}`)}',$,$,$,(#${w.id}),#${91 + i * 3});`).join('\n')}
#181= IFCQUANTITYLENGTH('Width',$,$,0.2);
#180= IFCELEMENTQUANTITY('${guid(`${prefix}QTO`)}',$,'Qto_WallBaseQuantities',$,$,(#181));
#182= IFCRELDEFINESBYPROPERTIES('${guid(`${prefix}RDQ`)}',$,$,$,(${wallIds}),#180);
ENDSEC;
END-ISO-10303-21;
`;
}

const OFFSET_A = 1_000_000;
const OFFSET_B = 2_000_000;
let storeA: IfcDataStore;
let storeB: IfcDataStore;
let authoredStore: IfcDataStore;
let initialState: ReturnType<typeof useViewerStore.getState>;
let clipboardWrites: string[] = [];

function model(id: string, name: string, store: IfcDataStore, idOffset: number) {
  return { id, name, ifcDataStore: store, geometryResult: null, visible: true, idOffset, maxExpressId: 100_000, loadedAt: 1 };
}

function seed(selection: { primary: [string, number]; set?: string[] }): void {
  const [modelId, expressId] = selection.primary;
  useViewerStore.setState({
    models: new Map([['a', model('a', 'Architecture.ifc', storeA, OFFSET_A)], ['b', model('b', 'Structure.ifc', storeB, OFFSET_B)]]) as never,
    activeModelId: 'a',
    selectedEntity: { modelId, expressId },
    selectedEntityId: expressId + (modelId === 'a' ? OFFSET_A : OFFSET_B),
    selectedEntityIds: new Set<number>(),
    selectedEntitiesSet: new Set(selection.set ?? []),
    selectedModelId: null,
    selectedEntities: [],
    propertiesActiveTab: 'properties',
    editEnabled: false,
  });
}

function mount(): HTMLElement {
  return render(<><PropertiesPanel /><Toaster /></>);
}

function copyButton(root: ParentNode, name: string): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>(`button[aria-label="Copy ${name}"]`);
  assert.ok(button, `"${name}" must have a copy button`);
  return button;
}

async function copyThrough(button: HTMLButtonElement, init: MouseEventInit = {}): Promise<string | undefined> {
  const before = clipboardWrites.length;
  click(button, init);
  await advance(0);
  return clipboardWrites.length > before ? clipboardWrites.at(-1) : undefined;
}

describe('Properties panel value copy and multi-selection summary (#5900)', () => {
  before(async () => {
    initialState = useViewerStore.getState();
    storeA = await parseStep(stepFor('A', [{ id: 72, name: 'Wall A', acoustic: 'Rw50' }, { id: 73, name: 'Wall B', acoustic: 'Rw50' }]));
    storeB = await parseStep(stepFor('B', [{ id: 72, name: 'Wall C', acoustic: 'Rw45' }]));
    authoredStore = await parseStep(new Uint8Array(readFileSync(new URL('../../../public/samples/building-architecture.ifc', import.meta.url))));
  });
  beforeEach(() => {
    clipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { clipboardWrites.push(text); } },
    });
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    useViewerStore.setState(initialState, true);
  });

  it('puts a copy button on every attribute, property and quantity row that writes the displayed value', async () => {
    seed({ primary: ['a', 72] });
    const panel = mount();

    const propertyRows = [...panel.querySelectorAll<HTMLElement>('[data-prop-key]')];
    assert.deepEqual(propertyRows.map((row) => row.getAttribute('data-prop-key')).sort(), ['72:Custom_Acoustic:AcousticRating', '72:Pset_WallCommon:FireRating']);
    for (const row of propertyRows) {
      const name = row.getAttribute('data-prop-key')!.split(':').at(-1)!;
      assert.ok(row.querySelector(`button[aria-label="Copy ${name}"]`), `property row ${name} carries its own copy button`);
    }
    assert.equal(await copyThrough(copyButton(panel, 'FireRating')), 'REI60');
    assert.match(latestToast(), /Copied to clipboard/);
    assert.equal(await copyThrough(copyButton(panel, 'AcousticRating'), { shiftKey: true }), 'AcousticRating=Rw50', 'Shift copies Name=Value');

    // Attributes: every rendered attribute row copies its own value.
    assert.equal(await copyThrough(copyButton(panel, 'Name')), 'Wall A');
    assert.equal(await copyThrough(copyButton(panel, 'Tag')), 'tag72');
    // The GlobalId keeps its own button, on the same clipboard path.
    const globalIdButton = panel.querySelector<HTMLButtonElement>('button[aria-label="Copy GlobalId"]');
    assert.ok(globalIdButton);
    assert.equal(await copyThrough(globalIdButton), guid('AW72'));

    act(() => useViewerStore.setState({ propertiesActiveTab: 'quantities' }));
    assert.equal(await copyThrough(copyButton(panel, 'Width')), '0.2 m', 'a quantity copies with its displayed unit');
  });

  it('says so instead of ticking when the clipboard refuses the write', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('denied'); } },
    });
    seed({ primary: ['a', 72] });
    const panel = mount();
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      click(copyButton(panel, 'FireRating'));
      await advance(0);
    } finally {
      console.warn = warn;
    }
    assert.match(latestToast(), /Could not copy to the clipboard/);
  });

  it('summarises 3 walls across 2 models: counts, the shared value, and "(varies)" where they differ', async () => {
    seed({ primary: ['b', 72], set: ['a:72', 'a:73', 'b:72'] });
    const panel = mount();
    const text = panel.textContent ?? '';

    assert.match(panel.querySelector('h2')?.textContent ?? '', /^3 elements$/);
    assert.doesNotMatch(text, /GlobalId/, 'the primary element alone is not shown');
    const countRow = (label: string) => [...panel.querySelectorAll('div')]
      .find((row) => row.children.length === 2 && row.children[0].textContent === label)?.children[1].textContent;
    assert.equal(countRow('IfcWall'), '3');
    assert.equal(countRow('Architecture.ifc'), '2');
    assert.equal(countRow('Structure.ifc'), '1');

    const valueRow = (name: string) => [...panel.querySelectorAll<HTMLElement>('.group\\/copyrow')]
      .find((row) => row.firstElementChild?.textContent === name);
    // Equal on all three: the value, copyable.
    assert.equal(valueRow('FireRating')?.children[1].firstElementChild?.textContent, 'REI60');
    assert.equal(await copyThrough(copyButton(valueRow('FireRating')!, 'FireRating')), 'REI60');
    assert.equal(valueRow('Width')?.children[1].firstElementChild?.textContent, '0.2 m');
    // Differs: Rw50, Rw50, Rw45 are two distinct values; nothing to copy.
    assert.equal(valueRow('AcousticRating')?.children[1].firstElementChild?.textContent, '(varies: 2 values)');
    assert.equal(valueRow('AcousticRating')?.querySelector('button'), null);
    assert.equal(valueRow('Name')?.children[1].firstElementChild?.textContent, '(varies: 3 values)');
  });

  it('shows the common value when every selected element agrees', async () => {
    seed({ primary: ['a', 73], set: ['a:72', 'a:73'] });
    const panel = mount();
    assert.match(panel.querySelector('h2')?.textContent ?? '', /^2 elements$/);
    const row = [...panel.querySelectorAll<HTMLElement>('.group\\/copyrow')]
      .find((candidate) => candidate.firstElementChild?.textContent === 'AcousticRating');
    assert.equal(row?.children[1].firstElementChild?.textContent, 'Rw50');
    assert.ok(copyButton(row!, 'AcousticRating'), 'an agreed value is copyable');
  });

  /** Views wired exactly as the viewer wires them (`configureMutationView`). */
  function registerViews(): { a: MutablePropertyView; b: MutablePropertyView } {
    const a = new MutablePropertyView(storeA.properties || null, 'a');
    const b = new MutablePropertyView(storeB.properties || null, 'b');
    configureMutationView(a, storeA);
    configureMutationView(b, storeB);
    useViewerStore.getState().registerMutationView('a', a);
    useViewerStore.getState().registerMutationView('b', b);
    return { a, b };
  }
  const summaryRow = (panel: HTMLElement, name: string) => [...panel.querySelectorAll<HTMLElement>('.group\\/copyrow')]
    .find((row) => row.firstElementChild?.textContent === name);

  it('keeps a deleted last property set and quantity set deleted in the summary (#5900 review)', async () => {
    seed({ primary: ['b', 72], set: ['a:72', 'a:73', 'b:72'] });
    const views = registerViews();
    // An untouched overlay shows the source sets.
    let panel = mount();
    assert.ok(summaryRow(panel, 'FireRating'), 'untouched psets still summarised');
    assert.equal(summaryRow(panel, 'Width')?.children[1].firstElementChild?.textContent, '0.2 m', 'untouched qsets still summarised');
    cleanup();
    act(() => {
      for (const [view, ids] of [[views.a, [72, 73]], [views.b, [72]]] as const) {
        for (const id of ids) {
          view.deletePropertySet(id, 'Pset_WallCommon');
          view.deleteQuantitySet(id, 'Qto_WallBaseQuantities');
        }
      }
      useViewerStore.setState((state) => ({ mutationVersion: (state.mutationVersion ?? 0) + 1 }) as never);
    });
    panel = mount();
    assert.equal(summaryRow(panel, 'FireRating'), undefined, 'a deleted pset must not be resurrected from the source node');
    assert.equal(summaryRow(panel, 'Width'), undefined, 'a deleted qset must not be resurrected from the source node');
    assert.ok(summaryRow(panel, 'AcousticRating'), 'the other pset is still there');
  });

  it('keeps a deleted last quantity set deleted for a single selected element (#5900 review)', async () => {
    seed({ primary: ['a', 72] });
    const views = registerViews();
    act(() => {
      views.a.deleteQuantitySet(72, 'Qto_WallBaseQuantities');
      useViewerStore.setState((state) => ({ mutationVersion: (state.mutationVersion ?? 0) + 1 }) as never);
    });
    const panel = mount();
    assert.equal(panel.querySelector('button[aria-label="Copy Width"]'), null, 'the deleted qset\'s Width row is gone');
    assert.ok(panel.querySelector('button[aria-label="Copy FireRating"]'), 'properties are unaffected');
  });

  it('shows authored IFC sets only when both selected slabs still have them (#5900 follow-up)', () => {
    // SketchUp 2024's buildingSMART sample has both Pset_SlabCommon and
    // Qto_SlabBaseQuantities on slab #52. Two loaded copies exercise federation.
    useViewerStore.setState({
      models: new Map([
        ['authored-a', model('authored-a', 'Building A.ifc', authoredStore, OFFSET_A)],
        ['authored-b', model('authored-b', 'Building B.ifc', authoredStore, OFFSET_B)],
      ]) as never,
      activeModelId: 'authored-a',
      selectedEntity: { modelId: 'authored-a', expressId: 52 },
      selectedEntityId: 52 + OFFSET_A,
      selectedEntityIds: new Set<number>(),
      selectedEntitiesSet: new Set(['authored-a:52', 'authored-b:52']),
      selectedModelId: null,
      selectedEntities: [],
      propertiesActiveTab: 'properties',
      editEnabled: false,
    });
    const view = getOrCreateMutationView(useViewerStore, 'authored-a');
    assert.ok(view);
    const sourcePsets = view.getForEntity(52);
    const sourceQsets = view.getQuantitiesForEntity(52);
    assert.ok(sourcePsets.some((set) => set.name === 'Pset_SlabCommon'));
    assert.ok(sourceQsets.some((set) => set.name === 'Qto_SlabBaseQuantities'));
    const panel = mount();
    assert.match(panel.textContent ?? '', /FireRating/);
    assert.match(panel.textContent ?? '', /NetArea/);

    act(() => {
      for (const set of sourcePsets) view.deletePropertySet(52, set.name);
      for (const set of sourceQsets) view.deleteQuantitySet(52, set.name);
      useViewerStore.setState({ mutationViews: new Map(useViewerStore.getState().mutationViews) });
    });
    assert.deepEqual(view.getForEntity(52), []);
    assert.deepEqual(view.getQuantitiesForEntity(52), []);
    assert.doesNotMatch(panel.textContent ?? '', /FireRating|NetArea/);
  });

  it('narrows the selection to an element clicked in the summary', async () => {
    seed({ primary: ['a', 72], set: ['a:72', 'a:73', 'b:72'] });
    const panel = mount();
    const wallC = panel.querySelector<HTMLButtonElement>('button[aria-label="Select only Wall C"]');
    assert.ok(wallC, 'each selected element is listed');
    click(wallC);
    await advance(60);

    const state = useViewerStore.getState();
    assert.equal(state.selectedEntitiesSet.size, 0);
    assert.deepEqual(state.selectedEntity, { modelId: 'b', expressId: 72 });
    assert.equal(state.selectedEntityId, OFFSET_B + 72);
    assert.equal(panel.querySelector('h3')?.textContent, 'Wall C', 'the panel now shows that one element');
  });
});
