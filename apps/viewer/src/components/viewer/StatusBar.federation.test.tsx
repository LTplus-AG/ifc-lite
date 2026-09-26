/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `StatusBar` reads `selectedStoreys` — a `Set<number>` of model-space
 * `expressId`s (see `treeDataBuilder.ts:411` and `:232`, which pair each id
 * with its OWN `modelId`; `selectedStoreys` drops that pairing) — but counted
 * elements by looking each id up directly in the legacy `ifcDataStore`
 * (`useIfc().ifcDataStore`, which tracks only the ACTIVE model's store,
 * `modelSlice.ts:202`). With a second, federated model, selecting one of
 * ITS storeys found nothing in the active model's hierarchy and silently
 * fell back to the raw (here: zero) mesh-derived total instead of the
 * selected storey's own element count.
 *
 * The active model's own spatial hierarchy has NO storey at expressId 5 at
 * all (a smaller, unrelated fixture) — proving a genuine cross-model
 * lookup, not a same-id coincidence: the non-active model's storey #5
 * ("Storey Two", 2 elements) must resolve through its OWN store, since the
 * active store can't possibly answer for that id. Same fixture construction
 * as `ViewportOverlays.federation.test.tsx` (#3506).
 */

import '@/test/setup-dom.js';
// `__APP_VERSION__` is a vite `define` (see vite.config.ts) baked in at
// build time; under plain Node it doesn't exist, so StatusBar's footer
// version string needs a stand-in before it renders.
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser } from '@ifc-lite/parser';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { ExtensionHostService } from '@/services/extensions/host.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import { StatusBar } from './StatusBar.js';
import {
  FIXTURE_MODEL,
  FIXTURE_STOREY_2,
  FIXTURE_WALL_A,
  FIXTURE_WALL_B,
  FIXTURE_WALL_C,
  guid,
} from './anonymized-export/anonymized-export-fixture.test-support.js';

// StatusBar unconditionally mounts `<FlavorDialog>` / `<FlavorIndicator>`,
// both of which call `useExtensionHost()` — stub the host rather than pull
// in the full `<ExtensionHostProvider>` (which needs a live `<BimProvider>`).
// Not under test here; see `FlavorDialog.unapplied-toast.test.tsx` for the
// same stub shape.
const stubHost = new ExtensionHostService({
  sdk: createBimContext({
    transport: {
      send: () => Promise.reject(new Error('SDK transport is not exercised by this test')),
      subscribe: () => () => {},
      close: () => {},
    },
  }),
});

const ID_OFFSET = 1_000_000;

// A minimal, self-contained model with only 4 entities (ids 1-4) — no
// storey at expressId 5, unlike `FIXTURE_MODEL` (whose id 5 is "Storey Two"
// with 2 elements).
const MINIMAL_ACTIVE_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('minimal-active-fixture.ifc','2020-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid(1)}',$,'Active Project',$,$,$,$,$,$);
#2=IFCSITE('${guid(2)}',$,'Active Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#3=IFCBUILDING('${guid(3)}',$,'Active Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#4=IFCBUILDINGSTOREY('${guid(4)}',$,'Storey One',$,$,$,$,$,$,0.);
#10=IFCRELAGGREGATES('${guid(10)}',$,$,$,#1,(#2));
#11=IFCRELAGGREGATES('${guid(11)}',$,$,$,#2,(#3));
#12=IFCRELAGGREGATES('${guid(12)}',$,$,$,#3,(#4));
ENDSEC;
END-ISO-10303-21;
`;

async function parseModel(stepText: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(stepText);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

function federatedModel(id: string, ifcDataStore: FederatedModel['ifcDataStore'], idOffset: number): FederatedModel {
  return {
    id,
    name: `${id}.ifc`,
    ifcDataStore,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 0,
    idOffset,
    maxExpressId: 100_000,
  } as FederatedModel;
}

function geometry(flatId: number, instancedOnlyId: number, totalTriangles = 1): GeometryResult {
  return {
    meshes: [{ expressId: flatId } as MeshData],
    totalVertices: 3,
    totalTriangles,
    instancedGeometryHashes: new Map([[instancedOnlyId, 1n]]),
  } as GeometryResult;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
function render(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ExtensionHostContext.Provider value={stubHost}>
        <StatusBar />
      </ExtensionHostContext.Provider>,
    );
  });
  mounted.push({ root, container });
  return container;
}
function unmountAll(): void {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}
after(unmountAll);

beforeEach(async () => {
  unmountAll();
  // Active model (m1, offset 0): no storey at expressId 5 whatsoever.
  const activeStore = await parseModel(MINIMAL_ACTIVE_MODEL);
  // Non-active model (m2, offset 1,000,000): the REAL selected storey lives
  // here, at local expressId 5 ("Storey Two", 2 elements: Wall B, Wall C).
  const otherStore = await parseModel(FIXTURE_MODEL);

  useViewerStore.setState({
    ifcDataStore: activeStore,
    geometryResult: null,
    activeModelId: 'm1',
    models: new Map([
      ['m1', federatedModel('m1', activeStore, 0)],
      ['m2', federatedModel('m2', otherStore, ID_OFFSET)],
    ]),
    selectedStoreys: new Set<number>([FIXTURE_STOREY_2]),
    activeStorey: null,
    selectedEntities: [],
    showPerformanceStats: false,
  });
});

describe('StatusBar — federation-space storey element count', () => {
  it('counts a non-active model\'s selected storey through its OWN hierarchy', () => {
    const container = render();

    // No `geometryResult` is set on either model, so the shape half of the
    // object rule is a no-op (see `lib/object-count.ts`) and both numbers are
    // schema-only: the storey's own 2 walls up front, and 4 physical objects
    // across the two models as the muted denominator. The bug this test was
    // written for produced "0 elements" outright, with no "/ N" fraction at
    // all: nothing was found in the ACTIVE model's hierarchy, so the storey
    // count stayed 0 and fell through to the whole-model total.
    assert.ok(
      container.textContent?.includes('2 / 4 elements'),
      `element count must reflect the selected storey's own 2 elements, resolved via its ` +
        `own (non-active) model's spatial hierarchy — not a fallback to the whole-model ` +
        `total from a failed lookup against a hierarchy that has no storey at that id. ` +
        `Got: ${JSON.stringify(container.textContent)}`,
    );
  });

  it('resolves a global storey id and counts flat plus instanced-only geometry in its model', async () => {
    const collidingActive = await parseModel(
      MINIMAL_ACTIVE_MODEL
        .replace(`#4=IFCBUILDINGSTOREY`, `#${FIXTURE_STOREY_2}=IFCBUILDINGSTOREY`)
        .replace(`,(#4));`, `,(#${FIXTURE_STOREY_2}));`),
    );
    const otherStore = await parseModel(FIXTURE_MODEL);
    const m1 = federatedModel('m1', collidingActive, 0);
    const m2 = federatedModel('m2', otherStore, ID_OFFSET);
    m2.geometryResult = geometry(
      ID_OFFSET + FIXTURE_WALL_B,
      ID_OFFSET + FIXTURE_WALL_C,
      3,
    );
    m2.geometryResult.instancedGeometryHashes?.set(ID_OFFSET + FIXTURE_WALL_A, 2n);
    useViewerStore.setState({
      ifcDataStore: collidingActive,
      activeModelId: 'm1',
      models: new Map([['m1', m1], ['m2', m2]]),
      selectedStoreys: new Set([ID_OFFSET + FIXTURE_STOREY_2]),
      activeStorey: null,
      selectedEntities: [],
    });

    const container = render();
    assert.ok(
      container.textContent?.includes('2 / 3 elements'),
      'the offset selection belongs to m2; its two storey walls exclude the shaped wall elsewhere',
    );
  });

  it('counts every constituent when a unified storey collapses colliding local ids', async () => {
    const firstStore = await parseModel(FIXTURE_MODEL);
    const secondStore = await parseModel(FIXTURE_MODEL);
    useViewerStore.setState({
      ifcDataStore: firstStore,
      activeModelId: 'm1',
      models: new Map([
        ['m1', federatedModel('m1', firstStore, 0)],
        ['m2', federatedModel('m2', secondStore, ID_OFFSET)],
      ]),
      // A unified hierarchy row stores both model refs but its numeric Set
      // necessarily collapses the shared local express id to one entry.
      selectedStoreys: new Set([FIXTURE_STOREY_2]),
      activeStorey: { modelId: 'm1', expressId: FIXTURE_STOREY_2 },
      selectedEntities: [
        { modelId: 'm1', expressId: FIXTURE_STOREY_2 },
        { modelId: 'm2', expressId: FIXTURE_STOREY_2 },
      ],
    });

    const container = render();
    assert.ok(
      container.textContent?.includes('4 / 8 elements'),
      'both model-aware storey refs must contribute even though selectedStoreys contains one id',
    );
  });

  it('sums triangle totals across federated models', async () => {
    const firstStore = await parseModel(MINIMAL_ACTIVE_MODEL);
    const secondStore = await parseModel(MINIMAL_ACTIVE_MODEL);
    const m1 = federatedModel('m1', firstStore, 0);
    const m2 = federatedModel('m2', secondStore, ID_OFFSET);
    m1.geometryResult = geometry(1, 2, 2);
    m2.geometryResult = geometry(ID_OFFSET + 1, ID_OFFSET + 2, 3);
    useViewerStore.setState({
      ifcDataStore: firstStore,
      geometryResult: m1.geometryResult,
      activeModelId: 'm1',
      models: new Map([['m1', m1], ['m2', m2]]),
      selectedStoreys: new Set<number>(),
      activeStorey: null,
      selectedEntities: [],
      showPerformanceStats: true,
    });

    const container = render();
    assert.ok(container.textContent?.includes('5 tris'));
  });
});
