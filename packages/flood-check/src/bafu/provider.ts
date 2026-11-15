/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * {@link HazardProvider} for the BAFU surface-runoff hazard map, read through
 * WMS GetMap on wms.geo.admin.ch and decoded by exact legend colour.
 *
 * No federal service returns the depth class for a point (GetFeatureInfo
 * answers wet/dry only), so the rendered map is the data source. The request
 * box is snapped outward to the cell grid so cells line up with the 1 m model
 * raster, and kept at 9 pixels or more per side (the server answers HTTP 500
 * to a 1 x 1 request).
 */

import { classifyRgba, type StyleCheckOptions } from '../legend.js';
import { decodePng } from '../png.js';
import { HazardRequestError, HazardResponseError, FloodCheckRefusal } from '../errors.js';
import { sameCrs } from '../crs.js';
import {
  CELL_NO_RUNOFF,
  CELL_UNCLASSIFIED,
  type ClassifiedHazardRaster,
  type HazardProvider,
  type HazardRasterRequest,
  type MapBBox,
  type RenderingConfirmation,
} from '../types.js';
import { bafuCovers } from './coverage.js';
import {
  BAFU_ATTRIBUTION,
  BAFU_CLASSES,
  BAFU_CRS,
  BAFU_DATASET_DATE,
  BAFU_DISCLAIMER,
  BAFU_EXTENT,
  BAFU_LAYER,
  BAFU_LEGEND,
  BAFU_LICENCE,
  BAFU_LIMITS,
  BAFU_METADATA_UPDATED,
  BAFU_MODEL_CELL_SIZE,
  BAFU_REFERENCE_BOX,
  BAFU_REFERENCE_CELL_SIZE,
  BAFU_RETURN_PERIOD,
  BAFU_TITLE,
  BAFU_WMS_URL,
} from './dataset.js';

/** A cached raw response. */
export interface CachedHazardResponse {
  bytes: Uint8Array;
  /** ISO 8601 time the bytes were fetched from the service. */
  retrievedAt: string;
}

/** Cache hook, keyed by the exact request URL. Errors from it propagate. */
export interface HazardResponseCache {
  get(key: string): CachedHazardResponse | undefined | Promise<CachedHazardResponse | undefined>;
  set(key: string, value: CachedHazardResponse): void | Promise<void>;
}

export interface BafuProviderOptions {
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Default 20 000. */
  timeoutMs?: number;
  cache?: HazardResponseCache;
  /** Default cell size in metres. Default 0.5 (half the 1 m model raster), which is also the largest allowed. */
  cellSize?: number;
  /** Largest image side in pixels before a request is refused. Default 4096. */
  maxPixels?: number;
  /** Base URL of the WMS. Default https://wms.geo.admin.ch/. */
  baseUrl?: string;
  style?: StyleCheckOptions;
  /** Clock for `retrievedAt`; defaults to `new Date()`. */
  now?: () => Date;
}

const MIN_PIXELS = 9;

/** Snap `bbox` outward to multiples of `cellSize`, growing it to at least {@link MIN_PIXELS} cells per side. */
export function snapRequestBox(bbox: MapBBox, cellSize: number): { bbox: MapBBox; width: number; height: number } {
  let minX = Math.floor(bbox.minX / cellSize) * cellSize;
  let maxX = Math.ceil(bbox.maxX / cellSize) * cellSize;
  let minY = Math.floor(bbox.minY / cellSize) * cellSize;
  let maxY = Math.ceil(bbox.maxY / cellSize) * cellSize;
  let width = Math.round((maxX - minX) / cellSize);
  let height = Math.round((maxY - minY) / cellSize);
  if (width < MIN_PIXELS) {
    const grow = MIN_PIXELS - width;
    minX -= Math.floor(grow / 2) * cellSize;
    maxX += Math.ceil(grow / 2) * cellSize;
    width = MIN_PIXELS;
  }
  if (height < MIN_PIXELS) {
    const grow = MIN_PIXELS - height;
    minY -= Math.floor(grow / 2) * cellSize;
    maxY += Math.ceil(grow / 2) * cellSize;
    height = MIN_PIXELS;
  }
  return { bbox: { minX, minY, maxX, maxY }, width, height };
}

/** The GetMap URL for a snapped box. WMS 1.3.0 with EPSG:2056 takes the box as easting, northing. */
export function bafuGetMapUrl(bbox: MapBBox, width: number, height: number, baseUrl = BAFU_WMS_URL): string {
  const fmt = (v: number) => String(Math.round(v * 1000) / 1000);
  const params = [
    ['SERVICE', 'WMS'],
    ['VERSION', '1.3.0'],
    ['REQUEST', 'GetMap'],
    ['LAYERS', BAFU_LAYER],
    ['STYLES', ''],
    ['CRS', BAFU_CRS],
    ['BBOX', [bbox.minX, bbox.minY, bbox.maxX, bbox.maxY].map(fmt).join(',')],
    ['WIDTH', String(width)],
    ['HEIGHT', String(height)],
    ['FORMAT', 'image/png'],
    ['TRANSPARENT', 'true'],
  ];
  return `${baseUrl}?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

/** A signal that aborts on the caller's signal or after `timeoutMs`, plus its cleanup. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new HazardRequestError(`hazard request timed out after ${timeoutMs} ms`)),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function fetchBytes(url: string, fetchImpl: typeof fetch, signal: AbortSignal, timeoutMs: number): Promise<Uint8Array> {
  const timed = withTimeout(signal, timeoutMs);
  try {
    let response: Response;
    timed.signal.throwIfAborted();
    try {
      response = await fetchImpl(url, { signal: timed.signal });
    } catch (error) {
      if (timed.signal.reason instanceof HazardRequestError) throw timed.signal.reason;
      if (signal.aborted) throw error;
      throw new HazardRequestError(`hazard request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      throw new HazardRequestError(`hazard service answered HTTP ${response.status}`, response.status);
    }
    const contentType = response.headers.get('content-type') ?? '';
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!contentType.toLowerCase().startsWith('image/png')) {
      const text = new TextDecoder().decode(bytes.subarray(0, 400)).replace(/\s+/g, ' ').trim();
      throw new HazardResponseError(`hazard service answered ${contentType || 'without a content type'}, not a PNG: ${text}`);
    }
    return bytes;
  } finally {
    timed.done();
  }
}

/** Largest cell size a request may use: half the 1 m model raster. */
const MAX_CELL_SIZE = 0.5;

/** Create the BAFU surface-runoff provider. */
export function createBafuRunoffProvider(options: BafuProviderOptions = {}): HazardProvider {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const defaultCell = options.cellSize ?? 0.5;
  const maxPixels = options.maxPixels ?? 4096;
  const now = options.now ?? (() => new Date());
  let rendering: Promise<RenderingConfirmation> | null = null;

  async function raster(bbox: MapBBox, cellSize: number, signal: AbortSignal): Promise<ClassifiedHazardRaster> {
    if (!(cellSize > 0)) throw new RangeError('cellSize must be positive');
    const snapped = snapRequestBox(bbox, cellSize);
    if (snapped.width > maxPixels || snapped.height > maxPixels) {
      throw new FloodCheckRefusal(
        'request-too-large',
        `a request of ${snapped.width} x ${snapped.height} px at ${cellSize} m exceeds ${maxPixels} px per side; ` +
          'a single building never needs that much, so check the georeferencing (unit, scale) or the requested box',
      );
    }
    const url = bafuGetMapUrl(snapped.bbox, snapped.width, snapped.height, options.baseUrl);
    let cached = await options.cache?.get(url);
    if (!cached) {
      if (!fetchImpl) throw new HazardRequestError('no fetch implementation is available');
      const bytes = await fetchBytes(url, fetchImpl, signal, timeoutMs);
      cached = { bytes, retrievedAt: now().toISOString() };
      await options.cache?.set(url, cached);
    }
    const image = decodePng(cached.bytes);
    if (image.width !== snapped.width || image.height !== snapped.height) {
      throw new HazardResponseError(
        `hazard image is ${image.width} x ${image.height} px; ${snapped.width} x ${snapped.height} px were requested`,
      );
    }
    const decoded = classifyRgba(image.rgba, BAFU_LEGEND, BAFU_CLASSES, options.style);
    return {
      crs: BAFU_CRS,
      width: image.width,
      height: image.height,
      cellSize,
      origin: { x: snapped.bbox.minX, y: snapped.bbox.maxY },
      cells: decoded.cells,
      classes: BAFU_CLASSES,
      counts: decoded.counts,
      provenance: {
        providerId: 'bafu-surface-runoff',
        datasetId: BAFU_LAYER,
        datasetTitle: BAFU_TITLE,
        datasetDate: BAFU_DATASET_DATE,
        metadataUpdated: BAFU_METADATA_UPDATED,
        retrievedAt: cached.retrievedAt,
        requestUrl: url,
        attribution: BAFU_ATTRIBUTION,
        licence: BAFU_LICENCE,
        returnPeriod: BAFU_RETURN_PERIOD,
        limits: BAFU_LIMITS,
        disclaimer: BAFU_DISCLAIMER,
      },
    };
  }

  async function confirm(signal: AbortSignal): Promise<RenderingConfirmation> {
    const snapped = snapRequestBox(BAFU_REFERENCE_BOX, BAFU_REFERENCE_CELL_SIZE);
    const url = bafuGetMapUrl(snapped.bbox, snapped.width, snapped.height, options.baseUrl);
    try {
      const reference = await raster(BAFU_REFERENCE_BOX, BAFU_REFERENCE_CELL_SIZE, signal);
      const classified = reference.cells.filter((c) => c !== CELL_NO_RUNOFF && c !== CELL_UNCLASSIFIED).length;
      // The reference box is uniform: every pixel shows a mapped class. A partially rendered response (some pixels
      // classified, the rest transparent) must not confirm a layer whose building raster may be just as incomplete.
      return classified === reference.cells.length && classified > 0
        ? { confirmed: true, requestUrl: url, detail: `${classified} of ${reference.cells.length} reference pixels show a mapped class` }
        : {
            confirmed: false,
            requestUrl: url,
            detail: classified === 0
              ? 'the reference area, where the map shows runoff, came back without any mapped class'
              : `the reference area, where the map shows a mapped class in every pixel, came back with only ${classified} of ${reference.cells.length} pixels classified`,
          };
    } catch (error) {
      if (!(error instanceof HazardRequestError || error instanceof HazardResponseError)) throw error;
      return { confirmed: false, requestUrl: url, detail: `the reference request failed: ${error.message}` };
    }
  }

  return {
    id: 'bafu-surface-runoff',
    crs: BAFU_CRS,
    classes: BAFU_CLASSES,
    extent: BAFU_EXTENT,
    modelCellSize: BAFU_MODEL_CELL_SIZE,
    covers: bafuCovers,
    async fetchRaster(request: HazardRasterRequest): Promise<ClassifiedHazardRaster> {
      if (!sameCrs(request.crs, BAFU_CRS)) {
        throw new FloodCheckRefusal('crs-mismatch', `the BAFU map is published in ${BAFU_CRS}; the request is in ${request.crs}`);
      }
      const b = request.bbox;
      if (b.maxX < BAFU_EXTENT.minX || b.minX > BAFU_EXTENT.maxX || b.maxY < BAFU_EXTENT.minY || b.minY > BAFU_EXTENT.maxY) {
        throw new FloodCheckRefusal('outside-provider-extent', `the requested box lies outside the BAFU layer extent`);
      }
      const cellSize = request.cellSize ?? defaultCell;
      if (!(cellSize > 0 && cellSize <= MAX_CELL_SIZE)) {
        throw new RangeError(
          `cellSize must be > 0 and at most ${MAX_CELL_SIZE} m (half the 1 m model raster; coarser cells can drop a thin flow path), got ${cellSize}`,
        );
      }
      return raster(b, cellSize, request.signal ?? new AbortController().signal);
    },
    /** One 9 x 9 px request at the documented reference location, made once per provider and cached like any other. */
    confirmRendering(signal?: AbortSignal): Promise<RenderingConfirmation> {
      if (!rendering) {
        rendering = confirm(signal ?? new AbortController().signal);
        // A failed or negative answer is not kept: the next check asks again.
        void rendering.then((r) => {
          if (!r.confirmed) rendering = null;
        }, () => {
          rendering = null;
        });
      }
      return rendering;
    },
  };
}
