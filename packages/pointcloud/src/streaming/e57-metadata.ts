/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseE57FileHeader, physicalToLogical } from '../formats/e57-page.js';
import { extractWktCrsIdentifiers } from '../spatial-wkt.js';
import { BlobByteSource } from './blob-source.js';
import { readE57LogicalRange, throwIfAborted } from './e57-logical-range.js';
import type { PointSourceSpatialMetadata } from './types.js';

/** XML is control-plane metadata; a larger section is rejected before allocation. */
export const MAX_E57_XML_METADATA_BYTES = 16 << 20;

export function spatialMetadataFromE57Xml(xml: string): PointSourceSpatialMetadata | undefined {
  const text = /<\s*(?:\w+:)?coordinateMetadata\b[^>]*>([\s\S]*?)<\/\s*(?:\w+:)?coordinateMetadata\s*>/i.exec(xml)?.[1];
  if (!text) return undefined;
  return { ...extractWktCrsIdentifiers(text), provenance: 'E57 coordinateMetadata' };
}

function assertBoundedXml(xmlLength: number, logicalSize: number): void {
  if (!Number.isSafeInteger(xmlLength) || xmlLength < 0 || xmlLength > MAX_E57_XML_METADATA_BYTES) {
    throw new Error(`E57: XML metadata length ${xmlLength} exceeds ${MAX_E57_XML_METADATA_BYTES} byte safety limit`);
  }
  if (!Number.isSafeInteger(logicalSize) || logicalSize < 0 || xmlLength > logicalSize) {
    throw new Error('E57: XML metadata range exceeds declared logical file size');
  }
}

/** Read only the header and bounded XML metadata; no point packet is decoded. */
export async function inspectE57SpatialMetadata(blob: Blob, signal?: AbortSignal): Promise<PointSourceSpatialMetadata | undefined> {
  const bytes = new BlobByteSource(blob);
  throwIfAborted(signal);
  const headerBytes = await bytes.read(0, 64);
  throwIfAborted(signal);
  const header = parseE57FileHeader(headerBytes);
  if (header.pageSize <= 4) throw new Error(`E57: invalid pageSize ${header.pageSize}`);
  const logicalSize = header.fileLogicalSize > 0 ? header.fileLogicalSize : physicalToLogical(bytes.size, header.pageSize);
  assertBoundedXml(header.xmlLogicalLength, logicalSize);
  const xml = await readE57LogicalRange(bytes, header.xmlLogicalOffset, header.xmlLogicalLength, header.pageSize, signal);
  throwIfAborted(signal);
  return spatialMetadataFromE57Xml(new TextDecoder().decode(xml));
}

export function assertE57XmlMetadataBounds(xmlLength: number, logicalSize: number): void {
  assertBoundedXml(xmlLength, logicalSize);
}
