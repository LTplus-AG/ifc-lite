/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Builds site context off the main thread: `buildSiteContext` with the Swiss
 * geodata client, every request through the swisstopo host allowlist and the
 * IndexedDB response cache, and each category posted as a single-category GLB
 * the moment it is finished (terrain loads while the parcel is still being
 * looked up). Cancelling terminates the worker, which aborts every request.
 */

import type { SiteContextLayer } from '@ifc-lite/site-context';
import type { SiteContextWorkerRequest, SiteContextWorkerResponse } from '../lib/site-context/site-context-job';

/**
 * The geodata client, the core and their helpers load with the first build
 * request, not with the worker: the worker chunk stays small and starts at
 * once, and its leading code is this file's own (the viewer build's TLA chunk
 * gate judges minification from a chunk's prologue).
 */
const loadModules = () => Promise.all([
  import('@ifc-lite/geodata-ch'),
  import('@ifc-lite/site-context'),
  import('../lib/site-context/response-cache'),
  import('../lib/site-context/swisstopo-fetch'),
  import('../lib/site-context/site-context-glb'),
]);

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SiteContextWorkerRequest>) => void) | null;
  postMessage(message: SiteContextWorkerResponse, transfer?: Transferable[]): void;
};

const hasGeometry = (layer: SiteContextLayer): boolean =>
  layer.features.some((feature) => feature.mesh !== null && feature.mesh.indices.length > 0);

scope.onmessage = (event) => {
  const message = event.data;
  if (message?.type !== 'build') return;
  const { id, request } = message;
  void loadModules().then(([
    { createSwissGeodata }, { buildSiteContext, encodeSiteContextGlb, SiteContextCoverageError },
    { createSiteContextResponseCache }, { swisstopoFetch }, { categoryOrigin },
  ]) => {
    const counting = swisstopoFetch();
    const cache = createSiteContextResponseCache();
    // Offline, a miss should become an issue now, not after a minute of backoff.
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const geodata = createSwissGeodata({ fetch: counting.fetch, cache, ...(offline ? { maxRetries: 0, timeoutMs: 5_000 } : {}) });
    const stats = () => ({ requests: geodata.requestCount, bytes: counting.bytes, cacheHits: cache.hits });
    return buildSiteContext({
      centre: request.centre,
      radius: request.radius,
      layers: request.categories,
      resolution: 'auto',
      ...(request.egrid ? { subject: { egrid: request.egrid } } : {}),
      geodata,
      onProgress: (progress) => scope.postMessage({ type: 'progress', id, progress }),
      onLayer: (layer) => {
        const bytes = encodeSiteContextGlb({
          crs: 'EPSG:2056', verticalCrs: 'EPSG:5728', origin: categoryOrigin(request.centre, layer), layers: [layer],
        });
        scope.postMessage({
          type: 'category', id, kind: layer.kind, bytes, hasGeometry: hasGeometry(layer),
          complete: layer.complete, issues: layer.issues, attribution: layer.attribution,
        }, [bytes.buffer as ArrayBuffer]);
      },
    }).then(
      () => scope.postMessage({ type: 'complete', id, stats: stats() }),
      (error: unknown) => {
        console.error('[site-context] build failed:', error);
        scope.postMessage({
          type: 'error', id, message: error instanceof Error ? error.message : String(error),
          coverage: error instanceof SiteContextCoverageError, stats: stats(),
        });
      },
    );
  }, (error: unknown) => {
    console.error('[site-context] worker modules failed to load:', error);
    scope.postMessage({ type: 'error', id, message: `The site-context worker could not start: ${error instanceof Error ? error.message : String(error)}`, coverage: false, stats: { requests: 0, bytes: 0, cacheHits: 0 } });
  });
};
