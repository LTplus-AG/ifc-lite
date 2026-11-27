/* SPDX-License-Identifier: MPL-2.0 */

import { outputRecordId, pruneUpgradeFromSource, removesObsoleteResources } from './schema-converter-unrooted-upgrade.js';
import type { ExportPass } from './step-export-types.js';

/** Finish conversions on the emitted DATA before writing the STEP header. */
export function finishStepConversion(
  pass: ExportPass,
  nextExpressId: number,
  countedRanges: readonly (readonly [start: number, end: number])[],
): number {
  const { entities, enums } = pass;
  const next = enums.typedProperties.finish(entities, pass.ifc4Slots, nextExpressId, enums.structural);
  const varyingStart = entities.length;
  pass.newEntityCount += enums.structural.finishEffectiveVarying(entities);
  if (!removesObsoleteResources(pass.sourceSchema, pass.schema)) {
    enums.forms.dates.finish(entities);
    return next;
  }

  // Count the previously credited additions, including deferred varying records.
  // Repointed source records and typed-property conversions carry no edit count.
  const countedIds = new Set<number>();
  for (const [start, end] of [...countedRanges, [varyingStart, entities.length] as const]) {
    for (let i = start; i < end; i++) countedIds.add(outputRecordId(entities[i]));
  }
  enums.forms.dates.finish(entities);
  pass.warnings.push(...pruneUpgradeFromSource(entities, pass.sourceSchema, pass.schema, (id) => {
    if (countedIds.delete(id)) pass.newEntityCount--;
  }));
  return next;
}
