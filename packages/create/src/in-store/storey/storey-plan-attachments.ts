// SPDX-License-Identifier: MPL-2.0
/** Private plan metadata: keep the public plan and its stale signature stable. */
const targets = new WeakMap<object, ReadonlyMap<number, number>>();
export function recordStoreyPlanAttachments(plan: object, candidates: ReadonlyMap<number, number>): void { targets.set(plan, candidates); }
export function storeyPlanAttachments(plan: object): ReadonlyMap<number, number> | undefined { return targets.get(plan); }
