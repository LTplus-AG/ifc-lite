/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `CesiumOverlay` after its init effect has been torn down (issue #2685).
 *
 * The overlay's viewer effect starts an async routine that outlives the
 * effect: `loadCesium()` is a dynamic import, the terrain provider is a
 * network round trip, and the basemap's `errorEvent` keeps firing per retried
 * tile for as long as the provider lives. Cesium frees a destroyed viewer's
 * textures but never cancels an in-flight request and never clears a
 * provider's listener array, so every one of those continuations can arrive
 * at a component whose effect run is already over — and the user's story for
 * each is a banner about a basemap they have already switched away from,
 * sitting on top of the one they are looking at.
 *
 * The scenarios below are the ones written into the component's comments,
 * driven for real: a switch away from a slow custom host inside its connect
 * timeout, and a late successful tile from an abandoned provider landing on a
 * NEW basemap's legitimate warning. Nothing here reads the text of
 * `CesiumOverlay.tsx`; the observables are Cesium's own
 * `errorEvent.numberOfListeners` and the banners in the DOM.
 *
 * The last test covers the layout half of the same fix. The banners are not
 * an either/or — the basemap warning is raised from inside the init routine,
 * before `setStatus('ready')` — so "loading" and "this server does not allow
 * browser access" are on screen together for exactly the case that most needs
 * reading. Parking init on the terrain `await` (see `cesium-stub.ts`) is how
 * the test holds both on screen at once.
 *
 * WEBGL: `new Cesium.Viewer()` cannot run here. `@/test/cesium-stub.js`
 * replaces that constructor and nothing else; the classifier, the retraction
 * wrapper and the component are all the real thing.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { BROWSER_ACCESS_BLOCKED, type CustomBasemap } from '@/lib/geo/custom-basemap';
import { pendingTerrain, resetCesiumStub, stubProviders } from '@/test/cesium-stub.js';
import { cleanup, render } from '@/test/render.js';
import { CesiumOverlay } from './CesiumOverlay.js';

const BASEMAP_A: CustomBasemap = {
  protocol: 'xyz',
  url: 'https://tiles.example.org/aerial/{z}/{x}/{y}.png',
  credit: 'Imagery © Example Mapping Agency',
};

const BASEMAP_B: CustomBasemap = {
  protocol: 'xyz',
  url: 'https://other.example.net/base/{z}/{x}/{y}.jpg',
  credit: 'Imagery © Another Example Agency',
};

/** Enough georeference for the overlay to render its container div. */
const MAP_CONVERSION = {
  eastings: 2600000, northings: 1200000, orthogonalHeight: 400,
  xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1,
} as unknown as MapConversion;

const PROJECTED_CRS = { name: 'EPSG:2056' } as unknown as ProjectedCRS;

/** A Cesium `RequestErrorEvent` with no `statusCode` — the CORS refusal. */
const CORS_REFUSAL = { error: { statusCode: undefined } };

/** Let React and every pending microtask/timer settle. */
async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

/**
 * Settle repeatedly until `predicate` holds, then stop. Init opens with
 * `await loadCesium()`, whose FIRST call in the process is a real dynamic
 * import of the whole engine — a fixed number of flushes is a race that only
 * the first test in the file loses.
 *
 * Only ever used BEFORE a teardown, never between a teardown and the event it
 * is supposed to have disarmed: flushing there would close the window under
 * test and make the assertion vacuous.
 */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Seed the store so init runs the custom-basemap branch and then PARKS.
 *
 * Terrain plus an ion token puts an `await CesiumTerrainProvider.fromIonAssetId`
 * between "the basemap provider is built and its error listener attached" and
 * `setStatus('ready')`, and `cesium-stub.ts` never settles it. That is the
 * user's slow host — every scenario in this file is a teardown that happens
 * inside the connect timeout — and it is also what keeps the overlay out of
 * `ready`, where the bridge / model / solar / camera-sync hooks would start
 * driving a scene the stub deliberately does not model.
 */
function seedStore(basemap: CustomBasemap): void {
  useViewerStore.setState({
    cesiumEnabled: true,
    cesiumDataSource: 'custom',
    cesiumCustomBasemap: basemap,
    cesiumIonToken: 'test-token',
    cesiumTerrainEnabled: true,
    cesiumTerrainClipY: null,
  } as never);
}

function mount(): HTMLElement {
  return render(
    <CesiumOverlay mapConversion={MAP_CONVERSION} projectedCRS={PROJECTED_CRS} />,
  );
}

/**
 * The banner text on screen, or null. Deliberately NOT the element:
 * `assert.equal(element, null)` builds its diff by inspecting a happy-dom
 * node, which walks `ownerDocument` → `defaultView` → the whole realm and
 * exhausts the heap before it can print a failure. Every assertion in this
 * file compares small values for that reason.
 */
function warningText(container: HTMLElement): string | null {
  return container.querySelector('[role="status"]')?.textContent ?? null;
}

/** The innermost element whose text is exactly `text`. */
function bannerWithText(container: HTMLElement, text: string): HTMLElement | null {
  const hits = [...container.querySelectorAll('div')]
    .filter((el) => (el.textContent ?? '').includes(text));
  return hits.length > 0 ? (hits[hits.length - 1] as HTMLElement) : null;
}

describe('CesiumOverlay — state writes after the init effect is torn down (#2685)', () => {
  beforeEach(() => { resetCesiumStub(); });
  afterEach(() => { cleanup(); resetCesiumStub(); });

  it('detaches the basemap error listener with the effect', async () => {
    seedStore(BASEMAP_A);
    mount();
    await waitFor(() => stubProviders.length === 1, 'the custom basemap provider');

    const provider = stubProviders[0];
    assert.equal(
      provider.errorEvent.numberOfListeners, 1,
      'the overlay should be listening for tile errors while the effect is live',
    );

    // The user switches to OSM Map. The custom provider is abandoned, but
    // Cesium keeps it — and its listener array — alive.
    act(() => { useViewerStore.setState({ cesiumDataSource: 'osm-map' } as never); });

    assert.equal(
      provider.errorEvent.numberOfListeners, 0,
      'the listener must not outlive the effect run that registered it',
    );
  });

  it('does not warn about an abandoned basemap after the effect is torn down', async () => {
    seedStore(BASEMAP_A);
    const container = mount();
    await waitFor(() => stubProviders.length === 1, 'the custom basemap provider');
    const provider = stubProviders[0];

    // Tear down, then fire IMMEDIATELY — no flush in between, because the
    // window under test is exactly the one a flush would close.
    act(() => { useViewerStore.setState({ cesiumDataSource: 'osm-map' } as never); });
    act(() => { provider.errorEvent.raiseEvent(CORS_REFUSAL); });

    await settle();
    assert.equal(
      warningText(container), null,
      'a dead provider must not raise a banner over the basemap that replaced it',
    );
  });

  it('does not let a late tile from an abandoned provider retract the live warning', async () => {
    seedStore(BASEMAP_A);
    const container = mount();
    await waitFor(() => stubProviders.length === 1, 'the first custom basemap provider');
    const abandoned = stubProviders[0];
    // A tile was already in flight when the user switched away.
    const inFlight = abandoned.requestImage();

    // Switch to a different custom basemap. `customBasemap` is an effect dep,
    // so this re-runs init and builds a second provider.
    act(() => { useViewerStore.setState({ cesiumCustomBasemap: BASEMAP_B } as never); });
    await waitFor(() => stubProviders.length === 2, 'the replacement basemap provider');
    const live = stubProviders[1];

    // The new one genuinely is refused by the browser.
    act(() => { live.errorEvent.raiseEvent(CORS_REFUSAL); });
    await settle();
    assert.equal(
      warningText(container), BROWSER_ACCESS_BLOCKED,
      'the live basemap being CORS-blocked must raise the banner',
    );

    // Now the abandoned provider's tile finally arrives, successfully. It
    // proves nothing about the basemap on screen.
    abandoned.requests[abandoned.requests.length - 1].resolve({});
    await inFlight;
    await settle();

    assert.equal(
      warningText(container), BROWSER_ACCESS_BLOCKED,
      'a tile from a provider the user switched away from must not retract the live warning',
    );
  });

  it('stacks the loading and warning banners instead of overlapping them', async () => {
    seedStore(BASEMAP_A);
    const container = mount();
    await waitFor(
      () => pendingTerrain.length === 1 && stubProviders.length === 1,
      'init to park on the terrain request with the basemap provider wired',
    );

    act(() => { stubProviders[0].errorEvent.raiseEvent(CORS_REFUSAL); });
    await settle();

    const loading = bannerWithText(container, 'Loading 3D context');
    const warning = container.querySelector('[role="status"]') as HTMLElement | null;
    assert.ok(loading, 'the overlay should still be loading');
    assert.ok(warning, 'the basemap warning should be up at the same time');

    const stack = loading.parentElement;
    assert.ok(stack, 'the loading banner should have a parent');
    assert.ok(
      warning.parentElement === stack,
      'both banners must live in one stack, not in separate positioning contexts',
    );
    assert.ok(
      stack !== container,
      'the banners must be wrapped in their own container, not dropped side by side into the overlay',
    );
    assert.ok(
      stack.className.includes('flex-col'),
      `the stack must lay the banners out in a column; got "${stack.className}"`,
    );
    for (const [name, banner] of [['loading', loading], ['warning', warning]] as const) {
      assert.ok(
        !banner.className.includes('absolute'),
        `the ${name} banner must not position itself — that is what put them on top of each other; got "${banner.className}"`,
      );
    }
  });
});
