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
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { ExtensionHostService } from '@/services/extensions/host.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import { StatusBar } from './StatusBar.js';
import { FIXTURE_MODEL, FIXTURE_STOREY_2, guid } from './anonymized-export/anonymized-export-fixture.test-support.js';

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
    maxExpressId: 100_000 + idOffset,
  } as FederatedModel;
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
  });
});

describe('StatusBar — federation-space storey element count', () => {
  it('counts a non-active model\'s selected storey through its OWN hierarchy', () => {
    const container = render();

    // No `geometryResult` is set (mesh-derived `stats.elements` is 0), so a
    // correct resolution renders "2 / 0 elements" — the storey's own count
    // up front, with the (irrelevant, zero) mesh total as the muted
    // denominator. The bug produced "0 elements" outright: `count` stayed 0
    // (nothing found in the active model's hierarchy) so `count ||
    // stats.elements` fell through to the equally-0 total, and the two being
    // equal suppressed the "/ N" fraction entirely.
    assert.ok(
      container.textContent?.includes('2 / 0 elements'),
      `element count must reflect the selected storey's own 2 elements, resolved via its ` +
        `own (non-active) model's spatial hierarchy — not a fallback to the active model's ` +
        `(zero) total from a failed lookup against a hierarchy that has no storey at that id. ` +
        `Got: ${JSON.stringify(container.textContent)}`,
    );
  });
});
