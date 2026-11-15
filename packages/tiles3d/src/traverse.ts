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
import { limit, type ReaderIssueCode } from './limits.js';
import { UrlPolicyError } from './url-policy.js';
import { detectContentKind } from './content/decode.js';

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
  /** Where a tileset found at this URL by its content would hang. */
  parent: TilesetParent;
  /** Bytes already fetched during traversal (a `.json` URI that held tile content, not a tileset). */
  bytes?: Uint8Array;
}

export interface ReaderIssue {
  url: string;
  /** `error`: a request or decode failed; `unsupported`: recognised but not read; `warning`: read with a caveat. */
  severity: 'error' | 'unsupported' | 'warning';
  message: string;
  /** Machine-readable reason for refused input: limits, malformed content, the URL policy, missing columns. */
  code?: ReaderIssueCode;
}

/** Set when a budget stopped the query early. */
export interface Truncation {
  /** `decoded`: the decoded vertex/index limits (`maxVerticesPerContent`, `maxDecodedVertices`, ...). */
  reason: 'requests' | 'bytes' | 'nodes' | 'decoded';
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
  /** Bound on tile depth across external tilesets; deeper subtrees are skipped with a `limit` issue. Default 256. */
  maxDepth?: number;
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

/**
 * Resolve a content URI against its tileset URL and carry the parent's query
 * parameters, as CesiumJS does (`Resource.getDerivedResource` with
 * `preserveQueryParameters: false`): the child's own parameters win, parent
 * parameters the child lacks are appended. Unlike CesiumJS, parameters are
 * carried only to a URL on the parent's origin, so an API key in the root URL
 * never reaches a third-party host. Raw parameter text is kept as written.
 */
export function resolveUri(uri: string, base: string): string {
  const resolved = new URL(uri, base);
  const baseUrl = new URL(base);
  if (!baseUrl.search || resolved.origin !== baseUrl.origin) return resolved.href;
  const childKeys = new Set(resolved.searchParams.keys());
  const extra = baseUrl.search.slice(1).split('&').filter((pair) => {
    if (!pair) return false;
    const key = new URLSearchParams(pair).keys().next().value;
    return key !== undefined && !childKeys.has(key);
  });
  if (extra.length === 0) return resolved.href;
  resolved.search = resolved.search ? `${resolved.search.slice(1)}&${extra.join('&')}` : extra.join('&');
  return resolved.href;
}

function contentUri(c: ContentJson): string | undefined {
  const uri = c.uri ?? c.url;
  return typeof uri === 'string' && uri.length > 0 ? uri : undefined;
}

function isTilesetUri(url: string): boolean {
  return new URL(url).pathname.toLowerCase().endsWith('.json');
}

export function parseTilesetJson(bytes: Uint8Array, url: string): TilesetJson {
  const json = JSON.parse(decodeUtf8(bytes)) as TilesetJson;
  if (!json || typeof json !== 'object' || !json.root || typeof json.root !== 'object' || !json.asset || typeof json.asset !== 'object') {
    throw new Error(`${url} is not a 3D Tiles tileset (missing asset or root)`);
  }
  if (typeof json.asset.version !== 'string') throw new Error(`${url} has no asset.version string`);
  return json;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Where an external tileset hangs in the combined tree. */
export interface TilesetParent {
  chain: string[];
  tilesetVersion?: string;
  transform: Mat4;
  depth: number;
  refine: 'ADD' | 'REPLACE';
}

/**
 * Incremental traversal. `run()` drains the work stack and returns the
 * contents it selected; `addExternalTileset()` adds a tileset found by content
 * (a child URI whose bytes turned out to be tileset JSON), and the next
 * `run()` continues there. Node, depth and request budgets span the whole query.
 */
export class Traverser {
  readonly issues: ReaderIssue[] = [];
  readonly pending = new Set<string>();
  truncationReason: Truncation['reason'] | undefined;
  nodesVisited = 0;
  tilesetsLoaded = 0;
  private readonly stack: WorkItem[] = [];
  private readonly target: number;
  private readonly maxNodes: number;
  private readonly maxDepth: number;
  private georefChecked = false;

  constructor(private readonly fetcher: BudgetedFetcher, private readonly query: PreparedRegion, options: TraversalOptions = {}) {
    this.target = limit(options.maxGeometricError, 0, 'maxGeometricError');
    this.maxNodes = limit(options.maxNodes, 1_000_000, 'maxNodes');
    this.maxDepth = limit(options.maxDepth, 256, 'maxDepth');
  }

  /** Load the root tileset; a failure here is not a partial result and throws. */
  async loadRoot(url: string): Promise<void> {
    const ts = parseTilesetJson(await this.fetcher.get(url), url);
    this.push(ts, url, { chain: [], transform: IDENTITY, depth: 0, refine: 'REPLACE' });
  }

  /** Add an external tileset whose bytes were already fetched; malformed JSON or a cycle becomes an issue. */
  addExternalTileset(url: string, bytes: Uint8Array, parent: TilesetParent): void {
    if (parent.chain.includes(url)) {
      this.issues.push({ url, severity: 'error', message: `external tileset cycle via ${parent.chain[parent.chain.length - 1]}` });
      return;
    }
    try {
      this.push(parseTilesetJson(bytes, url), url, parent);
    } catch (err) {
      this.issues.push({ url, severity: 'error', message: `external tileset: ${message(err)}`, code: 'invalid-content' });
    }
  }

  private push(ts: TilesetJson, url: string, parent: TilesetParent): void {
    this.tilesetsLoaded++;
    const required = Array.isArray(ts.extensionsRequired) ? ts.extensionsRequired : [];
    for (const ext of required) this.issues.push({ url, severity: 'unsupported', message: `tileset requires extension ${String(ext)}` });
    const ctx: TilesetCtx = { url, chain: [...parent.chain, url], assetVersion: ts.asset.version, tilesetVersion: ts.asset.tilesetVersion ?? parent.tilesetVersion };
    this.stack.push({ tile: ts.root, ctx, parent: parent.transform, refine: parent.refine, depth: parent.depth });
  }

  /** Drain the stack; returns the contents selected by this call. */
  async run(): Promise<SelectedContent[]> {
    const selected: SelectedContent[] = [];
    while (this.stack.length > 0) {
      this.fetcher.throwIfAborted();
      const item = this.stack.pop()!;
      const { tile, ctx } = item;
      if (!isObject(tile) || !isObject(tile.boundingVolume) || typeof tile.geometricError !== 'number' || !(tile.geometricError >= 0)) {
        this.issues.push({ url: ctx.url, severity: 'error', message: 'tile without a boundingVolume object or a non-negative geometricError; subtree skipped', code: 'invalid-content' });
        continue;
      }
      if (this.nodesVisited >= this.maxNodes) {
        this.truncationReason ??= 'nodes';
        // The tile was never visited: what it would have fetched is its own content (its children are unknown).
        for (const c of tileContents(tile)) {
          const uri = contentUri(c);
          if (uri) this.pending.add(resolveUri(uri, ctx.url));
        }
        continue;
      }
      if (item.depth > this.maxDepth) {
        this.issues.push({ url: ctx.url, severity: 'error', message: `tile depth ${item.depth} exceeds maxDepth ${this.maxDepth}; subtree skipped`, code: 'limit' });
        continue;
      }
      this.nodesVisited++;
      await this.visit(item, selected);
    }
    return selected;
  }

  private async visit(item: WorkItem, selected: SelectedContent[]): Promise<void> {
    const { tile, ctx } = item;
    const issues = this.issues;
    const toRoot = Array.isArray(tile.transform) && tile.transform.length === 16 ? multiply(item.parent, tile.transform) : item.parent;
    const refine: 'ADD' | 'REPLACE' = tile.refine === 'ADD' || tile.refine === 'REPLACE' ? tile.refine : item.refine;
    if (tile.refine !== undefined && tile.refine !== 'ADD' && tile.refine !== 'REPLACE') {
      issues.push({ url: ctx.url, severity: 'warning', message: `unknown refine "${String(tile.refine)}", inherited ${item.refine}` });
    }

    if (!this.georefChecked) {
      this.georefChecked = true;
      const bv = tile.boundingVolume;
      const c = bv.box ?? bv.sphere;
      if (!bv.region && Array.isArray(c) && c.length >= 3) {
        const [x, y, z] = transformPoint(toRoot, c[0], c[1], c[2]);
        if (Math.hypot(x, y, z) < 6_000_000) {
          issues.push({ url: ctx.url, severity: 'warning', message: 'root bounding volume is not near the WGS84 ellipsoid: the tileset may not be georeferenced (culling assumes an ECEF root frame)' });
        }
      }
    }

    const hit = volumeIntersects(this.query, tile.boundingVolume, toRoot);
    if (hit === undefined) {
      issues.push({ url: ctx.url, severity: 'unsupported', message: 'tile bounding volume has no region, box or sphere; kept without culling' });
    } else if (!hit) {
      return;
    }
    if (tile.implicitTiling) {
      issues.push({ url: ctx.url, severity: 'unsupported', message: 'implicit tiling (3D Tiles 1.1 implicitTiling) is not supported; subtree skipped' });
      return;
    }

    const scale = ctx.assetVersion.startsWith('1.0') ? 1 : maxScale(toRoot);
    const error = tile.geometricError * scale;
    const children = Array.isArray(tile.children) ? tile.children : [];
    const refineFurther = children.length > 0 && error > this.target;
    const wantContent = refine === 'ADD' || !refineFurther;

    if (wantContent) {
      for (const c of tileContents(tile)) {
        const uri = contentUri(c);
        if (!uri) continue;
        if (isObject(c.boundingVolume) && volumeIntersects(this.query, c.boundingVolume, toRoot) === false) continue;
        const url = this.childUrl(uri, ctx.url);
        if (url === undefined) continue;
        const parent: TilesetParent = { chain: ctx.chain, tilesetVersion: ctx.tilesetVersion, transform: toRoot, depth: item.depth + 1, refine };
        const sel: SelectedContent = {
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
          parent,
        };
        // A `.json` child is fetched now and followed when it is tileset JSON; any other
        // URI is selected as content and recognised as a tileset by its bytes later.
        if (!isTilesetUri(url)) {
          selected.push(sel);
          continue;
        }
        if (ctx.chain.includes(url)) {
          issues.push({ url, severity: 'error', message: `external tileset cycle via ${ctx.url}` });
          continue;
        }
        if (this.truncationReason) {
          this.pending.add(url);
          continue;
        }
        try {
          const bytes = await this.fetcher.get(url);
          if (detectContentKind(bytes) === 'tileset') this.addExternalTileset(url, bytes, parent);
          else selected.push({ ...sel, bytes });
        } catch (err) {
          if (err instanceof BudgetExhaustedError) {
            this.truncationReason = err.reason;
            this.pending.add(url);
          } else {
            this.fetcher.throwIfAborted();
            issues.push({ url, severity: 'error', message: `external tileset: ${message(err)}`, code: err instanceof UrlPolicyError ? 'url-policy' : undefined });
          }
        }
      }
    }
    if (refineFurther) {
      for (let i = children.length - 1; i >= 0; i--) {
        this.stack.push({ tile: children[i], ctx, parent: toRoot, refine, depth: item.depth + 1 });
      }
    }
  }

  /** Resolve a child URI and apply the URL policy; a refusal or an unparsable URI becomes an issue. */
  private childUrl(uri: string, base: string): string | undefined {
    let url: string;
    try {
      url = resolveUri(uri, base);
    } catch (err) {
      this.issues.push({ url: base, severity: 'error', message: `child URI ${JSON.stringify(uri)} cannot be resolved: ${message(err)}`, code: 'invalid-content' });
      return undefined;
    }
    try {
      this.fetcher.policy?.check(url);
    } catch (err) {
      this.issues.push({ url, severity: 'error', message: message(err), code: err instanceof UrlPolicyError ? 'url-policy' : 'invalid-content' });
      return undefined;
    }
    return url;
  }

  truncation(): Truncation | undefined {
    return this.truncationReason ? { reason: this.truncationReason, pendingUrls: [...this.pending] } : undefined;
  }
}

function tileContents(tile: TileJson): ContentJson[] {
  const list = Array.isArray(tile.contents) ? tile.contents : isObject(tile.content) ? [tile.content] : [];
  return list.filter(isObject) as ContentJson[];
}

/** Traverse a whole tileset (following `.json` external tilesets) and return its selection. */
export async function traverseTileset(
  fetcher: BudgetedFetcher,
  rootUrl: string,
  query: PreparedRegion,
  options: TraversalOptions = {},
): Promise<TraversalResult> {
  const t = new Traverser(fetcher, query, options);
  await t.loadRoot(rootUrl);
  const selected = await t.run();
  return { selected, issues: t.issues, truncation: t.truncation(), nodesVisited: t.nodesVisited, tilesetsLoaded: t.tilesetsLoaded };
}
