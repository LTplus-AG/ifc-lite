/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The host services every standard node receives, and the capability gate.
 *
 * Nodes run on the host (viewer or CLI) as trusted code, so the gate is
 * not a sandbox: it is the same grant check the extension runtime applies
 * (`hasCapability` over the extension grammar), evaluated with the node's
 * *actual* target — `model.mutate:Pset_WallCommon` is checked against the
 * pset the node is about to write, which `assertMethodCall` cannot do
 * because it never sees arguments.
 */

import type { Capability } from '@ifc-lite/extensions';
import type { FetchTransport } from '@ifc-lite/sandbox';
import type { NodeDef, NodeRunContext } from '@ifc-lite/flow';
import type { BimContext, EntityData, EntityRef as SdkEntityRef } from '@ifc-lite/sdk';
import type { EntityRef } from '@ifc-lite/flow';
import type { EntityTable } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { SessionAutomationHost } from './session-contracts.js';
import type { BcfWriteGateway } from './bcf-write-gateway.js';
import type { FlowAiService } from './ai-service.js';

/** A string-interning lookup, the shape `csv-match.ts`'s match-context builder
 *  needs for `globalId`/`name` strategies (an entity table's `name`/`globalId`
 *  columns are interned string indices, not inline strings). */
export type StringLookup = { get(idx: number): string } | null;

/**
 * Bulk entity access for `table.joinByKey`'s `tag`/`property` strategies,
 * which reuse `@ifc-lite/mutations`' `csv-match.ts` index builder verbatim
 * (issue #5230) instead of re-implementing tag/property matching. That
 * builder scans a whole `EntityTable` once (`O(entities + rows)`) rather than
 * once per candidate entity, so it needs the raw table, not `BimContext`'s
 * per-`EntityRef` accessors.
 *
 * Optional on `FlowHost`: a host that cannot cheaply provide this (nothing
 * today besides the CLI's `HeadlessBackend`) simply cannot run those two
 * match strategies, and `table.joinByKey` reports that plainly rather than
 * falling back to a slow re-implementation.
 */
export interface TableAccess {
  readonly entities: EntityTable;
  readonly mutationView: MutablePropertyView;
  readonly strings: StringLookup;
}

export interface FlowHost {
  /**
   * The host's AI model service for `ai.*` nodes (`@ifc-lite/flow-nodes/ai`).
   * The host owns the provider, credentials, the run's root budget and its
   * receipts; a host that offers it lists the `ai` backend feature.
   */
  readonly ai?: FlowAiService;
  readonly automation?: SessionAutomationHost;
  readonly bim: BimContext;
  /**
   * Capabilities granted to the running graph. `undefined` means "trusted
   * caller, no gate" (the CLI running a local file); the viewer always
   * passes the grants the user accepted.
   */
  readonly grants?: readonly Capability[];
  /**
   * The graph's own declared `network.ai`, `network.fetch:<host>` and `secret.read:<NAME>`
   * capabilities — ALWAYS populated by every caller (CLI, MCP, viewer),
   * independent of `grants`/the trust gate above. Real network access and
   * secret reads are the one place "trusted local caller" does not mean
   * "unrestricted": a request still needs the graph to have written down
   * which host it may reach, so `HttpRequest` (and `bim.network.fetch` in
   * the sandbox) always check the actual host against this list rather
   * than relying on `grants` being undefined to skip the check entirely.
   */
  readonly networkGrants?: readonly Capability[];
  /**
   * Transport for `http.request`; `fetch` when absent. Only changes how bytes
   * move — the grant check against `networkGrants` always runs first.
   */
  readonly networkTransport?: FetchTransport;
  /**
   * Durable path for `bcf.*` writes (see `bcf-write-gateway.ts`). A host
   * that supplies it records each write's intent and receipt and refuses to
   * resend one with an unknown outcome; without it, writes go straight to
   * the server and an unknown outcome is reported, never retried.
   */
  readonly bcfWrites?: BcfWriteGateway;
  /** Model to query when a node does not name one. */
  readonly defaultModelId?: string;
  /** See {@link TableAccess}. `modelId` defaults to `defaultModelId`. */
  tables?(modelId?: string): TableAccess | undefined;
  /**
   * Open `bytes` (an IFC file named `name`) as a model through the host's
   * own load path, resolving to the id the loaded model answers to in
   * `bim`. Backs `model.openFromSource`; a host that can do this lists the
   * `openModel` backend feature. The viewer adds the model to the
   * federation; a headless host (one model per `BimContext`) makes it the
   * model `bim` and `defaultModelId` answer for from then on.
   */
  openModel?(bytes: Uint8Array, name: string): Promise<{ readonly modelId: string }>;
}

export type FlowNodeDef = NodeDef<FlowHost>;
export type Ctx = NodeRunContext<FlowHost>;

export { requireCapability } from './capability.js';

/** Flow handle from an SDK entity: GlobalId is the identity, the address is a cache. */
export function toRef(e: EntityData): EntityRef {
  return { globalId: e.globalId, modelId: e.ref.modelId, expressId: e.ref.expressId };
}

/**
 * GlobalId → address index, built lazily per `BimContext` with one full
 * scan the first time a handle arrives without a usable address (from a
 * sidecar, a table, another session). The SDK query has no GlobalId lookup.
 * A miss is *not* a rebuild trigger — a tracked create node asks for every
 * GlobalId it is about to mint, and each of those misses is expected —
 * so creators register what they add with `rememberGlobalId`, and hosts
 * call `invalidateGlobalIdIndex` when a model is loaded or removed.
 */
const indexes = new WeakMap<BimContext, Map<string, SdkEntityRef>>();

function indexFor(bim: BimContext): Map<string, SdkEntityRef> {
  let index = indexes.get(bim);
  if (!index) {
    index = new Map();
    for (const e of bim.query().toArray()) index.set(e.globalId, e.ref);
    indexes.set(bim, index);
  }
  return index;
}

export function resolveByGlobalId(bim: BimContext, globalId: string): SdkEntityRef | undefined {
  return indexFor(bim).get(globalId);
}

export function rememberGlobalId(bim: BimContext, globalId: string, ref: SdkEntityRef): void {
  indexFor(bim).set(globalId, ref);
}

export function forgetGlobalId(bim: BimContext, globalId: string): void {
  indexes.get(bim)?.delete(globalId);
}

export function invalidateGlobalIdIndex(bim: BimContext): void {
  indexes.delete(bim);
}

/**
 * Resolve a flow handle to an SDK address. A handle whose address is
 * present and still names the same GlobalId is used as is; anything else
 * goes through the GlobalId index.
 */
export function toSdkRef(ctx: Ctx, ref: EntityRef): SdkEntityRef {
  if (ref.modelId !== undefined && ref.expressId !== undefined) {
    const addr = { modelId: ref.modelId, expressId: ref.expressId };
    const live = ctx.host.bim.entity(addr);
    if (live && live.globalId === ref.globalId) return addr;
  }
  const found = resolveByGlobalId(ctx.host.bim, ref.globalId);
  if (!found) throw new Error(`entity ${ref.globalId} is not in any loaded model`);
  return found;
}

export function entityOf(ctx: Ctx, ref: EntityRef): EntityData {
  const data = ctx.host.bim.entity(toSdkRef(ctx, ref));
  if (!data) throw new Error(`entity ${ref.globalId} is not in any loaded model`);
  return data;
}

export { ENTITY_ITEM, ENTITY_LIST, ENTITY_GROUP, SCALAR_ITEM, SCALAR_LIST, TABLE_ITEM, ANY_ITEM, ANY_LIST, ANY_GROUP } from './ports.js';
