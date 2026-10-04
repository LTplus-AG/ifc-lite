/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Task OUTPUT products — IfcRelAssignsToProduct with an IfcTask in
 * RelatedObjects and the product it builds in RelatingProduct (#6749).
 *
 * buildingSMART's construction-scheduling examples bind every task to its
 * product this way; IfcRelAssignsToProcess (the task in RelatingProcess)
 * binds the task's INPUTS instead. The extractor keeps the two lists apart
 * so a round trip writes each assignment back as the relationship it came
 * from, and every consumer that just wants "the products this task touches"
 * reads the union through {@link taskProductExpressIds}.
 */

import type { CostEntityReader } from './cost-reader.js';
import { asRef, asRefList } from './schedule-types.js';
import type { ScheduleTaskInfo } from './schedule-types.js';

/** IfcRelAssignsToProduct STEP attribute indices (same in IFC2X3, IFC4, IFC4X3). */
export const REL_ASSIGNS_TO_PRODUCT_ATTR = {
  RelatedObjects: 4,
  RelatingProduct: 6,
} as const;

/**
 * Fill `outputProductExpressIds` / `outputProductGlobalIds` on every task
 * named in an IfcRelAssignsToProduct's RelatedObjects. Relations whose
 * RelatedObjects hold no task (cost items pricing a product, resources) are
 * skipped untouched.
 *
 * Deduped per task, unlike the IfcRelAssignsToProcess inputs:
 * IfcRelAssignsToProduct carries no quantity attribute, so a repeated
 * (task, product) pair is the same identity edge stated twice.
 */
export function assignTaskOutputProducts(
  reader: CostEntityReader,
  relIds: readonly number[],
  taskByExpressId: ReadonlyMap<number, ScheduleTaskInfo>,
  globalIdByExpressId: Map<number, string>,
): void {
  for (const relId of relIds) {
    const entity = reader.get(relId);
    if (!entity) continue;
    const a = entity.attributes || [];
    const productId = asRef(a[REL_ASSIGNS_TO_PRODUCT_ATTR.RelatingProduct]);
    if (productId === undefined) continue;
    let gid: string | undefined;
    let resolved = false;
    for (const relatedId of asRefList(a[REL_ASSIGNS_TO_PRODUCT_ATTR.RelatedObjects])) {
      const task = taskByExpressId.get(relatedId);
      if (!task) continue;
      if (!resolved) {
        // Resolve the effective product GlobalId and skip tombstoned
        // records, exactly as the IfcRelAssignsToProcess pass does.
        gid = reader.get(productId) ? reader.globalId(productId) : undefined;
        if (gid) globalIdByExpressId.set(productId, gid);
        resolved = true;
      }
      const expressIds = (task.outputProductExpressIds ??= []);
      const globalIds = (task.outputProductGlobalIds ??= []);
      if (expressIds.includes(productId)) continue;
      expressIds.push(productId);
      globalIds.push(gid ?? '');
    }
  }
}

/**
 * Every product a task touches: its IfcRelAssignsToProcess inputs followed by
 * its IfcRelAssignsToProduct outputs. Returns the input array itself when
 * there are no outputs, so per-frame callers (the 4D animator) don't allocate.
 */
export function taskProductExpressIds(
  task: Pick<ScheduleTaskInfo, 'productExpressIds' | 'outputProductExpressIds'>,
): readonly number[] {
  const outputs = task.outputProductExpressIds;
  return outputs?.length ? [...task.productExpressIds, ...outputs] : task.productExpressIds;
}

/** GlobalIds aligned with {@link taskProductExpressIds} by index. */
export function taskProductGlobalIds(
  task: Pick<ScheduleTaskInfo, 'productGlobalIds' | 'outputProductGlobalIds'>,
): readonly string[] {
  const outputs = task.outputProductGlobalIds;
  return outputs?.length ? [...task.productGlobalIds, ...outputs] : task.productGlobalIds;
}
