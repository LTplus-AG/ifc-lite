/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Region query over a 3D Tiles tileset: traverse, fetch, decode, filter. */

import { type ContentKind, decodeTileContent, detectContentKind } from './content/decode.js';
import { type DracoLoader, defaultDracoLoader } from './content/draco.js';
import type { FeatureMesh } from './content/features.js';
import { BudgetExhaustedError, BudgetedFetcher, type FetcherOptions, type FetchStats } from './fetcher.js';
import { ecefToGeodetic } from './geodesy.js';
import { ContentRejectedError, DecodeBudget, DecodeLimitError, type DecodeLimits, finiteNumber, positiveInteger } from './limits.js';
import { type ReaderIssue, type SelectedContent, type TileProvenance, type TraversalOptions, Traverser, type Truncation } from './traverse.js';
import { UrlPolicy, UrlPolicyError, type UrlPolicyOptions } from './url-policy.js';
import { expandRegion, type GeoRegion, prepareRegion } from './volume.js';

export interface ReadTilesetRegionOptions extends FetcherOptions, TraversalOptions, DecodeLimits, UrlPolicyOptions {
  /** Root tileset JSON URL. */
  url: string;
  /** Query region, WGS84 degrees. */
  region: GeoRegion;
  /**
   * Grow the region by this many metres when culling tiles (not when filtering
   * features). Default 0. Use it for tilesets whose bounding volumes do not
   * fully enclose their content, which the specification requires but some
   * producers violate: swisstopo assigns each building to the tile holding its
   * centre, so a building can overhang its tile by tens of metres.
   */
  tileCullMarginMetres?: number;
  /** Parallel content requests; default 4. */
  concurrency?: number;
  /**
   * `intersects` (default) keeps features whose vertex lon/lat bounds overlap
   * the region; `tiles` keeps every feature of every intersecting tile.
   */
  featureFilter?: 'intersects' | 'tiles';
  /** Custom Draco decoder module loader (overrides `dracoModuleOptions`). */
  loadDraco?: DracoLoader;
  /**
   * Emscripten options for the shared default `draco3d` decoder, e.g.
   * `{ locateFile: () => wasmUrl }` in a browser bundle. The first load's
   * options apply until `resetDracoDecoder()`.
   */
  dracoModuleOptions?: Record<string, unknown>;
}
export interface TileContentInfo extends TileProvenance {
  kind: ContentKind;
  byteLength: number;
  /** Features decoded from this content (before the region filter). */
  featureCount: number;
  batchLength?: number;
  /** Batch table column names present in this tile. */
  attributeNames?: string[];
  rtcCenter?: [number, number, number];
}

export interface RegionReadResult {
  features: FeatureMesh[];
  tiles: TileContentInfo[];
  /** Errors, unsupported content and caveats, each tied to a URL. */
  issues: ReaderIssue[];
  /** True when a budget stopped the query before every selected tile was fetched. */
  truncated: boolean;
  truncation?: Truncation;
  /** Not truncated, and no `error` or `unsupported` issues (warnings allowed). */
  complete: boolean;
  stats: FetchStats & {
    nodesVisited: number;
    tilesetsLoaded: number;
    /** Tile contents selected (tilesets found by content are not counted). */
    contentsSelected: number;
    /** Features dropped by the `intersects` filter. */
    featuresOutsideRegion: number;
    /** Decoded vertices and triangle indices charged against the decode limits (kept contents only). */
    decodedVertices: number;
    decodedIndices: number;
  };
}

/**
 * Longitudes are unwrapped around the first vertex, so a feature that crosses
 * the antimeridian (vertices at 179.9 and -179.9) spans 0.2 degrees, not 359.8.
 */
function lonLatBoundsOverlap(f: FeatureMesh, region: GeoRegion): boolean {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const p = f.positions;
  let lon0 = NaN;
  for (let i = 0; i < p.length; i += 3) {
    const g = ecefToGeodetic(p[i], p[i + 1], p[i + 2]);
    if (Number.isNaN(lon0)) lon0 = g.lon;
    let d = g.lon - lon0;
    if (d > 180) d -= 360;
    else if (d < -180) d += 360;
    if (d < w) w = d;
    if (d > e) e = d;
    if (g.lat < s) s = g.lat;
    if (g.lat > n) n = g.lat;
  }
  if (!(s <= region.north && region.south <= n)) return false;
  const lo = lon0 + w, hi = lon0 + e;
  const spans: Array<[number, number]> = region.west <= region.east ? [[region.west, region.east]] : [[region.west, 180], [-180, region.east]];
  return spans.some(([a, b]) => [-360, 0, 360].some((k) => lo <= b + k && a + k <= hi));
}

/** Run `fn` over `items` with at most `n` in flight. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}

/**
 * Read every feature of a tileset inside a WGS84 region as meshes with attributes.
 *
 * Never throws away partial work: a budget stop sets `truncated` and lists
 * the unfetched URLs, failed requests, refused URLs and undecodable or
 * oversized tiles become `issues`. It throws only when the root tileset cannot
 * be loaded (including a root URL the URL policy refuses), an option or the
 * region is invalid, or the caller's `signal` aborts.
 */
export async function readTilesetRegion(options: ReadTilesetRegionOptions): Promise<RegionReadResult> {
  // Every numeric option is validated before any request; invalid values throw a RangeError, never clamp.
  prepareRegion(options.region);
  const margin = finiteNumber(options.tileCullMarginMetres, 0, 'tileCullMarginMetres', 0);
  const concurrency = positiveInteger(options.concurrency, 4, 'concurrency');
  const query = prepareRegion(expandRegion(options.region, margin));
  const fetcher = new BudgetedFetcher(options);
  fetcher.policy = new UrlPolicy(options.url, options);
  const budget = new DecodeBudget(options);
  const loadDraco = options.loadDraco ?? defaultDracoLoader(options.dracoModuleOptions);
  const traverser = new Traverser(fetcher, query, options);
  await traverser.loadRoot(options.url);
  const issues = traverser.issues;
  const pending = traverser.pending;
  const tiles: TileContentInfo[] = [];
  const decoded: FeatureMesh[][] = [];
  let contentsSelected = 0;
  let budgetReason: Truncation['reason'] | undefined;

  const loadContent = async (sel: SelectedContent, index: number, externals: Array<[SelectedContent, Uint8Array]>): Promise<void> => {
    contentsSelected++;
    if (budget.exhausted()) {
      budgetReason ??= 'decoded';
      pending.add(sel.url);
      return;
    }
    // After the budget runs out each get() still serves cache hits and throws for the rest.
    let bytes = sel.bytes;
    if (!bytes) {
      try {
        bytes = await fetcher.get(sel.url);
      } catch (err) {
        if (err instanceof BudgetExhaustedError) {
          budgetReason ??= err.reason;
          pending.add(sel.url);
        } else {
          fetcher.throwIfAborted();
          issues.push({ url: sel.url, severity: 'error', message: err instanceof Error ? err.message : String(err), code: err instanceof UrlPolicyError ? 'url-policy' : undefined });
        }
        return;
      }
    }
    const kind = detectContentKind(bytes);
    // External tilesets are identified by content (JSON with a tileset shape), not by a `.json` URI.
    if (kind === 'tileset') {
      contentsSelected--;
      externals.push([sel, bytes]);
      return;
    }
    const tile: TileProvenance = {
      url: sel.url, tilesetUrl: sel.tilesetUrl, tilesetChain: sel.tilesetChain, assetVersion: sel.assetVersion, tilesetVersion: sel.tilesetVersion,
    };
    const share = budget.forContent();
    try {
      const content = await decodeTileContent(bytes, tile, sel.transform, loadDraco, share);
      for (const w of content.warnings) issues.push({ url: sel.url, severity: 'warning', message: w });
      if (content.unsupported) issues.push({ url: sel.url, severity: 'unsupported', message: content.unsupported });
      decoded[index] = content.features;
      tiles.push({
        ...tile, kind: content.kind, byteLength: bytes.byteLength, featureCount: content.features.length,
        batchLength: content.batchLength, attributeNames: content.attributeNames, rtcCenter: content.rtcCenter,
      });
    } catch (err) {
      share.release();
      fetcher.throwIfAborted();
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof DecodeLimitError) {
        // A decode limit stops this content like a byte budget stops a request: truncation, URL pending.
        budgetReason ??= 'decoded';
        pending.add(sel.url);
        if (err.scope === 'content') issues.push({ url: sel.url, severity: 'error', message: `decode: ${msg}`, code: 'limit' });
      } else {
        const code = err instanceof ContentRejectedError ? err.code : err instanceof SyntaxError ? 'invalid-content' : undefined;
        issues.push({ url: sel.url, severity: 'error', message: `decode: ${msg}`, code });
      }
    }
  };

  // Rounds: decode the selection, follow tilesets found by content, traverse them, repeat.
  for (let round = await traverser.run(); round.length > 0; round = await traverser.run()) {
    const externals: Array<[SelectedContent, Uint8Array]> = [];
    const work = round.map((sel, i) => [sel, decoded.length + i] as const);
    decoded.length += round.length;
    await pool(work, concurrency, ([sel, index]) => loadContent(sel, index, externals));
    for (const [sel, bytes] of externals) traverser.addExternalTileset(sel.url, bytes, sel.parent);
  }

  const traversalTruncation = traverser.truncation();
  const reason = traversalTruncation?.reason ?? budgetReason;
  const truncation: Truncation | undefined = reason ? { reason, pendingUrls: [...pending] } : undefined;
  let featuresOutsideRegion = 0;
  const features: FeatureMesh[] = [];
  for (const list of decoded) {
    for (const f of list ?? []) {
      if (options.featureFilter !== 'tiles' && f.positions.length > 0 && !lonLatBoundsOverlap(f, options.region)) {
        featuresOutsideRegion++;
        continue;
      }
      features.push(f);
    }
  }
  tiles.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return {
    features,
    tiles,
    issues,
    truncated: truncation !== undefined,
    truncation,
    complete: truncation === undefined && !issues.some((i) => i.severity !== 'warning'),
    stats: {
      ...fetcher.stats,
      nodesVisited: traverser.nodesVisited,
      tilesetsLoaded: traverser.tilesetsLoaded,
      contentsSelected,
      featuresOutsideRegion,
      decodedVertices: budget.vertices,
      decodedIndices: budget.indices,
    },
  };
}
