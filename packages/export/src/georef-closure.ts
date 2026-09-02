/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rescue `IFCMAPCONVERSION` (+ its `IFCPROJECTEDCRS`) into a STEP export
 * closure that otherwise never reaches it.
 *
 * Split out of `reference-collector.ts` (which already sits at its module
 * size budget) rather than grown in place — see that file's own closure-walk
 * functions (`collectReferencedEntityIds`, `collectStyleEntities`) for the
 * KEY DESIGN this shares: `IfcMapConversion.SourceCRS` points AT the
 * `IfcGeometricRepresentationContext` it converts; nothing points the other
 * way. The context is always a closure root (`INFRASTRUCTURE_TYPES`), but a
 * forward-only closure walk from it never reaches `IfcMapConversion` — so
 * every `visibleOnly` / `subsetEntityIds` STEP export of a georeferenced
 * model silently dropped its `IfcMapConversion`/`IfcProjectedCRS` (grid
 * alignment, EPSG code, vertical datum), and the next tool that opens the
 * export sees an un-georeferenced model at the local origin.
 */

import type { IfcSourceBytes } from '@ifc-lite/parser';
import { collectRefsInByteRange } from './reference-collector.js';

/**
 * Collect `IFCMAPCONVERSION` (and, transitively, the `IFCPROJECTEDCRS` it
 * names) when the closure already contains the `IFCGEOMETRICREPRESENTATIONCONTEXT`
 * it converts.
 *
 * Must be called AFTER `collectReferencedEntityIds` (and, if used,
 * `collectStyleEntities`) so the context is already in the closure. Same
 * reverse-pass shape as `collectStyleEntities` (nothing references a styled
 * item back either), just against `IFCMAPCONVERSION`.
 *
 * `excludeIds` (e.g. `pass.hiddenProductIds` / a subset export's
 * `excludedIds`) is honoured the same way `collectReferencedEntityIds`
 * honours it: an excluded `IfcMapConversion`/`IfcProjectedCRS` — for instance
 * one the anonymize-export "remove georeferencing" option deliberately routed
 * into `excludedIds` via `subset-roots.ts`'s `IDENTIFYING_TYPES` — must stay
 * excluded. Without this check, this reverse pass would resurrect it: its
 * only hook, the geometric representation context, is unconditional
 * infrastructure and stays in the closure regardless of that exclusion.
 *
 * @param closure - The existing closure set (mutated in place)
 * @param source - The original STEP file source buffer
 * @param entityIndex - Full entity index with type info and byType lookup
 * @param excludeIds - Entity IDs to never add, even if they reference the
 *   closure (deliberately-excluded ids, e.g. a privacy-scrub target)
 */
export function collectGeoreferencingEntities(
  closure: Set<number>,
  source: Uint8Array | IfcSourceBytes,
  entityIndex: {
    byId: {
      get(expressId: number): { type: string; byteOffset: number; byteLength: number } | undefined;
      has(expressId: number): boolean;
      refsOf?(expressId: number): readonly number[] | undefined;
    };
    byType: Map<string, number[]>;
  },
  excludeIds?: ReadonlySet<number>,
): void {
  const mapConversionIds = entityIndex.byType.get('IFCMAPCONVERSION') ?? [];
  if (mapConversionIds.length === 0) return;

  const queue: number[] = [];
  const refsOf = (expressId: number, ref: { byteOffset: number; byteLength: number }): number[] => {
    const authored = entityIndex.byId.refsOf?.(expressId);
    if (authored) return authored.slice();
    return collectRefsInByteRange(source, ref.byteOffset, ref.byteLength);
  };

  for (const expressId of mapConversionIds) {
    if (closure.has(expressId)) continue;
    if (excludeIds?.has(expressId)) continue;

    const entityRef = entityIndex.byId.get(expressId);
    if (!entityRef) continue;

    // Check if any referenced ID (SourceCRS, i.e. the geometric
    // representation context) is already in the closure.
    const refs = refsOf(expressId, entityRef);
    if (refs.some((id) => closure.has(id))) {
      closure.add(expressId);
      queue.push(expressId);
    }
  }

  // Walk forward from the newly added IFCMAPCONVERSION to pull in
  // IFCPROJECTEDCRS (TargetCRS) and its referenced units.
  while (queue.length > 0) {
    const entityId = queue.pop()!;
    const ref = entityIndex.byId.get(entityId);
    if (!ref) continue;

    for (const referencedId of refsOf(entityId, ref)) {
      if (
        !closure.has(referencedId)
        && !excludeIds?.has(referencedId)
        && entityIndex.byId.has(referencedId)
      ) {
        closure.add(referencedId);
        queue.push(referencedId);
      }
    }
  }
}
