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

import { CapabilityDeniedError, hasCapability, parseCapability, type Capability } from '@ifc-lite/extensions';
import type { NodeDef, NodeRunContext } from '@ifc-lite/flow';
import type { BimContext, EntityData, EntityRef as SdkEntityRef } from '@ifc-lite/sdk';
import type { EntityRef } from '@ifc-lite/flow';

export interface FlowHost {
  readonly bim: BimContext;
  /**
   * Capabilities granted to the running graph. `undefined` means "trusted
   * caller, no gate" (the CLI running a local file); the viewer always
   * passes the grants the user accepted.
   */
  readonly grants?: readonly Capability[];
  /** Model to query when a node does not name one. */
  readonly defaultModelId?: string;
}

export type FlowNodeDef = NodeDef<FlowHost>;
export type Ctx = NodeRunContext<FlowHost>;

/** Throws `CapabilityDeniedError` unless the host's grants cover `raw`. */
export function requireCapability(ctx: Ctx, raw: string): void {
  if (!ctx.host.grants) return;
  const parsed = parseCapability(raw);
  if (!parsed.ok) throw new Error(`node requested a malformed capability "${raw}": ${parsed.errors.map((e) => e.message).join('; ')}`);
  if (!hasCapability(ctx.host.grants, parsed.value)) {
    throw new CapabilityDeniedError(`flow node (${raw})`, [raw], ctx.host.grants.map((g) => g.raw));
  }
}

/** Flow handle from an SDK entity: GlobalId is the identity, the address is a cache. */
export function toRef(e: EntityData): EntityRef {
  return { globalId: e.globalId, modelId: e.ref.modelId, expressId: e.ref.expressId };
}

/**
 * GlobalId → address index, built lazily per `BimContext` the first time a
 * handle arrives without a usable address (from a sidecar, a table, another
 * session). The SDK query has no GlobalId lookup, so this is one full scan,
 * then a map. A miss rebuilds once (the entity may have been created during
 * this run) before failing.
 */
const indexes = new WeakMap<BimContext, Map<string, SdkEntityRef>>();

function buildIndex(bim: BimContext): Map<string, SdkEntityRef> {
  const index = new Map<string, SdkEntityRef>();
  for (const e of bim.query().toArray()) index.set(e.globalId, e.ref);
  indexes.set(bim, index);
  return index;
}

export function resolveByGlobalId(bim: BimContext, globalId: string): SdkEntityRef | undefined {
  const index = indexes.get(bim) ?? buildIndex(bim);
  return index.get(globalId) ?? buildIndex(bim).get(globalId);
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

export const ENTITY_ITEM = { kind: 'entity', access: 'item' } as const;
export const ENTITY_LIST = { kind: 'entity', access: 'list' } as const;
export const ENTITY_GROUP = { kind: 'entity', access: 'group' } as const;
export const SCALAR_ITEM = { kind: 'scalar', access: 'item' } as const;
export const SCALAR_LIST = { kind: 'scalar', access: 'list' } as const;
export const TABLE_ITEM = { kind: 'table', access: 'item' } as const;
export const ANY_ITEM = { kind: 'any', access: 'item' } as const;
export const ANY_LIST = { kind: 'any', access: 'list' } as const;
export const ANY_GROUP = { kind: 'any', access: 'group' } as const;
