/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `HoverTooltip` reads `hoverState.entityId` — renderer-space (global,
 * offset-per-model — set from `pickResult.expressId` in
 * `useMouseControls.ts`) — but looks the name/type up directly in the
 * legacy `ifcDataStore` (`useIfc().ifcDataStore`, which tracks the ACTIVE
 * model's store, `modelSlice.ts:202`) using that global id AS IF it were a
 * model-space `expressId`. With a second, non-zero-offset model federated
 * in, hovering an entity that belongs to that second model reads through
 * the WRONG store at the WRONG id: the active model's store has no entity
 * at that (huge, offset-shifted) id, so the lookup misses and the tooltip
 * renders "Unknown" / blank instead of the hovered entity's real name.
 *
 * Uses the same federated single-model-with-offset fixture as
 * `EntityContextMenu.federation.test.tsx`.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { HoverTooltip } from './HoverTooltip.js';
import { parseFixtureModel, FIXTURE_WALL_A } from './anonymized-export/anonymized-export-fixture.test-support.js';

const ID_OFFSET = 1_000_000;
const globalId = (localId: number): number => localId + ID_OFFSET;

function federatedModel(id: string, ifcDataStore: FederatedModel['ifcDataStore']): FederatedModel {
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
    idOffset: id === 'm2' ? ID_OFFSET : 0,
    maxExpressId: id === 'm2' ? 100_000 + ID_OFFSET : 100_000,
  } as FederatedModel;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
function render(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(<HoverTooltip />); });
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
  const store = await parseFixtureModel();
  // Two models federated: m1 is the ACTIVE model (offset 0, so
  // `state.ifcDataStore` == m1's store per `modelSlice.ts:202`); m2 carries
  // a non-zero offset. Both are parsed from the same fixture, so m2 also has
  // an "IfcWall" named "Wall A" at model-space expressId `FIXTURE_WALL_A`.
  useViewerStore.setState({
    ifcDataStore: store,
    activeModelId: 'm1',
    models: new Map([
      ['m1', federatedModel('m1', store)],
      ['m2', federatedModel('m2', store)],
    ]),
    hoverTooltipsEnabled: true,
    hoverState: { entityId: globalId(FIXTURE_WALL_A), screenX: 10, screenY: 10 },
  });
});

describe('HoverTooltip — federation-space entity lookup', () => {
  it('resolves the hovered global id through its OWN model, not the active model store', () => {
    const container = render();

    assert.ok(
      container.textContent?.includes('Wall A'),
      `tooltip must show the hovered entity's real name ("Wall A") resolved via its ` +
        `own model, not "Unknown"/blank from mis-reading the active model's store ` +
        `with a raw (offset) global id. Got: ${JSON.stringify(container.textContent)}`,
    );
  });
});
