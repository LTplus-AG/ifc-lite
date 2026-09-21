/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ModelSpatialReference } from '@ifc-lite/geometry';
import {
  extractWktSpatialMetadata,
  inspectE57SpatialMetadata,
  type PointSourceSpatialMetadata,
} from '@ifc-lite/pointcloud';
import { toast } from '@/components/ui/toast';
import {
  computePointCloudAlignment,
  type PointCloudAlignmentTransform,
  type PointCloudSourceUnit,
} from './pointCloudAlignment';
import { findReferenceSpatialModel } from './federationAlign';
import type { PointCloudFormat } from './pointCloudIngest';
import { hasUsableLasWktFrame, spatialReferenceFromLasBlob, spatialReferenceFromSourceMetadata } from './sourceSpatialReference';

export function pointCloudSpatialReferenceFromMetadata(
  format: PointCloudFormat,
  metadata: PointSourceSpatialMetadata | undefined,
): ModelSpatialReference | undefined {
  if ((format !== 'las' && format !== 'laz' && format !== 'e57')
    || !metadata?.horizontalId || !metadata.verticalId) return undefined;
  const nativeFrame = metadata.wkt ? extractWktSpatialMetadata(metadata.wkt) : {};
  const source = {
    format: format === 'e57' ? 'e57' : format === 'laz' ? 'laz' : 'las',
    horizontalId: metadata.horizontalId,
    verticalId: metadata.verticalId,
    ...(nativeFrame.axes ? { axes: nativeFrame.axes } : {}),
    ...(nativeFrame.horizontalUnitToMetres
      ? { horizontalUnitToMetres: nativeFrame.horizontalUnitToMetres }
      : {}),
    ...(nativeFrame.verticalUnitToMetres
      ? { verticalUnitToMetres: nativeFrame.verticalUnitToMetres }
      : {}),
    ...(metadata.wkt ? { wkt: metadata.wkt } : {}),
    provenance: metadata.provenance,
  } as const;
  return hasUsableLasWktFrame(source) ? spatialReferenceFromSourceMetadata(source) : undefined;
}

export async function preparePointCloudSpatialLoad(
  file: Blob,
  format: PointCloudFormat,
  sourceUnit: PointCloudSourceUnit,
  isCurrent: () => boolean = () => true,
): Promise<{ sourceSpatialReference?: ModelSpatialReference; alignment?: PointCloudAlignmentTransform }> {
  const sourceSpatialReference = format === 'las' || format === 'laz'
    ? await spatialReferenceFromLasBlob(file, format)
    : format === 'e57'
      ? pointCloudSpatialReferenceFromMetadata(format, await inspectE57SpatialMetadata(file))
      : undefined;
  // Metadata inspection can outlive a cancelled/superseded load. Do not read
  // the current federation or publish a refusal toast for that old request.
  if (!isCurrent()) return {};
  const reference = findReferenceSpatialModel();
  const sameFrame = sourceSpatialReference && reference
    && sourceSpatialReference.horizontal?.id === reference.placement.spatialReference.horizontal?.id
    && sourceSpatialReference.vertical?.id === reference.placement.spatialReference.vertical?.id;
  const alignment = sameFrame && reference
    ? computePointCloudAlignment(reference.placement, sourceUnit, sourceSpatialReference) ?? undefined
    : undefined;
  if (isCurrent() && reference && !sameFrame && (format === 'las' || format === 'laz' || format === 'e57')) {
    toast.info(`${format.toUpperCase()} CRS is missing or differs from the federation anchor; automatic placement was refused.`);
  }
  return { sourceSpatialReference, alignment };
}
