/* SPDX-License-Identifier: MPL-2.0 */
import type { ConversionLossEntry } from './schema-conversion-loss-report.js';
import { varyingTarget } from './schema-converter-structural-varying.js';
import type { StructuralRoundTrip } from './schema-converter-structural-diagnostics.js';

/**
 * The loss entries of the IFC2X3 varying actions, which the type classifier
 * calls identity: the CausedBy the export reports (`stranded`) and what the
 * constant fallback drops (`constantDropped`, #11354). One entry per source
 * type; records that lose different attributes or are written as different
 * types become record groups, each under the type the export writes it as.
 */
export function varyingLossEntries(varying: readonly (readonly [string, readonly number[]])[], round: StructuralRoundTrip): ConversionLossEntry[] {
  const entries: ConversionLossEntry[] = [];
  for (const [sourceType, ids] of varying) {
    const byGroup = new Map<string, { targetType: string; droppedAttributes: string[]; expressIds: number[] }>();
    for (const id of ids) {
      const stranded = round.stranded.get(id);
      const droppedAttributes = [...(stranded ? ['CausedBy'] : []), ...(round.constantDropped.get(id) ?? [])];
      const targetType = stranded ?? varyingTarget(sourceType);
      if (!targetType || !droppedAttributes.length) continue;
      const key = `${targetType}|${droppedAttributes.join(',')}`;
      const group = byGroup.get(key) ?? { targetType, droppedAttributes, expressIds: [] };
      group.expressIds.push(id);
      byGroup.set(key, group);
    }
    const groups = [...byGroup.values()].map((group) => ({ ...group, count: group.expressIds.length }));
    if (!groups.length) continue;
    const expressIds = groups.flatMap((group) => group.expressIds);
    const droppedAttributes = [...new Set(groups.flatMap((group) => group.droppedAttributes))];
    // Several groups: each names its own target, and the entry keeps the classifier's (the source type).
    const targetType = groups.length > 1 ? sourceType : groups[0].targetType;
    entries.push({ targetType, kind: 'lossy', droppedAttributes, sourceType, count: expressIds.length, expressIds, ...(groups.length > 1 ? { recordGroups: groups } : {}) });
  }
  return entries;
}
