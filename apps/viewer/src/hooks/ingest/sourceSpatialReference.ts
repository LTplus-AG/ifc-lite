/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Format-specific CRS metadata adapters for non-IFC federation sources. */

import type { ModelSpatialReference, SourceCoordinateFrame } from '@ifc-lite/geometry';
import { extractWktSpatialMetadata } from '@ifc-lite/pointcloud';
import type { LandXmlTinDocument } from './landXmlIngest.js';

export type SpatialSourceFormat = 'landxml' | 'las' | 'laz' | 'e57';

export interface SourceSpatialMetadata {
  format: SpatialSourceFormat;
  horizontalId?: string;
  verticalId?: string;
  axes?: SourceCoordinateFrame['axes'];
  horizontalUnitToMetres?: number;
  verticalUnitToMetres?: number;
  wkt?: string;
  provenance: string;
}

/**
 * LAS ordinates have no format-level metre guarantee. Once its WKT declares a
 * CRS, missing or conflicting WKT unit factors are an explicit refusal, not a
 * licence to reinterpret feet as metres. E57 is deliberately excluded: its
 * cartesianX/Y/Z payload is defined in metres independently of its CRS WKT.
 */
export function hasUsableLasWktFrame(metadata: SourceSpatialMetadata): boolean {
  if ((metadata.format !== 'las' && metadata.format !== 'laz') || !metadata.wkt) return true;
  return Number.isFinite(metadata.horizontalUnitToMetres)
    && metadata.horizontalUnitToMetres! > 0
    && Number.isFinite(metadata.verticalUnitToMetres)
    && metadata.verticalUnitToMetres! > 0;
}

function metadata(
  format: SpatialSourceFormat,
  text: string,
  provenance: string,
): SourceSpatialMetadata {
  const {
    horizontalId: horizontal,
    verticalId: vertical,
    axes,
    horizontalUnitToMetres,
    verticalUnitToMetres,
  } = extractWktSpatialMetadata(text);
  return {
    format,
    ...(horizontal ? { horizontalId: horizontal } : {}),
    ...(vertical ? { verticalId: vertical } : {}),
    ...(axes ? { axes } : {}),
    ...(horizontalUnitToMetres ? { horizontalUnitToMetres } : {}),
    ...(verticalUnitToMetres ? { verticalUnitToMetres } : {}),
    ...(text ? { wkt: text } : {}),
    provenance,
  };
}

/** Extract only explicit EPSG declarations from a LandXML CoordinateSystem. */
export function spatialMetadataFromLandXml(document: Pick<LandXmlTinDocument, 'coordinateSystem'>): SourceSpatialMetadata {
  const declared = (value: string | undefined) => /^EPSG\s*:\s*(\d+)$/i.exec(value?.trim() ?? '')?.[1];
  const horizontal = declared(document.coordinateSystem?.horizontalDatum);
  const vertical = declared(document.coordinateSystem?.verticalDatum);
  return {
    format: 'landxml',
    ...(horizontal ? { horizontalId: `EPSG:${horizontal}` } : {}),
    ...(vertical ? { verticalId: `EPSG:${vertical}` } : {}),
    provenance: 'LandXML CoordinateSystem',
  };
}

/** Extract WKT/GeoTIFF CRS text from LAS VLR bytes; unknown is deliberate. */
export function spatialMetadataFromLasVlrs(bytes: Uint8Array, format: 'las' | 'laz'): SourceSpatialMetadata {
  if (bytes.length < 227) return { format, provenance: 'LAS VLR unavailable' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = view.getUint16(94, true);
  const count = view.getUint32(100, true);
  let offset = headerSize;
  const decoder = new TextDecoder();
  let wkt2111: string | undefined;
  let wkt2112: string | undefined;
  for (let index = 0; index < count && offset + 54 <= bytes.length; index += 1) {
    const userId = decoder.decode(bytes.subarray(offset + 2, offset + 18)).replace(/\0+$/, '');
    const recordId = view.getUint16(offset + 18, true);
    const length = view.getUint16(offset + 20, true);
    const end = offset + 54 + length;
    if (end > bytes.length) break;
    // LASF_Projection WKT records 2111/2112 are the only unambiguous
    // horizontal+vertical declaration. GeoTIFF keys require a full key parser
    // and are intentionally treated as unknown rather than guessed.
    if (userId === 'LASF_Projection' && recordId === 2111) {
      wkt2111 = decoder.decode(bytes.subarray(offset + 54, end));
    } else if (userId === 'LASF_Projection' && recordId === 2112) {
      // LAS 1.4's WKT2 record supersedes WKT1 regardless of VLR ordering.
      wkt2112 = decoder.decode(bytes.subarray(offset + 54, end));
    }
    offset = end;
  }
  if (wkt2112) return metadata(format, wkt2112, 'LAS VLR 2112');
  if (wkt2111) return metadata(format, wkt2111, 'LAS VLR 2111');
  return { format, provenance: 'LAS VLR CRS absent' };
}

/** E57 stores WKT in e57Root/coordinateMetadata. Do not infer from scan poses. */
export function spatialMetadataFromE57Xml(xml: string): SourceSpatialMetadata {
  const coordinateMetadata = /<\s*(?:\w+:)?coordinateMetadata\b[^>]*>([\s\S]*?)<\/\s*(?:\w+:)?coordinateMetadata\s*>/i.exec(xml)?.[1] ?? '';
  return metadata('e57', coordinateMetadata, 'E57 coordinateMetadata');
}

/**
 * Each adapter declares the decoder tuple it actually emits. Missing horizontal
 * or vertical metadata remains a first-class unknown: the federation resolver
 * refuses any cross/manual operation rather than guessing.
 */
export function spatialReferenceFromSourceMetadata(metadata: SourceSpatialMetadata): ModelSpatialReference {
  // CRS metadata describes where authored coordinates belong, not necessarily
  // the tuple emitted by an importer. LandXML is already viewer E/U/S metres;
  // E57 remains raw cartesian XYZ metres through its decoder.
  const rawXyzFrame = metadata.format === 'las' || metadata.format === 'laz' || metadata.format === 'e57';
  return {
    // LAS stores X/Y/Z in the native CRS coordinate order. Retain every WKT
    // axis and unit declaration instead of treating a foot-based north/east
    // grid as the viewer's metre east/up/south frame. Older metadata records
    // have no WKT frame, so use LAS's documented X=east, Y=north, Z=up order.
    source: {
      // E57's cartesianX/Y/Z are spec-mandated metres in raw XYZ order. Its
      // WKT describes the CRS, not a decoder-axis remap; applying WKT axes
      // here would make the later raw-XYZ matrix unswap the scan twice.
      axes: metadata.format === 'e57' ? ['east', 'north', 'up'] : rawXyzFrame ? metadata.axes ?? ['east', 'north', 'up'] : ['east', 'up', 'south'],
      horizontalUnitToMetres: metadata.format === 'e57' ? 1 : rawXyzFrame ? metadata.horizontalUnitToMetres ?? 1 : 1,
      verticalUnitToMetres: metadata.format === 'e57' ? 1 : rawXyzFrame ? metadata.verticalUnitToMetres ?? 1 : 1,
    },
    ...(metadata.horizontalId ? { horizontal: { id: metadata.horizontalId, provenance: { source: metadata.provenance } } } : {}),
    ...(metadata.verticalId ? { vertical: { id: metadata.verticalId, provenance: { source: metadata.provenance } } } : {}),
    localToProjected: {
      kind: 'local-projected-affine', eastings: 0, northings: 0, orthogonalHeight: 0,
      xAxisAbscissa: 1, xAxisOrdinate: 0, scaleX: 1, scaleY: 1, scaleZ: 1,
    },
    confidence: metadata.horizontalId && metadata.verticalId ? 'declared' : 'unknown',
    sourceMetadata: {
      format: metadata.format, crsProvenance: metadata.provenance,
      ...(metadata.wkt ? { wkt: metadata.wkt } : {}),
    },
  };
}

/** Read LAS/LAZ VLR metadata without decoding point records. */
export async function spatialReferenceFromLasBlob(blob: Blob, format: 'las' | 'laz'): Promise<ModelSpatialReference | undefined> {
  const headerBytes = new Uint8Array(await blob.slice(0, 375).arrayBuffer());
  if (headerBytes.length < 227) return undefined;
  const header = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
  const pointDataOffset = header.getUint32(96, true);
  // VLRs precede point records and each is u16-sized.  A 4 MiB cap keeps a
  // hostile count/offset from turning CRS inspection into a second full-file
  // load; an incomplete VLR region is deliberately unknown/refused.
  if (pointDataOffset < 227 || pointDataOffset > 4 * 1024 * 1024) return undefined;
  const vlrBytes = new Uint8Array(await blob.slice(0, pointDataOffset).arrayBuffer());
  const source = spatialMetadataFromLasVlrs(vlrBytes, format);
  return source.horizontalId && source.verticalId && hasUsableLasWktFrame(source)
    ? spatialReferenceFromSourceMetadata(source)
    : undefined;
}
