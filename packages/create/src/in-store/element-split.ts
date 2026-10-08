/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { OrdinaryInStoreElement } from './ordinary-element.js';
import { resolveSplitTarget, type SplitTarget } from './edit/split-target.js';
import { getModelLengthUnitScale } from './edit/length-unit-scale.js';
import { effectiveStoreyId } from './edit/effective-storey.js';
import { readAttributes } from './edit/placement-core.js';
import { deriveSplitGlobalId, globalIdTakenIn, type GlobalIdScope } from './edit/split-guid.js';
import { splitWallDraft, splitLinearDraft } from './element-split-axis.js';
import { splitSlabDraft } from './element-split-slab.js';

export type ElementSplitCut =
  | { readonly kind: 'wall' | 'linear'; readonly distance: number }
  | { readonly kind: 'slab'; readonly a: [number, number]; readonly b: [number, number] };
export interface SplitEnvironment {
  dataStore: IfcDataStore;
  view: MutablePropertyView;
  editor: StoreEditor;
  storeyExpressId: number;
  lengthUnitScale: number;
  newGlobalId: string;
  name: string | undefined;
}
export interface ElementSplitResult {
  readonly sourceId: number;
  readonly addedId: number;
  readonly leftId: number;
  readonly rightId: number;
  readonly storeyId: number;
  readonly element: OrdinaryInStoreElement;
  readonly openings: { toLeft: number; toRight: number; skipped: number };
}
export interface ElementSplitRequest { readonly expressId: number; readonly cut: ElementSplitCut }
export interface ElementSplitOptions {
  /** Include peer source and live overlay views to avoid federation GUID collisions. */
  readonly globalIdScopes?: readonly GlobalIdScope[];
}

/** #6232 D5: the live split predicate and complete writer shared by viewer,
 * SDK and MCP. The larger piece retains identity; a refusal rolls back all
 * helpers, relationship changes, journal entries and allocator state. */
export function splitElementInStore(
  store: IfcDataStore, editor: StoreEditor, expressId: number, cut: ElementSplitCut,
  options: ElementSplitOptions = {},
): ElementSplitResult {
  return splitElementsInStore(store, editor, [{ expressId, cut }], options)[0];
}

/** A selected set is one atomic operation, including late refusal. */
export function splitElementsInStore(
  store: IfcDataStore, editor: StoreEditor, requests: readonly ElementSplitRequest[],
  options: ElementSplitOptions = {},
): ElementSplitResult[] {
  if (requests.length === 0 || requests.length > 10000) throw new Error('Split requires between 1 and 10000 elements');
  if (new Set(requests.map(request => request.expressId)).size !== requests.length) throw new Error('Split targets must be unique');
  return editor.runAtomic(draft => requests.map(({ expressId, cut }) => {
    const view = draft.getMutationView();
    const scale = getModelLengthUnitScale(store);
    const target = resolveSplitTarget(store, view, draft, expressId, scale);
    if (!target.ok) throw new Error(`Split unavailable: ${target.code}`);
    if (target.kind !== cut.kind) throw new Error('Split unavailable: kind');
    const storeyId = effectiveStoreyId(store, view, expressId);
    if (storeyId === undefined) throw new Error('Split unavailable: storey');
    const attrs = readAttributes(store, view, draft, expressId);
    const env: SplitEnvironment = {
      dataStore: store, view, editor: draft, storeyExpressId: storeyId, lengthUnitScale: scale,
      newGlobalId: deriveSplitGlobalId(typeof attrs?.[0] === 'string' ? attrs[0] : String(expressId),
        globalIdTakenIn([{ dataStore: store, view }, ...(options.globalIdScopes ?? [])])),
      name: typeof attrs?.[2] === 'string' ? attrs[2] : undefined,
    };
    return splitDraft(env, expressId, target, cut);
  }));
}

function splitDraft(env: SplitEnvironment, id: number, target: Extract<SplitTarget, { ok: true }>, cut: ElementSplitCut): ElementSplitResult {
  if (target.kind === 'wall' && cut.kind === 'wall') return splitWallDraft(env, id, target.chain, cut.distance);
  if (target.kind === 'linear' && cut.kind === 'linear') return splitLinearDraft(env, id, target.chain, cut.distance);
  if (target.kind === 'slab' && cut.kind === 'slab') return splitSlabDraft(env, id, target.chain, cut.a, cut.b);
  throw new Error('Split unavailable: kind');
}
