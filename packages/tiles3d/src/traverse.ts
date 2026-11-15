/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tileset traversal: load a root tileset, follow external tilesets, cull by
 * bounding volume against a WGS84 region, and select the tile contents that a
 * region query at a given geometric error needs.
 */

import { BudgetExhaustedError, type BudgetedFetcher } from './fetcher.js';
import { IDENTITY, type Mat4, maxScale, multiply, transformPoint } from './matrix.js';
import type { BoundingVolumeJson, ContentJson, TileJson, TilesetJson } from './tileset-types.js';
import { type PreparedRegion, volumeIntersects } from './volume.js';
import { decodeUtf8 } from './bytes.js';

/** Where a selected content came from. */
export interface TileProvenance {
  /** Absolute content URL. */
  url: string;
  /** Tileset JSON that references the content. */
  tilesetUrl: string;
  /** Tileset JSON URLs from the root down to `tilesetUrl` (external tileset chain). */
  tilesetChain: string[];
  /** `asset.version` of the referencing tileset ("1.0", "1.1"). */
  assetVersion: string;
  /** `asset.tilesetVersion`, inherited from parents unless an external tileset overrides it. */
  tilesetVersion?: string;
}

export interface SelectedContent extends TileProvenance {
  /** Composed tile transform, tile frame -> tileset root frame (column-major). */
  transform: number[];
  geometricError: number;
  refine: 'ADD' | 'REPLACE';
  /** Depth in the combined tree (external roots continue their parent's depth). */
  depth: number;
  boundingVolume: BoundingVolumeJson;
}

export interface ReaderIssue {
  url: string;
  /** `error`: a request or decode failed; `unsupported`: recognised but not read; `warning`: read with a caveat. */
  severity: 'error' | 'unsupported' | 'warning';
  message: string;
}

/** Set when the request budget (or the node budget) stopped the query early. */
export interface Truncation {
  reason: 'requests' | 'bytes' | 'nodes';
  /** URLs (external tilesets or contents) that were selected but not fetched. */
  pendingUrls: string[];
}

export interface TraversalResult {
  selected: SelectedContent[];
  issues: ReaderIssue[];
  truncation?: Truncation;
  /** Tile nodes visited (after following external tilesets). */
  nodesVisited: number;
  tilesetsLoaded: number;
}

export interface TraversalOptions {
  /**
   * Target geometric error in metres. Refinement descends while a tile's
   * geometric error exceeds it. Default 0: all the way to the leaves, which for
   * ADD refinement collects every intersecting content and for REPLACE selects
   * the finest level.
   */
  maxGeometricError?: number;
  /** Bound on visited tile nodes across all tilesets; default 1,000,000. */
  maxNodes?: number;
}

interface TilesetCtx {
  url: string;
  chain: string[];
  assetVersion: string;
  tilesetVersion?: string;
}

interface WorkItem {
  tile: TileJson;
  ctx: TilesetCtx;
  parent: Mat4;
  refine: 'ADD' | 'REPLACE';
  depth: number;
}

/** Resolve a content URI against its tileset URL, carrying the parent's query string to relative URIs without one. */
export function resolveUri(uri: string, base: string): string {
  const resolved = new URL(uri, base);
  const baseUrl = new URL(base);
  const isRelative = !/^[a-z][a-z0-9+.-]*:/i.test(uri) && !uri.startsWith('//');
  if (isRelative && !resolved.search && baseUrl.search) resolved.search = baseUrl.search;
  return resolved.href;
}

function contentUri(c: ContentJson): string | undefined {
  return c.uri ?? c.url;
}

function isTilesetUri(url: string): boolean {
  return new URL(url).pathname.toLowerCase().endsWith('.json');
}

export function parseTilesetJson(bytes: Uint8Array, url: string): TilesetJson {
  const json = JSON.parse(decodeUtf8(bytes)) as TilesetJson;
  if (!json || typeof json !== 'object' || !json.root || !json.asset) {
    throw new Error(`${url} is not a 3D Tiles tileset (missing asset or root)`);
  }
  return json;
}

async function loadTileset(fetcher: BudgetedFetcher, url: string): Promise<TilesetJson> {
  return parseTilesetJson(await fetcher.get(url), url);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function traverseTileset(
  fetcher: BudgetedFetcher,
  rootUrl: string,
  query: PreparedRegion,
  options: TraversalOptions = {},
): Promise<TraversalResult> {
  const target = options.maxGeometricError ?? 0;
  const maxNodes = options.maxNodes ?? 1_000_000;
  const selected: SelectedContent[] = [];
  const issues: ReaderIssue[] = [];
  const pending = new Set<string>();
  let truncationReason: Truncation['reason'] | undefined;
  let nodesVisited = 0;
  let tilesetsLoaded = 0;
  const stack: WorkItem[] = [];

  const pushTileset = (ts: TilesetJson, ctx: TilesetCtx, parent: Mat4, depth: number, refine: 'ADD' | 'REPLACE'): void => {
    tilesetsLoaded++;
    for (const ext of ts.extensionsRequired ?? []) {
      issues.push({ url: ctx.url, severity: 'unsupported', message: `tileset requires extension ${ext}` });
    }
    stack.push({ tile: ts.root, ctx, parent, refine, depth });
  };

  // The root tileset failing to load is not a partial result: let it throw.
  const rootTs = await loadTileset(fetcher, rootUrl);
  pushTileset(rootTs, { url: rootUrl, chain: [rootUrl], assetVersion: rootTs.asset.version, tilesetVersion: rootTs.asset.tilesetVersion }, IDENTITY, 0, 'REPLACE');
  let georefChecked = false;

  while (stack.length > 0) {
    fetcher.throwIfAborted();
    const item = stack.pop()!;
    const { tile, ctx } = item;
    if (nodesVisited >= maxNodes) {
      truncationReason ??= 'nodes';
      pending.add(ctx.url);
      continue;
    }
    nodesVisited++;
    const toRoot = tile.transform && tile.transform.length === 16 ? multiply(item.parent, tile.transform) : item.parent;
    const refine: 'ADD' | 'REPLACE' = tile.refine === 'ADD' || tile.refine === 'REPLACE' ? tile.refine : item.refine;
    if (tile.refine !== undefined && tile.refine !== 'ADD' && tile.refine !== 'REPLACE') {
      issues.push({ url: ctx.url, severity: 'warning', message: `unknown refine "${tile.refine}", inherited ${item.refine}` });
    }

    if (!georefChecked) {
      georefChecked = true;
      const bv = tile.boundingVolume;
      const c = bv.box ?? bv.sphere;
      if (!bv.region && c) {
        const [x, y, z] = transformPoint(toRoot, c[0], c[1], c[2]);
        if (Math.hypot(x, y, z) < 6_000_000) {
          issues.push({ url: ctx.url, severity: 'warning', message: 'root bounding volume is not near the WGS84 ellipsoid: the tileset may not be georeferenced (culling assumes an ECEF root frame)' });
        }
      }
    }

    const hit = volumeIntersects(query, tile.boundingVolume, toRoot);
    if (hit === undefined) {
      issues.push({ url: ctx.url, severity: 'unsupported', message: 'tile bounding volume has no region, box or sphere; kept without culling' });
    } else if (!hit) {
      continue;
    }
    if (tile.implicitTiling) {
      issues.push({ url: ctx.url, severity: 'unsupported', message: 'implicit tiling (3D Tiles 1.1 implicitTiling) is not supported; subtree skipped' });
      continue;
    }

    const scale = ctx.assetVersion.startsWith('1.0') ? 1 : maxScale(toRoot);
    const error = tile.geometricError * scale;
    const children = tile.children ?? [];
    const refineFurther = children.length > 0 && error > target;
    const wantContent = refine === 'ADD' || !refineFurther;

    if (wantContent) {
      const contents = tile.contents ?? (tile.content ? [tile.content] : []);
      for (const c of contents) {
        const uri = contentUri(c);
        if (!uri) continue;
        if (c.boundingVolume && volumeIntersects(query, c.boundingVolume, toRoot) === false) continue;
        const url = resolveUri(uri, ctx.url);
        if (isTilesetUri(url)) {
          if (ctx.chain.includes(url)) {
            issues.push({ url, severity: 'error', message: `external tileset cycle via ${ctx.url}` });
            continue;
          }
          if (truncationReason) {
            pending.add(url);
            continue;
          }
          try {
            const ext = await loadTileset(fetcher, url);
            pushTileset(ext, { url, chain: [...ctx.chain, url], assetVersion: ext.asset.version, tilesetVersion: ext.asset.tilesetVersion ?? ctx.tilesetVersion }, toRoot, item.depth + 1, refine);
          } catch (err) {
            if (err instanceof BudgetExhaustedError) {
              truncationReason = err.reason;
              pending.add(url);
            } else {
              fetcher.throwIfAborted();
              issues.push({ url, severity: 'error', message: `external tileset: ${message(err)}` });
            }
          }
          continue;
        }
        selected.push({
          url,
          tilesetUrl: ctx.url,
          tilesetChain: ctx.chain,
          assetVersion: ctx.assetVersion,
          tilesetVersion: ctx.tilesetVersion,
          transform: [...toRoot],
          geometricError: tile.geometricError,
          refine,
          depth: item.depth,
          boundingVolume: c.boundingVolume ?? tile.boundingVolume,
        });
      }
    }
    if (refineFurther) {
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ tile: children[i], ctx, parent: toRoot, refine, depth: item.depth + 1 });
      }
    }
  }

  return {
    selected,
    issues,
    truncation: truncationReason ? { reason: truncationReason, pendingUrls: [...pending] } : undefined,
    nodesVisited,
    tilesetsLoaded,
  };
}
