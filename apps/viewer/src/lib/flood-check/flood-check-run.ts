/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Run flood check": screen a georeferenced IFC model against the federal
 * overland flow map (BAFU) with `@ifc-lite/flood-check`, and record the result
 * in the flood-check slice.
 *
 * Only ever started by a user click. Every request goes through the swisstopo
 * host allowlist (`swisstopoFetch`): the hazard map from wms.geo.admin.ch, the
 * terrain (swissALTI3D) from data.geo.admin.ch, both through the site-context
 * response cache. The model's facts are read from its parsed data store as
 * loaded: a georeference edited in the viewer and not yet saved is refused,
 * since the check would read the old one.
 *
 * Nothing is written into the model; the element and site property sets are
 * kept as payloads for the property panel.
 */

import {
  BAFU_CLASSES,
  createBafuRunoffProvider,
  extractModelFacts,
  FloodCheckRefusal,
  runFloodCheck,
  toPropertySets,
  type FloodPropertySet,
  type TerrainSource,
} from '@ifc-lite/flood-check';
import { createSwissGeodata, type SwissGeodata } from '@ifc-lite/geodata-ch';
import { useViewerStore } from '@/store';
import { watchLoadSupersession } from '@/hooks/modelLoadCanceller';
import { createSiteContextResponseCache } from '@/lib/site-context/response-cache';
import { swisstopoFetch } from '@/lib/site-context/swisstopo-fetch';

/**
 * swissALTI3D's stated vertical accuracy (1 sigma) for the previous LiDAR
 * generation below 2,000 m a.s.l. Where the newer 0.3 m data exists this
 * overstates the error, which only widens the clearance margin (the
 * conservative side). Source: swisstopo, swissALTI3D product page, "Quality".
 */
export const SWISSALTI3D_VERTICAL_ACCURACY = 0.5;

/** swissALTI3D through the geodata client, as the flood check's terrain source (node grids, LN02). */
export function swissAlti3dTerrain(geodata: Pick<SwissGeodata, 'elevationGrid'>): TerrainSource {
  return {
    crs: 'EPSG:2056',
    verticalCrs: 'EPSG:5728',
    verticalReference: 'LN02',
    verticalAccuracy: SWISSALTI3D_VERTICAL_ACCURACY,
    async grid(bbox, options) {
      return { ...(await geodata.elevationGrid(bbox, options)), sampling: 'node' };
    },
  };
}

export interface RunViewerFloodCheckOptions {
  modelId: string;
  /** The ground storey by express id; unset lets the check guess (then no favourable outcome is given). */
  groundStorey?: number;
}

/** A refusal by the viewer itself (nothing the check could read): reported, not logged as a failure. */
class ViewerRefusal extends Error {}

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError';

/** Run the check for `modelId`. Settles into the slice; never throws. */
export async function runViewerFloodCheck(options: RunViewerFloodCheckOptions): Promise<void> {
  const store = useViewerStore.getState;
  const abort = new AbortController();
  store().beginFloodCheck(options.modelId, abort);
  const current = () => !abort.signal.aborted && store().isFloodCheckRunCurrent(abort);
  // A primary load that replaces the scene ends the run, as it ends a site-context fetch.
  const supersession = watchLoadSupersession('primary');
  const onSuperseded = () => abort.abort();
  supersession.signal.addEventListener('abort', onSuperseded, { once: true });
  try {
    const model = store().models.get(options.modelId);
    const dataStore = model?.ifcDataStore;
    if (!dataStore) throw new ViewerRefusal('The flood check reads IFC models only; this model has no IFC data.');
    if (store().georefMutations.has(options.modelId)) {
      throw new ViewerRefusal('The georeference of this model was edited in the viewer and the check reads the georeference the file states. Export the model and open it again to check it with the edited georeference.');
    }
    // Let the panel show "running" before the synchronous read of the model.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!current()) return;
    const facts = extractModelFacts(dataStore, {
      expectedCrs: 'EPSG:2056',
      ...(options.groundStorey !== undefined ? { groundStorey: options.groundStorey } : {}),
    });
    const counting = swisstopoFetch();
    const geodata = createSwissGeodata({ fetch: counting.fetch, cache: createSiteContextResponseCache() });
    const provider = createBafuRunoffProvider({
      fetch: (input, init) => counting.fetch(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init),
    });
    const result = await runFloodCheck(facts, provider, swissAlti3dTerrain(geodata), { signal: abort.signal });
    if (!current()) return;
    const { site, elements } = toPropertySets(result, BAFU_CLASSES);
    const elementSets = new Map<number, FloodPropertySet>(elements.map((entry) => [entry.expressId, entry.propertySet]));
    store().finishFloodCheck(abort, {
      result, elementSets, siteSet: site, requests: counting.requests, bytes: counting.bytes, finishedAt: Date.now(),
    });
  } catch (error) {
    if (isAbort(error) || !current()) return;
    if (!(error instanceof FloodCheckRefusal) && !(error instanceof ViewerRefusal)) console.error('[flood-check] the check failed:', error);
    store().failFloodCheck(abort, {
      message: error instanceof Error ? error.message : String(error),
      code: error instanceof FloodCheckRefusal ? error.code : null,
    });
  } finally {
    supersession.signal.removeEventListener('abort', onSuperseded);
    supersession.stop();
  }
}
