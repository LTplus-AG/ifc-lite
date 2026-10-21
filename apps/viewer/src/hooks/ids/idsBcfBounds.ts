/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityBoundsInput, IDSReportInput } from '@ifc-lite/bcf';
import type { GeometryResult } from '@ifc-lite/geometry';
import { resolvePresentationIds } from '@/lib/presentation/resolvePresentationIds';
import { createEntityBoundsLookup } from '@/utils/viewportUtils';

type BoundsGeometry = Pick<GeometryResult, 'meshes' | 'instancedGeometryAabbs'>;

/**
 * Every grouped failure needs bounds: one missing box removes the group's
 * camera. Instanced occurrences never enter the flat mesh array, and after
 * streaming releases that array the live scene can be the only source (#7974).
 * All lookups use renderer global ids; report keys remain modelId:expressId.
 */
export function collectIdsBcfEntityBounds(
  report: Pick<IDSReportInput, 'specificationResults'>,
  includePassingEntities: boolean,
  models: ReadonlyMap<string, { geometryResult?: BoundsGeometry | null }>,
  legacyGeometry: BoundsGeometry | null,
  toViewerGlobalId: (modelId: string, expressId: number) => number | undefined,
  sceneBounds: (id: number) => EntityBoundsInput | null | undefined,
  resolveHighlightIds?: (ids: number[]) => number[],
): Map<string, EntityBoundsInput> {
  const result = new Map<string, EntityBoundsInput>();
  const seen = new Set<string>();
  const meshReaders = new Map<BoundsGeometry, ReturnType<typeof createEntityBoundsLookup>>();
  const geometries = [...models.values()].flatMap(model => model.geometryResult ? [model.geometryResult] : []);
  const singleGeometry = geometries.length === 1 ? geometries[0] : undefined;

  for (const spec of report.specificationResults) {
    for (const entity of spec.entityResults) {
      if (entity.passed && !includePassingEntities) continue;
      const key = `${entity.modelId}:${entity.expressId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const id = toViewerGlobalId(entity.modelId, entity.expressId);
      if (id == null) continue;

      // Legacy reports can name their sole model "default". Never borrow a
      // different model's geometry when multiple models are loaded.
      const geometry = models.get(entity.modelId)?.geometryResult
        ?? (models.size <= 1 ? singleGeometry ?? legacyGeometry : undefined);
      // The scene unions flat and instanced pieces of a hybrid entity. Reading
      // only its retained flat pieces would silently frame a partial element.
      const boxes: EntityBoundsInput[] = [];
      for (const presentationId of resolvePresentationIds(resolveHighlightIds, [id])) {
        let bounds = sceneBounds(presentationId);
        if (!bounds && geometry) {
          let read = meshReaders.get(geometry);
          if (!read) {
            read = createEntityBoundsLookup(geometry.meshes);
            meshReaders.set(geometry, read);
          }
          bounds = read(presentationId);
          const occurrence = geometry.instancedGeometryAabbs?.get(presentationId);
          if (occurrence) {
            if (bounds) boxes.push(bounds);
            bounds = {
              min: { x: occurrence.min[0], y: occurrence.min[1], z: occurrence.min[2] },
              max: { x: occurrence.max[0], y: occurrence.max[1], z: occurrence.max[2] },
            };
          }
        }
        if (bounds) boxes.push(bounds);
      }
      const bounds = unionIdsBcfBounds(boxes);
      if (bounds) result.set(key, bounds);
    }
  }
  return result;
}

/** Bounds remain in the viewer render frame until the completed project is translated. */
function unionIdsBcfBounds(boxes: readonly EntityBoundsInput[]): EntityBoundsInput | undefined {
  if (boxes.length === 0) return undefined;
  const result = { min: { ...boxes[0].min }, max: { ...boxes[0].max } };
  for (const box of boxes) {
    for (const axis of ['x', 'y', 'z'] as const) {
      result.min[axis] = Math.min(result.min[axis], box.min[axis]);
      result.max[axis] = Math.max(result.max[axis], box.max[axis]);
    }
  }
  return result;
}
