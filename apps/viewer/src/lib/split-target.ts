/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The ONE answer to "can the Split tool cut this element, and how?" (#6233).
 *
 * The Properties panel's Split button, the canvas click that commits a cut,
 * and the numeric-distance entry all route through {@link resolveSplitTarget}.
 * They used to ask different questions: the button probed the wall reader
 * (which, lacking a type check, also accepted beams and members), the click
 * tried wall → linear → slab and on a miss printed a generic "not a
 * splittable element". So the button could offer a split the commit then
 * refused, and hide one with no explanation.
 *
 * A target is exactly one of three chain kinds, dispatched by IFC class:
 *   - `wall`   — IfcWall / IfcWallStandardCase, rectangle profile, split by
 *                re-authoring two walls (`splitWallAtDistance`).
 *   - `linear` — IfcBeam / IfcColumn / IfcMember, rectangle profile, split by
 *                shrinking the extrusion (`splitLinearElementAtDistance`).
 *   - `slab`   — IfcSlab / IfcRoof / IfcPlate / IfcSpace, rectangle or
 *                polyline profile, split by a cut line (`splitSlabByLine`).
 * Anything else is a {@link SplitUnavailableCode} naming WHY, which the UI
 * shows as the disabled button's tooltip and the tool's error notice.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { TranslationKey } from '@/i18n';
import { asExpressIdRef, readAttributes } from './placement-core.js';
import { resolveWallEditChain, type WallEditChain } from './wall-edit.js';
import { resolveLinearElementChain, type LinearElementEditChain } from './linear-element-edit.js';
import { resolveSlabEditChain, type SlabEditChain } from './slab-edit.js';

export type SplitUnavailableCode =
  /** Not a wall / beam / column / member / slab / roof / plate / space. */
  | 'type'
  /** Not contained in a building storey; the halves need one to live in. */
  | 'storey'
  /** No body representation to cut. */
  | 'noBody'
  /** Triangulated / faceted / B-rep / surface-model body: no profile to cut. */
  | 'mesh'
  /** A mapped (type-instanced) body: cutting it would cut every instance. */
  | 'mapped'
  /** A boolean-clipped body (e.g. a wall clipped under a roof). */
  | 'boolean'
  /** An extrusion, but of a profile the cut math does not handle. */
  | 'profile'
  /** Supported shape family, but its placement / representation layout is not the one the reader walks. */
  | 'shape';

export type SplitTarget =
  | { ok: true; kind: 'wall'; chain: WallEditChain }
  | { ok: true; kind: 'linear'; chain: LinearElementEditChain }
  | { ok: true; kind: 'slab'; chain: SlabEditChain }
  | { ok: false; code: SplitUnavailableCode };

const WALL_TYPES = new Set(['IFCWALL', 'IFCWALLSTANDARDCASE']);
const LINEAR_TYPES = new Set(['IFCBEAM', 'IFCCOLUMN', 'IFCMEMBER']);
const SLAB_TYPES = new Set(['IFCSLAB', 'IFCROOF', 'IFCPLATE', 'IFCSPACE']);

const MESH_ITEMS = new Set([
  'IFCTRIANGULATEDFACESET', 'IFCPOLYGONALFACESET', 'IFCFACETEDBREP', 'IFCFACETEDBREPWITHVOIDS',
  'IFCADVANCEDBREP', 'IFCADVANCEDBREPWITHVOIDS', 'IFCFACEBASEDSURFACEMODEL', 'IFCSHELLBASEDSURFACEMODEL',
]);

/**
 * Classify `expressId` for the Split tool. All lengths on a returned chain
 * are metres (`lengthUnitScale` is the model's native-unit → metre factor).
 */
export function resolveSplitTarget(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  expressId: number,
  lengthUnitScale: number,
): SplitTarget {
  const stepType = editor.getEntityType(expressId)?.toUpperCase();
  if (!stepType) return { ok: false, code: 'type' };
  let target: SplitTarget | null = null;
  if (WALL_TYPES.has(stepType)) {
    const chain = resolveWallEditChain(dataStore, view, editor, expressId, lengthUnitScale);
    if (chain && Number.isFinite(chain.height) && chain.height > 0) target = { ok: true, kind: 'wall', chain };
  } else if (LINEAR_TYPES.has(stepType)) {
    const chain = resolveLinearElementChain(dataStore, view, editor, expressId, lengthUnitScale);
    if (chain) target = { ok: true, kind: 'linear', chain };
  } else if (SLAB_TYPES.has(stepType)) {
    const chain = resolveSlabEditChain(dataStore, view, editor, expressId, lengthUnitScale);
    if (chain) target = { ok: true, kind: 'slab', chain };
  } else {
    return { ok: false, code: 'type' };
  }
  if (!target) {
    return { ok: false, code: diagnoseBody(dataStore, view, editor, expressId, SLAB_TYPES.has(stepType)) };
  }
  // @raw-entity-enumeration-ok point lookup; authored elements are registered into this map (registerAuthoredElement), as the split commit's own storey gate reads it
  if (dataStore.spatialHierarchy?.elementToStorey.get(expressId) === undefined) {
    return { ok: false, code: 'storey' };
  }
  return target;
}

/**
 * Why the chain reader refused a supported class: look at the first item of
 * the first representation — the same slot every chain reader walks. Slab-like
 * readers also take a polyline profile; walls and linear elements only a
 * rectangle.
 */
function diagnoseBody(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  expressId: number,
  polygonProfileOk: boolean,
): SplitUnavailableCode {
  const read = (id: number | null) => (id === null ? null : readAttributes(dataStore, view, editor, id));
  const shape = read(asExpressIdRef(read(expressId)?.[6]));
  const reps = shape?.[2];
  if (!Array.isArray(reps) || reps.length === 0) return 'noBody';
  const items = read(asExpressIdRef(reps[0]))?.[3];
  if (!Array.isArray(items) || items.length === 0) return 'noBody';
  const itemId = asExpressIdRef(items[0]);
  const itemType = itemId === null ? undefined : editor.getEntityType(itemId)?.toUpperCase();
  if (!itemType) return 'noBody';
  if (itemType === 'IFCMAPPEDITEM') return 'mapped';
  if (MESH_ITEMS.has(itemType)) return 'mesh';
  if (itemType === 'IFCBOOLEANCLIPPINGRESULT' || itemType === 'IFCBOOLEANRESULT') return 'boolean';
  if (itemType === 'IFCEXTRUDEDAREASOLID') {
    const profileId = asExpressIdRef(read(itemId)?.[0]);
    const profileType = profileId === null ? undefined : editor.getEntityType(profileId)?.toUpperCase();
    const handled = profileType === 'IFCRECTANGLEPROFILEDEF'
      || (polygonProfileOk && profileType === 'IFCARBITRARYCLOSEDPROFILEDEF');
    if (!handled) return 'profile';
  }
  return 'shape';
}

export interface SplitChains { wall: WallEditChain; linear: LinearElementEditChain; slab: SlabEditChain }

/**
 * A commit action's gate: the chain when `target` is the `kind` that action
 * cuts, else the catalogue key of the refusal — the same reason the Split
 * button's tooltip shows for this element.
 */
export function splitChainOfKind<K extends keyof SplitChains>(
  target: SplitTarget,
  kind: K,
): { chain: SplitChains[K] } | { reasonKey: TranslationKey } {
  if (!target.ok) return { reasonKey: splitUnavailableKey(target.code) };
  if (target.kind !== kind) return { reasonKey: 'splitTool.unavailable.kind' };
  // `kind` matched, so the union member's chain IS `SplitChains[K]`.
  return { chain: target.chain as SplitChains[K] };
}

/** Catalogue key for each {@link SplitUnavailableCode}. */
export function splitUnavailableKey(code: SplitUnavailableCode): TranslationKey {
  switch (code) {
    case 'type': return 'splitTool.unavailable.type';
    case 'storey': return 'splitTool.unavailable.storey';
    case 'noBody': return 'splitTool.unavailable.noBody';
    case 'mesh': return 'splitTool.unavailable.mesh';
    case 'mapped': return 'splitTool.unavailable.mapped';
    case 'boolean': return 'splitTool.unavailable.boolean';
    case 'profile': return 'splitTool.unavailable.profile';
    case 'shape': return 'splitTool.unavailable.shape';
  }
}
