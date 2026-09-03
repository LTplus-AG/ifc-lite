/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `CesiumOverlay`'s `'custom-3dtiles'` data source (issue #3607) — a
 * user-supplied 3D Tiles tileset URL loaded via `Cesium.Cesium3DTileset.fromUrl`.
 *
 * WEBGL: as in `CesiumOverlay.teardown.test.tsx`, `new Cesium.Viewer()` cannot
 * run under `tsx --test` (no WebGL in happy-dom), so `@/test/cesium-stub.ts`
 * replaces the `Viewer` constructor and `Cesium3DTileset.fromUrl` (the latter
 * would otherwise hit the network, which this environment cannot do either).
 * Everything under test — the branch selection, the error wording, the
 * `!cancelled` guard — is the real component code.
 *
 * What this file does NOT prove: that a real, published 3D Tiles 1.0 or 1.1
 * tileset actually renders. `Cesium3DTileset.fromUrl` is stubbed out
 * entirely here; verifying an actual remote tileset needs a browser with
 * network access, which this sandboxed environment does not have.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { pendingCustomTilesets, resetCesiumStub, stubViewers } from '@/test/cesium-stub.js';
import { cleanup, render } from '@/test/render.js';
import { CesiumOverlay } from './CesiumOverlay.js';

const TILESET_URL = 'https://data.example.org/3dtiles/tileset.json';

const MAP_CONVERSION = {
  eastings: 2600000, northings: 1200000, orthogonalHeight: 400,
  xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1,
} as unknown as MapConversion;

const PROJECTED_CRS = { name: 'EPSG:2056' } as unknown as ProjectedCRS;

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}

function seedStore(url: string | null): void {
  useViewerStore.setState({
    cesiumEnabled: true,
    cesiumDataSource: 'custom-3dtiles',
    cesiumCustomTilesetUrl: url,
    cesiumIonToken: '',
    cesiumTerrainEnabled: false,
    cesiumTerrainClipY: null,
  } as never);
}

function mount(): HTMLElement {
  return render(
    <CesiumOverlay mapConversion={MAP_CONVERSION} projectedCRS={PROJECTED_CRS} />,
  );
}

function warningText(container: HTMLElement): string | null {
  return container.querySelector('[role="status"]')?.textContent ?? null;
}

describe('CesiumOverlay — custom 3D Tiles URL (#3607)', () => {
  beforeEach(() => { resetCesiumStub(); });
  afterEach(() => { cleanup(); resetCesiumStub(); });

  it('calls Cesium3DTileset.fromUrl with the stored URL and adds it as a scene primitive', async () => {
    seedStore(TILESET_URL);
    mount();
    await waitFor(() => pendingCustomTilesets.length === 1, 'the fromUrl call');
    assert.equal(pendingCustomTilesets[0].url, TILESET_URL);

    const fakeTileset = { shadows: undefined };
    act(() => { pendingCustomTilesets[0].resolve(fakeTileset); });
    await settle();

    const viewer = stubViewers[stubViewers.length - 1];
    assert.ok(
      viewer.addedPrimitives.includes(fakeTileset),
      'the resolved tileset must be added via scene.primitives.add, the same lifecycle as the built-in sources',
    );
  });

  it('surfaces a load failure (bad URL / 404 / CORS) as a visible warning, not a silent no-op', async () => {
    seedStore(TILESET_URL);
    const container = mount();
    await waitFor(() => pendingCustomTilesets.length === 1, 'the fromUrl call');

    act(() => { pendingCustomTilesets[0].reject(new Error('404: tileset.json not found')); });
    await settle();

    const text = warningText(container);
    assert.ok(text, 'a failed tileset load must raise a visible banner');
    assert.match(text!, /Could not load the custom 3D Tiles URL/);
    assert.match(text!, /404: tileset\.json not found/);
  });

  it('warns immediately when the source is selected with no URL configured', async () => {
    seedStore(null);
    const container = mount();
    await waitFor(() => warningText(container) !== null, 'the missing-URL warning');
    assert.match(warningText(container)!, /No custom 3D Tiles URL is configured/);
  });

  it('does not add a primitive from a stale load after the user switches sources', async () => {
    seedStore(TILESET_URL);
    mount();
    await waitFor(() => pendingCustomTilesets.length === 1, 'the fromUrl call');
    const staleRequest = pendingCustomTilesets[0];

    // Switch away before the (slow) tileset resolves — this re-runs the init
    // effect and its cleanup, mirroring the `!cancelled` guard exercised for
    // the custom XYZ basemap in CesiumOverlay.teardown.test.tsx.
    act(() => { useViewerStore.setState({ cesiumDataSource: 'osm-map' } as never); });

    let destroyCalls = 0;
    const fakeTileset = { shadows: undefined, destroy: () => { destroyCalls += 1; } };
    act(() => { staleRequest.resolve(fakeTileset); });
    await settle();

    const viewersWithTileset = stubViewers.filter((v) => v.addedPrimitives.includes(fakeTileset));
    assert.equal(
      viewersWithTileset.length, 0,
      'a tileset that resolves after the user switched away must not be added to any viewer',
    );
    // Cesium3DTileset's own docs require an explicit `.destroy()` "for the
    // explicit release of WebGL resources, instead of relying on the garbage
    // collector" -- a tileset that resolves post-cancellation is never added
    // to any scene's primitives, so nothing else will ever call it. Without
    // this, every source switch made before a slow custom tileset URL
    // resolved leaked that tileset's in-flight requests and any resources
    // already allocated for its root tile.
    assert.equal(
      destroyCalls, 1,
      'a stale tileset that is discarded (never added to a scene) must be explicitly destroyed, not leaked',
    );
  });
});
