/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one piece of CesiumJS that cannot run under `tsx --test`, replaced —
 * and nothing else.
 *
 * `new Cesium.Viewer(...)` builds a `Scene`, which builds a `Context`, which
 * calls `canvas.getContext('webgl2')`. happy-dom has no WebGL, so the
 * constructor throws `RuntimeError: The browser does not support WebGL` and
 * every `CesiumOverlay` init dies in the outer catch before reaching a single
 * line of the code a test would want to exercise. That constructor is the
 * whole wall: the rest of Cesium — `Event`, `Color`, `ShadowMode`, the
 * imagery providers — is plain JavaScript that imports and runs fine.
 *
 * So this module re-exports the REAL `cesium` and shadows exactly two names.
 * `resolve` in `vite-module-hooks-impl.mjs` points the bare `cesium`
 * specifier here, which reaches precisely one runtime import in the whole app
 * (`components/viewer/cesium/cesium-module.ts`); every other mention of
 * `cesium` in `apps/viewer/src` is a `typeof import('cesium')` type position
 * and is erased before Node sees it.
 *
 * **The stubs are deliberately small and honest.** `StubViewer` carries the
 * properties `CesiumOverlay`'s init routine actually assigns and nothing more;
 * a test that needs real scene behaviour needs a browser, not a bigger stub
 * here. Growing this file until it pretends to be Cesium would make it
 * load-bearing for code it does not model, which is the failure the
 * `store-fixture.ts` header warns about in the same words.
 *
 * `errorEvent` is a REAL `Cesium.Event`, not a hand-rolled emitter: the
 * behaviour under test in `CesiumOverlay.teardown.test.tsx` is whether the
 * component detaches its listener, and `numberOfListeners` /
 * `addEventListener`'s returned remover are precisely the Cesium semantics
 * that answer it.
 */

import { Event as CesiumEvent } from 'cesium';

export * from 'cesium';

/** A tile request handed back by {@link StubUrlTemplateImageryProvider}. */
export interface StubTileRequest {
  promise: Promise<unknown>;
  resolve: (value?: unknown) => void;
  reject: (reason?: unknown) => void;
}

function defer<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (r?: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (r?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Stands in for `UrlTemplateImageryProvider`. The real one would work under
 * Node, but its `requestImage` goes to the network — and the retraction path
 * (`attachTileSuccessRetraction`) is defined by what that promise DOES, so a
 * test needs to settle it by hand rather than wait on a host.
 */
export class UrlTemplateImageryProvider {
  readonly options: unknown;
  readonly errorEvent = new CesiumEvent();
  readonly ready = true;
  /** Every request this provider has been asked for, newest last. */
  readonly requests: StubTileRequest[] = [];

  constructor(options: unknown) {
    this.options = options;
    stubProviders.push(this);
  }

  requestImage(): Promise<unknown> {
    const d = defer<unknown>();
    this.requests.push(d);
    return d.promise;
  }
}

/** Every {@link UrlTemplateImageryProvider} constructed since the last reset. */
export const stubProviders: UrlTemplateImageryProvider[] = [];

/** Every {@link Viewer} constructed since the last reset. */
export const stubViewers: StubViewer[] = [];

/**
 * `CesiumTerrainProvider.fromIonAssetId` is left DEFERRED on purpose: it is
 * the one `await` in `CesiumOverlay`'s init that sits between "the basemap
 * provider exists and its error listener is attached" and `setStatus('ready')`.
 * Parking the init there is how a test observes the loading banner and the
 * basemap warning on screen at the same time — the state the banner-stacking
 * fix exists for. Resolve or reject it to let init continue.
 */
export const CesiumTerrainProvider = {
  fromIonAssetId(): Promise<unknown> {
    const d = defer<unknown>();
    pendingTerrain.push(d);
    return d.promise;
  },
};

/** Outstanding {@link CesiumTerrainProvider.fromIonAssetId} calls. */
export const pendingTerrain: Array<{ promise: Promise<unknown>; resolve: (v: unknown) => void; reject: (r?: unknown) => void }> = [];

interface StubGlobe {
  show: boolean;
  shadows: unknown;
  depthTestAgainstTerrain: boolean;
  showGroundAtmosphere: boolean;
  baseColor: unknown;
}

/** The subset of `Viewer` that `CesiumOverlay`'s init routine touches. */
export class StubViewer {
  destroyed = false;
  terrainProvider: unknown = null;
  readonly bottomContainer: HTMLElement;
  readonly imageryProviders: unknown[] = [];
  readonly imageryLayers = {
    addImageryProvider: (provider: unknown) => { this.imageryProviders.push(provider); return provider; },
  };
  readonly scene = {
    screenSpaceCameraController: {
      enableInputs: true, enableRotate: true, enableTranslate: true, enableZoom: true,
      enableTilt: true, enableLook: true, enableCollisionDetection: true,
      minimumZoomDistance: 0, maximumZoomDistance: Infinity,
    },
    globe: {
      show: true, shadows: null, depthTestAgainstTerrain: false,
      showGroundAtmosphere: true, baseColor: null,
    } as StubGlobe,
    skyBox: { show: true },
    sun: { show: true },
    moon: { show: true },
    skyAtmosphere: { show: true },
    fog: { enabled: true },
    backgroundColor: null as unknown,
    primitives: { add: (p: unknown) => p },
  };

  constructor(container: HTMLElement, _options?: unknown) {
    this.bottomContainer = container.ownerDocument.createElement('div');
    stubViewers.push(this);
  }

  destroy(): void { this.destroyed = true; }
}

export { StubViewer as Viewer };

/** Drop everything the stubs recorded. Call from `beforeEach`. */
export function resetCesiumStub(): void {
  stubProviders.length = 0;
  stubViewers.length = 0;
  pendingTerrain.length = 0;
}
