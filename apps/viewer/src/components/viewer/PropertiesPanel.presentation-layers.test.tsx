/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { advance, cleanup, click, render, waitFor } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider.js';
import { useViewerStore } from '@/store';
import * as layerIndex from '@/lib/presentation-layers.js';
import { PropertiesPanel } from './PropertiesPanel.js';
import { HierarchyPanel } from './HierarchyPanel.js';
import { PresentationLayersSection } from './properties/PresentationLayersSection.js';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('layers.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0GUID000000000000000001',$,'Project',$,$,$,$,$,$);
#7=IFCWALL('0GUID000000000000000007',$,'Layer wall',$,$,$,#20,$);
#8=IFCWALL('0GUID000000000000000008',$,'Unlayered wall',$,$,$,$,$);
#20=IFCPRODUCTDEFINITIONSHAPE($,$,(#21));
#21=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#22));
#22=IFCEXTRUDEDAREASOLID($,$,$,1.);
#50=IFCPRESENTATIONLAYERASSIGNMENT('Walls',$,(#21),'A-01');
#51=IFCPRESENTATIONLAYERASSIGNMENT('Structure',$,(#22),$);
ENDSEC;
END-ISO-10303-21;`;
async function setup(modelId = 'own') {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer);
  const otherStore = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC.replaceAll('Walls', 'Foreign layer').replaceAll('A-01', 'F-99')).buffer);
  const model = { ...fixtureModel(modelId, { idOffset: 1_000_000 }), ifcDataStore: store, loadedAt: 0, fileSize: 1 };
  const other = { ...fixtureModel('other', { idOffset: 2_000_000 }), ifcDataStore: otherStore, loadedAt: 0, fileSize: 1 };
  const view = new MutablePropertyView(null, model.id);
  useViewerStore.setState({ ...fixtureModels(model, other),
    ifcDataStore: otherStore, mutationViews: new Map([[model.id, view]]), mutationVersion: 0,
    selectedEntity: { modelId: model.id, expressId: 7 }, selectedEntityId: 1_000_007,
    selectedEntityIds: new Set([1_000_007]), selectedEntities: [], selectedModelId: null,
    hierarchyMode: 'spatial', pendingPresentationLayerReveal: null,
  });
  return { store, view, editor: new StoreEditor(store, view) };
}
const section = (ui: HTMLElement) => ui.querySelector('section[aria-label="Presentation layers"]');

it('#9273 lists both own-model layers with Identifier and omits the section for an unlayered selection', async () => {
  await setup();
  const ui = render(<PropertiesPanel />);
  assert.ok(section(ui) === null, 'layer membership is resolved after render, not in the render stack');
  await waitFor(() => !!section(ui), 'layer section appears in the actual inspector');
  assert.deepEqual([...section(ui)!.querySelectorAll('button')].map(b => b.textContent), ['Walls (A-01)', 'Structure']);
  assert.doesNotMatch(section(ui)!.textContent!, /Foreign/);
  act(() => useViewerStore.setState({ selectedEntity: { modelId: 'own', expressId: 8 },
    selectedEntityId: 1_000_008, selectedEntityIds: new Set([1_000_008]) }));
  assert.ok(section(ui) === null);
});

it('#9273 clicking the second layer reveals that exact header in the hierarchy', async () => {
  await setup();
  const ui = render(<SourceHostProvider><PropertiesPanel /><HierarchyPanel /></SourceHostProvider>);
  await waitFor(() => !!section(ui), 'the layer links are available');
  const button = [...section(ui)!.querySelectorAll('button')].find(b => b.textContent === 'Structure');
  assert.ok(button);
  click(button);
  await waitFor(() => document.activeElement?.getAttribute('data-node-id') === 'presentation-layer-own-51',
    'clicked layer header receives focus after lazy tree load');
  assert.equal(useViewerStore.getState().hierarchyMode, 'presentation-layers');
  assert.equal(useViewerStore.getState().leftPanelCollapsed, false);
});

it('#9273 reuses the reverse index across selections and invalidates it on edits', async () => {
  const { store, view, editor } = await setup();
  assert.equal(typeof layerIndex.presentationLayersByProduct, 'function');
  const first = layerIndex.presentationLayersByProduct(store, view);
  assert.equal(layerIndex.presentationLayersByProduct(store, view), first);
  const ui = render(<PropertiesPanel />);
  await waitFor(() => !!section(ui), 'layer section resolves after render');
  editor.setAttribute(50, 'Name', 'Renamed');
  editor.setAttribute(51, 'AssignedItems', '()');
  act(() => useViewerStore.setState({ mutationVersion: 1 }));
  assert.notEqual(layerIndex.presentationLayersByProduct(store, view), first);
  await waitFor(() => section(ui)?.querySelectorAll('button').length === 1, 'edited layer membership resolves');
  assert.deepEqual([...section(ui)!.querySelectorAll('button')].map(b => b.textContent), ['Renamed (A-01)']);
});


it('#9273 leaving Layers cancels an unconsumed reveal instead of stealing focus on return', async () => {
  await setup();
  const inspector = render(<PropertiesPanel />);
  await waitFor(() => !!section(inspector), 'layer links load');
  const button = [...section(inspector)!.querySelectorAll('button')].find(b => b.textContent === 'Structure');
  assert.ok(button);
  button.focus();
  click(button); // Hierarchy has not mounted/loaded yet, so the reveal is pending.
  act(() => useViewerStore.getState().setHierarchyMode('spatial'));
  act(() => useViewerStore.getState().setHierarchyMode('presentation-layers'));
  const hierarchy = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
  await waitFor(() => !!hierarchy.querySelector('[data-node-id="presentation-layer-own-51"]'),
    'the previously requested layer is available after returning');
  await advance(50);
  assert.ok(document.activeElement === button, 'returning to Layers does not revive the cancelled focus request');
});


for (const modelId of ['__legacy__', 'legacy']) {
  it(`#9273 ${modelId} uses its own layers, mutation view and hierarchy reveal ID`, async () => {
    const { store, editor } = await setup(modelId);
    if (modelId === 'legacy') {
      const view = new MutablePropertyView(null, '__legacy__');
      useViewerStore.setState({ models: new Map(), ifcDataStore: store,
        mutationViews: new Map([['__legacy__', view]]),
        selectedEntityId: 7, selectedEntityIds: new Set([7]) });
      new StoreEditor(store, view).setAttribute(50, 'Name', 'Edited fallback layer');
    } else {
      // A real federated __legacy__ owner must win over the different global store.
      editor.setAttribute(50, 'Name', 'Edited own layer');
    }
    const ui = render(<SourceHostProvider><PropertiesPanel /><HierarchyPanel /></SourceHostProvider>);
    await waitFor(() => !!section(ui), 'layer section resolves after render');
    const expected = modelId === 'legacy' ? 'Edited fallback layer (A-01)' : 'Edited own layer (A-01)';
    assert.deepEqual([...section(ui)!.querySelectorAll('button')].map(b => b.textContent), [expected, 'Structure']);
    assert.doesNotMatch(section(ui)!.textContent!, /Foreign/);
    const button = [...section(ui)!.querySelectorAll('button')].find(b => b.textContent === expected);
    assert.ok(button);
    click(button);
    await waitFor(() => document.activeElement?.getAttribute('data-node-id') === `presentation-layer-${modelId}-50`,
      'the owning model layer header receives focus');
  });
}

it('#9273 resolves a federated __legacy__ model through its own store, matching the inspector', async () => {
  await setup('__legacy__');
  const ui = render(<PropertiesPanel />);
  await waitFor(() => !!section(ui), 'layer section resolves after render');
  assert.deepEqual([...section(ui)!.querySelectorAll('button')].map(b => b.textContent), ['Walls (A-01)', 'Structure']);
});

it('#9273 shared-store alias selection uses the representative owner view and reveal ID', async () => {
  const { store, editor } = await setup();
  const alias = { ...fixtureModel('alias', { idOffset: 1_000_000 }), ifcDataStore: store };
  const aliasView = new MutablePropertyView(null, 'alias');
  new StoreEditor(store, aliasView).setAttribute(50, 'Name', 'Alias layer');
  editor.setAttribute(50, 'Name', 'Representative layer');
  act(() => {
    const state = useViewerStore.getState();
    useViewerStore.setState({ models: new Map([...state.models, ['alias', alias]]),
      mutationViews: new Map([...state.mutationViews, ['alias', aliasView]]) });
    // This is the same public store action used by SDK selection.set: it does
    // allow non-representative owner refs even when their renderer IDs alias.
    useViewerStore.getState().setSelectedEntity({ modelId: 'alias', expressId: 7 });
  });
  const ui = render(<SourceHostProvider><PropertiesPanel /><HierarchyPanel /></SourceHostProvider>);
  await waitFor(() => !!section(ui), 'alias inspector loads layers');
  const button = [...section(ui)!.querySelectorAll('button')].find(b => b.textContent === 'Representative layer (A-01)');
  assert.ok(button, 'selection uses the same representative overlay as the tree');
  click(button);
  await waitFor(() => document.activeElement?.getAttribute('data-node-id') === 'presentation-layer-own-50',
    'the representative layer header is revealed');
});

it('#9273 a file swap cannot revive a legacy layer reveal against reused ids', async () => {
  const { store } = await setup('legacy');
  useViewerStore.setState({ models: new Map(), ifcDataStore: store, mutationViews: new Map(),
    selectedEntityId: 7, selectedEntityIds: new Set([7]) });
  const inspector = render(<div><button id="keep-focus">Continue</button><PropertiesPanel /></div>);
  await waitFor(() => !!section(inspector), 'old file layer links load');
  click(section(inspector)!.querySelector('button')!);
  act(() => useViewerStore.getState().resetViewerState());
  const next = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC.replace('Walls', 'New file layer')).buffer);
  act(() => useViewerStore.setState({ ifcDataStore: next, hierarchyMode: 'presentation-layers' }));
  const keepFocus = inspector.querySelector<HTMLButtonElement>('#keep-focus')!;
  keepFocus.focus();
  const tree = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
  await waitFor(() => !!tree.querySelector('[data-node-id="presentation-layer-legacy-50"]'), 'new file has reused layer ids');
  await advance(50);
  assert.ok(document.activeElement === keepFocus, 'old request does not steal focus in the replacement file');
});

for (const operation of ['removeModel', 'clearAllModels'] as const) {
  it(`#9273 ${operation} retires a pending reveal owned by the departing model`, async () => {
    await setup();
    const ui = render(<PropertiesPanel />);
    await waitFor(() => !!section(ui), 'layer link loads');
    click(section(ui)!.querySelector('button')!);
    act(() => {
      if (operation === 'removeModel') useViewerStore.getState().removeModel('own');
      else useViewerStore.getState().clearAllModels();
    });
    assert.equal(useViewerStore.getState().pendingPresentationLayerReveal, null,
      'a request cannot wait for a model that has departed');
  });
}

it('#9273 retires a reveal for a missing layer once the hierarchy metadata is ready', async () => {
  await setup();
  useViewerStore.setState({ hierarchyMode: 'presentation-layers', pendingPresentationLayerReveal: {
    modelId: 'own', nodeId: 'presentation-layer-own-999',
  } });
  const ui = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
  await waitFor(() => !!ui.querySelector('[data-node-id="presentation-layer-own-50"]'), 'complete layer tree loads');
  await advance(50);
  assert.equal(useViewerStore.getState().pendingPresentationLayerReveal, null,
    'a fully loaded tree retires a target it cannot supply');
});

it('#9273 an explicit off-screen layer reveal wins over the held product selection', async () => {
  // Supply the layout/scroll events a real browser gives TanStack Virtual.
  const scrolls: number[] = [];
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get(this: HTMLElement) {
    return Math.max(this.clientHeight, Number.parseFloat((this.firstElementChild as HTMLElement | null)?.style.height ?? '0') || 0);
  } });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value(this: HTMLElement, options: ScrollToOptions) {
    this.scrollTop = options.top ?? 0;
    if (this.getAttribute('role') === 'tree') scrolls.push(this.scrollTop);
    this.dispatchEvent(new window.Event('scroll'));
  } });
  try {
    await setup('priority');
    const extra = Array.from({ length: 300 }, (_, i) => `#${100 + i}=IFCPRESENTATIONLAYERASSIGNMENT('Layer ${String(i).padStart(3, '0')}',$,(#21),$);`).join('\n');
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC.replace('ENDSEC;\nEND-ISO', `${extra}\nENDSEC;\nEND-ISO`)).buffer);
    const state = useViewerStore.getState();
    const offset = state.registerModelOffset('priority', 399);
    act(() => {
      useViewerStore.setState({ models: new Map([['priority', { ...fixtureModel('priority', { idOffset: offset }), ifcDataStore: store }]]),
        ifcDataStore: store, mutationViews: new Map() });
      state.setSelectedEntityId(state.toGlobalId('priority', 7));
    });
    const ui = render(<SourceHostProvider><PropertiesPanel /><HierarchyPanel /></SourceHostProvider>);
    await waitFor(() => !!section(ui), 'large model inspector links load');
    const target = [...section(ui)!.querySelectorAll('button')].find(b => b.textContent === 'Walls (A-01)');
    assert.ok(target); // Alphabetically last, beyond 300 collapsed layer headers.
    scrolls.length = 0;
    click(target);
    await waitFor(() => document.activeElement?.getAttribute('data-node-id') === 'presentation-layer-priority-50',
      'the virtualizer materialises and focuses the requested off-screen header');
    await advance(100);
    const tree = ui.querySelector<HTMLElement>('[role="tree"]')!;
    const firstFarScroll = scrolls.findIndex(top => top > 2_000);
    assert.ok(firstFarScroll >= 0);
    assert.ok(scrolls.slice(firstFarScroll).every(top => top > 2_000), `product reveal must not fight the explicit header: ${scrolls}`);
    assert.ok(tree.scrollTop > 2_000, `requested layer stays in view (scrollTop ${tree.scrollTop})`);
    assert.ok(document.activeElement?.getAttribute('data-node-id') === 'presentation-layer-priority-50');
  } finally {
    cleanup();
    if (height) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', height);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
    if (scroll) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scroll);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  }
});

it('#9273 a metadata load that never completes cannot arm layer focus forever', async t => {
  await setup();
  const model = useViewerStore.getState().models.get('own')!;
  useViewerStore.setState({ models: new Map([['own', { ...model, ifcDataStore: null, metadataLoadState: 'querying' }]]),
    ifcDataStore: null, loading: true, hierarchyMode: 'presentation-layers',
    pendingPresentationLayerReveal: { modelId: 'own', nodeId: 'presentation-layer-own-50' } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
    act(() => t.mock.timers.tick(30_001));
    assert.equal(useViewerStore.getState().pendingPresentationLayerReveal, null, 'unresolved requests expire after 30 seconds');
  } finally {
    cleanup();
    t.mock.timers.reset();
  }
});


it('#9273 a failed lazy download displays an error and retry loads real layer membership', async () => {
  await setup();
  let attempts = 0;
  const loadLookup = () => ++attempts === 1 ? Promise.reject(new Error('Chunk download failed'))
    : import('@/lib/presentation-layer-selection.js');
  const ui = render(<PresentationLayersSection entityRef={{ modelId: 'own', expressId: 7 }} loadLookup={loadLookup} />);
  await waitFor(() => !!ui.querySelector('[role="alert"]'), 'a failed download is visible in the inspector');
  assert.match(ui.textContent!, /Unable to load presentation layers/);
  const retry = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Retry');
  assert.ok(retry);
  click(retry);
  await waitFor(() => !!section(ui)?.textContent?.includes('Walls (A-01)'), 'retry resolves the real parsed model');
  assert.deepEqual([...section(ui)!.querySelectorAll('button')].map(button => button.textContent), ['Walls (A-01)', 'Structure']);
  assert.ok(ui.querySelector('[role="alert"]') === null);
});

it('#9273 changing selection retries a failed layer download without retaining the previous error', async () => {
  await setup();
  let attempts = 0;
  const loadLookup = () => ++attempts === 1 ? Promise.reject(new Error('Chunk download failed'))
    : import('@/lib/presentation-layer-selection.js');
  function SelectedLayers() {
    const selected = useViewerStore(state => state.selectedEntity);
    return selected ? <PresentationLayersSection entityRef={selected} loadLookup={loadLookup} /> : null;
  }
  const ui = render(<SelectedLayers />);
  await waitFor(() => !!ui.querySelector('[role="alert"]'), 'initial download failed');
  act(() => useViewerStore.setState({ selectedEntity: { modelId: 'own', expressId: 8 } }));
  await advance(20);
  assert.ok(section(ui) === null, 'successful unlayered lookup has no section or stale error');
  act(() => useViewerStore.setState({ selectedEntity: { modelId: 'own', expressId: 7 } }));
  await waitFor(() => !!section(ui)?.textContent?.includes('Walls (A-01)'), 'selection retries the module and resolves its layers');
  assert.ok(ui.querySelector('[role="alert"]') === null);
});
