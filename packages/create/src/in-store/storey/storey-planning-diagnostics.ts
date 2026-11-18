// SPDX-License-Identifier: MPL-2.0
/** Internal acceptance instrumentation. Public plans keep their existing shape. */
export interface StoreyPlanningWork {
  readonly inventoryProducts: number;
  readonly detailedProducts: number;
}
const work = new WeakMap<object, StoreyPlanningWork>();
export function recordStoreyPlanningWork(plan: object, value: StoreyPlanningWork): void { work.set(plan, value); }
export function storeyPlanningWork(plan: object): StoreyPlanningWork | undefined { return work.get(plan); }
