/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BinaryCacheReader - reads .ifc-lite binary cache files
 */

import type { StringTable } from '@ifc-lite/data';
import {
  SectionType,
  type CacheHeaderInfo,
  type CacheReadOptions,
  type CacheReadResult,
  type IfcDataStore,
} from './types.js';
import { BufferReader } from './utils/buffer-utils.js';
import { xxhash64 } from './utils/hash.js';
import { readHeader } from './sections/header.js';
import { readStrings } from './sections/strings.js';
import { readEntities } from './sections/entities.js';
import { readProperties } from './sections/properties.js';
import { readQuantities } from './sections/quantities.js';
import { readRelationships } from './sections/relationships.js';
import { readGeometry } from './sections/geometry.js';
import { readEntityIndex } from './sections/entity-index.js';

export class BinaryCacheReader {
  /**
   * Read only the header (fast validation)
   */
  readHeader(buffer: ArrayBuffer): CacheHeaderInfo {
    const reader = new BufferReader(buffer);
    return readHeader(reader);
  }

  /**
   * Validate cache against source file
   */
  validate(cacheBuffer: ArrayBuffer, sourceBuffer: ArrayBuffer): boolean {
    const header = this.readHeader(cacheBuffer);
    const sourceHash = xxhash64(sourceBuffer);
    return header.sourceHash === sourceHash;
  }

  /**
   * Read complete cache file
   */
  async read(
    buffer: ArrayBuffer,
    options: CacheReadOptions = {}
  ): Promise<CacheReadResult> {
    const { skipGeometry = false, sourceBuffer } = options;

    const reader = new BufferReader(buffer);
    const header = readHeader(reader);

    // Validate source if provided
    if (sourceBuffer) {
      const sourceHash = xxhash64(sourceBuffer);
      if (header.sourceHash !== sourceHash) {
        throw new Error('Cache validation failed: source file has changed');
      }
    }

    // Find sections by type
    const sectionMap = new Map(header.sections.map((s) => [s.type, s]));

    // Read strings first (required by other sections)
    const stringsSection = sectionMap.get(SectionType.Strings);
    if (!stringsSection) {
      throw new Error('Missing required Strings section');
    }
    reader.position = stringsSection.offset;
    const strings = readStrings(reader);

    // Read entities
    const entitiesSection = sectionMap.get(SectionType.Entities);
    if (!entitiesSection) {
      throw new Error('Missing required Entities section');
    }
    reader.position = entitiesSection.offset;
    const entities = readEntities(reader, strings);

    // Read properties
    const propertiesSection = sectionMap.get(SectionType.Properties);
    if (!propertiesSection) {
      throw new Error('Missing required Properties section');
    }
    reader.position = propertiesSection.offset;
    const properties = readProperties(reader, strings);

    // Read quantities
    const quantitiesSection = sectionMap.get(SectionType.Quantities);
    if (!quantitiesSection) {
      throw new Error('Missing required Quantities section');
    }
    reader.position = quantitiesSection.offset;
    const quantities = readQuantities(reader, strings);

    // Read relationships
    const relationshipsSection = sectionMap.get(SectionType.Relationships);
    if (!relationshipsSection) {
      throw new Error('Missing required Relationships section');
    }
    reader.position = relationshipsSection.offset;
    const relationships = readRelationships(reader);

    const dataStore: IfcDataStore = {
      schema: header.schema,
      entityCount: header.entityCount,
      strings,
      entities,
      properties,
      quantities,
      relationships,
    };

    const result: CacheReadResult = { dataStore };

    const entityIndexSection = sectionMap.get(SectionType.EntityIndex);
    if (entityIndexSection) {
      reader.position = entityIndexSection.offset;
      result.entityIndex = readEntityIndex(reader);
    }

    // Read geometry (optional)
    if (!skipGeometry && header.hasGeometry) {
      const geometrySection = sectionMap.get(SectionType.Geometry);
      if (geometrySection) {
        reader.position = geometrySection.offset;
        result.geometry = readGeometry(reader, header.version);
      }
    }

    return result;
  }
}
