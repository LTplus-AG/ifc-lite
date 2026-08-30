/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ViewportOverlays` reads `selectedStoreys` — a `Set<number>` of
 * model-space `expressId`s written by `HierarchyPanel` from `node.expressIds`
 * / `unified.storeys[].storeyId` (both raw, per-model local ids — see
 * `treeDataBuilder.ts:411` and `:232`, which pair each id with its OWN
 * `modelId`. `selectedStoreys` drops that pairing) — but looks each id up
 * directly in the legacy `ifcDataStore` (`useIfc().ifcDataStore`, which
 * tracks only the ACTIVE model's store, `modelSlice.ts:202`). With a second,
 * federated model whose storey happens to reuse the SAME local expressId as
 * something in the active model (routine for IFC files, which both start
 * numbering at #1), the storey pill reads the ACTIVE model's entity at that
 * id instead of the selected storey's own name.
 *
 * The active model's own entity table has NO entity at expressId 5 at all
 * (a smaller, unrelated fixture) — proving a genuine cross-model lookup,
 * not a same-id coincidence: the non-active model's storey #5 ("Storey
 * Two") must resolve through its OWN store, since the active store can't
 * possibly answer for that id.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser } from '@ifc-lite/parser';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { TooltipProvider } from '@/components/ui/tooltip.js';
import { ViewportOverlays } from './ViewportOverlays.js';
import { FIXTURE_MODEL, FIXTURE_STOREY_2, guid } from './anonymized-export/anonymized-export-fixture.test-support.js';

const ID_OFFSET = 1_000_000;

// A minimal, self-contained model with only 4 entities (ids 1-4) — no
// entity at expressId 5, unlike `FIXTURE_MODEL` (whose id 5 is "Storey Two").
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
      <TooltipProvider>
        <ViewportOverlays hideViewCube hideAxis hideScale />
      </TooltipProvider>,
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
  // Active model (m1, offset 0): no entity at expressId 5 whatsoever.
  const activeStore = await parseModel(MINIMAL_ACTIVE_MODEL);
  // Non-active model (m2, offset 1,000,000): the REAL selected storey lives
  // here, at local expressId 5 ("Storey Two").
  const otherStore = await parseModel(FIXTURE_MODEL);

  useViewerStore.setState({
    ifcDataStore: activeStore,
    activeModelId: 'm1',
    models: new Map([
      ['m1', federatedModel('m1', activeStore, 0)],
      ['m2', federatedModel('m2', otherStore, ID_OFFSET)],
    ]),
    selectedStoreys: new Set<number>([FIXTURE_STOREY_2]),
  });
});

describe('ViewportOverlays — federation-space storey name lookup', () => {
  it('resolves a non-active model\'s selected storey through its OWN store', () => {
    const container = render();

    assert.ok(
      container.textContent?.includes('Storey Two'),
      `storey pill must show the selected storey's real name ("Storey Two"), resolved via its ` +
        `own (non-active) model's store — not a "Storey #${FIXTURE_STOREY_2}" fallback from a ` +
        `failed lookup against the active model's store, which has no entity at that id. ` +
        `Got: ${JSON.stringify(container.textContent)}`,
    );
  });
});
