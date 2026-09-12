/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AppearanceFaceMask, AppearancePlan } from './planner-types.js';

/**
 * A reviewed face selection for one product of the appearance workspace
 * (#4404). It lives in the session only, bound to the `surfaceFingerprint`
 * the planner reported for the evaluated surface it was drawn on; the IFC
 * output carries the resulting face sets, never the selection itself.
 */
export interface FaceMask {
  readonly productId: number;
  readonly surfaceFingerprint: string;
  /** Ascending, unique source triangle ordinals of the evaluated surface. */
  readonly triangles: Uint32Array;
}
export type FaceMasks = ReadonlyMap<number, FaceMask>;

/** The planner's own stale reason; matched as a prefix so the wording can grow a detail suffix. */
const STALE_REASON = 'Face selection is stale';
const DIRECT_BODY_REASON = 'Face masks currently apply to converted occurrence bodies only';

export function normalizeFaceTriangles(triangles: Iterable<number>, triangleCount: number): Uint32Array {
  const unique = [...new Set(triangles)].filter(ordinal => Number.isSafeInteger(ordinal) && ordinal >= 0 && ordinal < triangleCount).sort((a, b) => a - b);
  return Uint32Array.from(unique);
}

/** Wire masks for the products a request is about to plan; masks of products
 * outside the scope stay in the workspace but never enter the request. */
export function faceMaskRequests(masks: FaceMasks, productIds: readonly number[]): AppearanceFaceMask[] | undefined {
  const scope = new Set(productIds);
  const requests: AppearanceFaceMask[] = [];
  for (const mask of masks.values()) {
    if (!scope.has(mask.productId) || !mask.triangles.length) continue;
    requests.push({ productId: mask.productId, surfaceFingerprint: mask.surfaceFingerprint, triangles: [...mask.triangles] });
  }
  return requests.length ? requests : undefined;
}

export interface FaceMaskReconciliation {
  /** The same map instance when nothing changed, so React state stays stable. */
  masks: FaceMasks;
  /** User-visible diagnostics for every dropped selection. */
  diagnostics: string[];
}

/**
 * Drop every mask the plan proves invalid and say so. The planner reports a
 * changed surface as an explicit stale exclusion, so a placement edit, an
 * opening change or a different tessellation clears the selection instead of
 * reapplying triangle ordinals by position. A product that already carries a
 * direct tessellated Body (after Apply) cannot hold a mask either. Masks whose
 * products are absent from this plan (out of scope) are kept untouched.
 */
export function reconcileFaceMasks(masks: FaceMasks, plan: AppearancePlan, label: (productId: number) => string): FaceMaskReconciliation {
  const diagnostics: string[] = [];
  let next: Map<number, FaceMask> | undefined;
  const drop = (productId: number, message: string) => {
    next ??= new Map(masks);
    next.delete(productId);
    diagnostics.push(message);
  };
  for (const exclusion of plan.exclusions) {
    if (!masks.has(exclusion.productId)) continue;
    if (exclusion.reason.startsWith(STALE_REASON)) {
      drop(exclusion.productId, `Face selection for ${label(exclusion.productId)} is stale: the evaluated surface geometry changed, so the selection was cleared. Select faces again.`);
    } else if (exclusion.reason.startsWith(DIRECT_BODY_REASON)) {
      drop(exclusion.productId, `Face selection for ${label(exclusion.productId)} was cleared: the object now has a direct tessellated Body.`);
    }
  }
  for (const conversion of plan.conversions ?? []) {
    const mask = masks.get(conversion.productId);
    if (mask && conversion.surfaceFingerprint && conversion.surfaceFingerprint !== mask.surfaceFingerprint) {
      drop(conversion.productId, `Face selection for ${label(conversion.productId)} is stale: the evaluated surface geometry changed, so the selection was cleared. Select faces again.`);
    }
  }
  return { masks: next ?? masks, diagnostics };
}
