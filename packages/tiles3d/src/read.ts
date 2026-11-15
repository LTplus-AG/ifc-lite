/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Region query over a 3D Tiles tileset: traverse, fetch, decode, filter. */

import { type ContentKind, decodeTileContent } from './content/decode.js';
import { type DracoLoader, defaultDracoLoader } from './content/draco.js';
import type { FeatureMesh } from './content/features.js';
import { BudgetExhaustedError, BudgetedFetcher, type FetcherOptions, type FetchStats } from './fetcher.js';
import { ecefToGeodetic } from './geodesy.js';
import { type ReaderIssue, type TileProvenance, type TraversalOptions, type Truncation, traverseTileset } from './traverse.js';
import { expandRegion, type GeoRegion, prepareRegion } from './volume.js';

export interface ReadTilesetRegionOptions extends FetcherOptions, TraversalOptions {
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
  /** Emscripten options for the default lazy `draco3d` decoder, e.g. `{ locateFile }` in a browser bundle. */
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
    contentsSelected: number;
    /** Features dropped by the `intersects` filter. */
    featuresOutsideRegion: number;
  };
}

function lonLatBoundsOverlap(f: FeatureMesh, region: GeoRegion): boolean {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const p = f.positions;
  for (let i = 0; i < p.length; i += 3) {
    const g = ecefToGeodetic(p[i], p[i + 1], p[i + 2]);
    if (g.lon < w) w = g.lon;
    if (g.lon > e) e = g.lon;
    if (g.lat < s) s = g.lat;
    if (g.lat > n) n = g.lat;
  }
  if (!(s <= region.north && region.south <= n)) return false;
  const spans: Array<[number, number]> = region.west <= region.east ? [[region.west, region.east]] : [[region.west, 180], [-180, region.east]];
  return spans.some(([a, b]) => w <= b && a <= e);
}

/**
 * Read every feature of a tileset inside a WGS84 region as meshes with attributes.
 *
 * Never throws away partial work: a budget stop sets `truncated` and lists
 * the unfetched URLs, failed requests and undecodable tiles become `issues`.
 * It throws only when the root tileset cannot be loaded, the region is
 * invalid, or the caller's `signal` aborts.
 */
export async function readTilesetRegion(options: ReadTilesetRegionOptions): Promise<RegionReadResult> {
  prepareRegion(options.region); // validate the caller's region before any request
  const query = prepareRegion(expandRegion(options.region, options.tileCullMarginMetres ?? 0));
  const fetcher = new BudgetedFetcher(options);
  const loadDraco = options.loadDraco ?? defaultDracoLoader(options.dracoModuleOptions);
  const traversal = await traverseTileset(fetcher, options.url, query, options);
  const issues: ReaderIssue[] = [...traversal.issues];
  const tiles: TileContentInfo[] = [];
  const decoded: FeatureMesh[][] = [];
  let truncation = traversal.truncation;
  const pending = new Set(truncation?.pendingUrls ?? []);
  let budgetReason: Truncation['reason'] | undefined = truncation?.reason;

  const queue = traversal.selected.map((s, i) => [s, i] as const);
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [sel, index] = next;
      // After the budget runs out each get() still serves cache hits and throws for the rest.
      let bytes: Uint8Array;
      try {
        bytes = await fetcher.get(sel.url);
      } catch (err) {
        if (err instanceof BudgetExhaustedError) {
          budgetReason ??= err.reason;
          pending.add(sel.url);
        } else {
          fetcher.throwIfAborted();
          issues.push({ url: sel.url, severity: 'error', message: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }
      const tile: TileProvenance = {
        url: sel.url, tilesetUrl: sel.tilesetUrl, tilesetChain: sel.tilesetChain, assetVersion: sel.assetVersion, tilesetVersion: sel.tilesetVersion,
      };
      try {
        const content = await decodeTileContent(bytes, tile, sel.transform, loadDraco);
        for (const w of content.warnings) issues.push({ url: sel.url, severity: 'warning', message: w });
        if (content.unsupported) issues.push({ url: sel.url, severity: 'unsupported', message: content.unsupported });
        decoded[index] = content.features;
        tiles.push({
          ...tile, kind: content.kind, byteLength: bytes.byteLength, featureCount: content.features.length,
          batchLength: content.batchLength, attributeNames: content.attributeNames, rtcCenter: content.rtcCenter,
        });
      } catch (err) {
        fetcher.throwIfAborted();
        issues.push({ url: sel.url, severity: 'error', message: `decode: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  };
  const n = Math.max(1, Math.min(options.concurrency ?? 4, queue.length));
  await Promise.all(Array.from({ length: n }, worker));

  if (budgetReason) truncation = { reason: budgetReason, pendingUrls: [...pending] };
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
      nodesVisited: traversal.nodesVisited,
      tilesetsLoaded: traversal.tilesetsLoaded,
      contentsSelected: traversal.selected.length,
      featuresOutsideRegion,
    },
  };
}
