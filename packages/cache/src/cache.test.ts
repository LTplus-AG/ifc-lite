/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for @ifc-lite/cache
 */

import { describe, it, beforeEach, expect } from 'vitest';
import {
  StringTable,
  EntityTableBuilder,
  PropertyTableBuilder,
  QuantityTableBuilder,
  RelationshipGraphBuilder,
  PropertyValueType,
  QuantityType,
  RelationshipType,
} from '@ifc-lite/data';
import { BinaryCacheWriter, BinaryCacheReader, xxhash64, SchemaVersion, FORMAT_VERSION } from './index.js';
import type { IfcDataStore } from './types.js';
import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';

describe('xxhash64', () => {
  it('should hash empty buffer', () => {
    const hash = xxhash64(new Uint8Array(0));
    expect(typeof hash).toBe('bigint');
  });

  it('should produce consistent hashes', () => {
    const data = new TextEncoder().encode('Hello, World!');
    const hash1 = xxhash64(data);
    const hash2 = xxhash64(data);
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different data', () => {
    const data1 = new TextEncoder().encode('Hello');
    const data2 = new TextEncoder().encode('World');
    const hash1 = xxhash64(data1);
    const hash2 = xxhash64(data2);
    expect(hash1).not.toBe(hash2);
  });
});

describe('BinaryCacheWriter and BinaryCacheReader', () => {
  let dataStore: IfcDataStore;
  let sourceBuffer: ArrayBuffer;

  beforeEach(() => {
    // Create test data
    const strings = new StringTable();

    // Build entity table
    const entityBuilder = new EntityTableBuilder(10, strings);
    entityBuilder.add(1, 'IfcProject', 'guid-project', 'Test Project', '', '', false, false);
    entityBuilder.add(2, 'IfcSite', 'guid-site', 'Test Site', '', '', false, false);
    entityBuilder.add(3, 'IfcBuilding', 'guid-building', 'Test Building', '', '', false, false);
    entityBuilder.add(4, 'IfcWall', 'guid-wall-1', 'Wall 1', '', '', true, false);
    entityBuilder.add(5, 'IfcWall', 'guid-wall-2', 'Wall 2', '', '', true, false);
    const entities = entityBuilder.build();

    // Build property table
    const propertyBuilder = new PropertyTableBuilder(strings);
    propertyBuilder.add({
      entityId: 4,
      psetName: 'Pset_WallCommon',
      psetGlobalId: 'pset-guid-1',
      propName: 'IsExternal',
      propType: PropertyValueType.Boolean,
      value: true,
    });
    propertyBuilder.add({
      entityId: 4,
      psetName: 'Pset_WallCommon',
      psetGlobalId: 'pset-guid-1',
      propName: 'FireRating',
      propType: PropertyValueType.Label,
      value: 'REI60',
    });
    const properties = propertyBuilder.build();

    // Build quantity table
    const quantityBuilder = new QuantityTableBuilder(strings);
    quantityBuilder.add({
      entityId: 4,
      qsetName: 'Qto_WallBaseQuantities',
      quantityName: 'Length',
      quantityType: QuantityType.Length,
      value: 5.5,
    });
    quantityBuilder.add({
      entityId: 4,
      qsetName: 'Qto_WallBaseQuantities',
      quantityName: 'GrossVolume',
      quantityType: QuantityType.Volume,
      value: 2.75,
    });
    const quantities = quantityBuilder.build();

    // Build relationship graph
    const relationshipBuilder = new RelationshipGraphBuilder();
    relationshipBuilder.addEdge(3, 4, RelationshipType.ContainsElements, 100);
    relationshipBuilder.addEdge(3, 5, RelationshipType.ContainsElements, 101);
    const relationships = relationshipBuilder.build();

    const source = new TextEncoder().encode([
      'ISO-10303-21;',
      'HEADER;',
      'ENDSEC;',
      'DATA;',
      "#1=IFCPROJECT('guid-project');",
      "#2=IFCSITE('guid-site');",
      "#3=IFCBUILDING('guid-building');",
      "#4=IFCWALL('guid-wall-1');",
      "#5=IFCWALL('guid-wall-2');",
      'ENDSEC;',
      'END-ISO-10303-21;',
    ].join('\n'));
    sourceBuffer = source.buffer;
    const entityRefs = new Map<number, { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number }>();
    // Find the full `#<id>=` marker (not just the first `#` byte) so a `#`
    // appearing inside a string value can't produce a wrong offset.
    const findMarker = (needle: Uint8Array, from: number): number => {
      outer: for (let i = from; i <= source.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
          if (source[i + j] !== needle[j]) continue outer;
        }
        return i;
      }
      return -1;
    };
    for (const id of [1, 2, 3, 4, 5]) {
      const marker = new TextEncoder().encode(`#${id}=`);
      const byteOffset = findMarker(marker, id === 1 ? 0 : (entityRefs.get(id - 1)?.byteOffset ?? 0) + 1);
      const lineEnd = source.indexOf(0x3b, byteOffset) + 1;
      const type = id === 1 ? 'IFCPROJECT' : id === 2 ? 'IFCSITE' : id === 3 ? 'IFCBUILDING' : 'IFCWALL';
      entityRefs.set(id, {
        expressId: id,
        type,
        byteOffset,
        byteLength: lineEnd - byteOffset,
        lineNumber: 0,
      });
    }

    dataStore = {
      schema: SchemaVersion.IFC4,
      entityCount: 5,
      strings,
      entities,
      properties,
      quantities,
      relationships,
      entityIndex: { byId: entityRefs },
    };
  });

  it('should write and read cache without geometry', async () => {
    const writer = new BinaryCacheWriter();
    const cacheBuffer = await writer.write(dataStore, undefined, sourceBuffer, {
      includeGeometry: false,
    });

    expect(cacheBuffer).toBeInstanceOf(ArrayBuffer);
    expect(cacheBuffer.byteLength).toBeGreaterThan(0);

    const reader = new BinaryCacheReader();
    const result = await reader.read(cacheBuffer);

    expect(result.dataStore.entityCount).toBe(5);
    expect(result.dataStore.schema).toBe(SchemaVersion.IFC4);
    expect(result.geometry).toBeUndefined();
  });

  it('should write and read cache with geometry', async () => {
    const meshes: MeshData[] = [
      {
        expressId: 4,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
        color: [0.8, 0.8, 0.8, 1.0],
      },
    ];

    const coordinateInfo: CoordinateInfo = {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
      hasLargeCoordinates: false,
    };

    const geometry = {
      meshes,
      totalVertices: 3,
      totalTriangles: 1,
      coordinateInfo,
    };

    const writer = new BinaryCacheWriter();
    const cacheBuffer = await writer.write(dataStore, geometry, sourceBuffer);

    const reader = new BinaryCacheReader();
    const result = await reader.read(cacheBuffer);

    expect(result.geometry).toBeTruthy();
    expect(result.geometry!.meshes.length).toBe(1);
    expect(result.geometry!.meshes[0].expressId).toBe(4);
    expect(result.geometry!.totalVertices).toBe(3);
    expect(result.geometry!.totalTriangles).toBe(1);
  });

  it('should validate cache against source', async () => {
    const writer = new BinaryCacheWriter();
    const cacheBuffer = await writer.write(dataStore, undefined, sourceBuffer, {
      includeGeometry: false,
    });

    const reader = new BinaryCacheReader();

    // Valid source
    expect(reader.validate(cacheBuffer, sourceBuffer)).toBe(true);

    // Modified source
    const modifiedSource = new TextEncoder().encode('MODIFIED IFC FILE').buffer;
    expect(reader.validate(cacheBuffer, modifiedSource)).toBe(false);
  });

  it('should read header only', async () => {
    const writer = new BinaryCacheWriter();
    const cacheBuffer = await writer.write(dataStore, undefined, sourceBuffer, {
      includeGeometry: false,
    });

    const reader = new BinaryCacheReader();
    const header = reader.readHeader(cacheBuffer);

    expect(header.version).toBe(FORMAT_VERSION);
    expect(header.entityCount).toBe(5);
    expect(header.schema).toBe(SchemaVersion.IFC4);
    expect(header.sections.length).toBeGreaterThan(0);
  });

  it('should preserve entity data through round-trip', async () => {
    const writer = new BinaryCacheWriter();
    const cacheBuffer = await writer.write(dataStore, undefined, sourceBuffer, {
      includeGeometry: false,
    });

    const reader = new BinaryCacheReader();
    const result = await reader.read(cacheBuffer);

    // Check entities
    const { entities, strings } = result.dataStore;
    expect(entities.count).toBe(5);

    // Check that we can retrieve entity names
    expect(entities.getName(1)).toBe('Test Project');
    expect(entities.getName(4)).toBe('Wall 1');
    expect(entities.getTypeName(4)).toBe('IfcWall');
  });

  it('should preserve property data through round-trip', async () => {
    const writer = new BinaryCacheWriter();
    const cacheBuffer = await writer.write(dataStore, undefined, sourceBuffer, {
      includeGeometry: false,
    });

    const reader = new BinaryCacheReader();
    const result = await reader.read(cacheBuffer);

    const { properties } = result.dataStore;
    const psets = properties.getForEntity(4);

    expect(psets.length).toBe(1);
    expect(psets[0].name).toBe('Pset_WallCommon');
    expect(psets[0].properties.length).toBe(2);

    // Check property values
    const isExternal = properties.getPropertyValue(4, 'Pset_WallCommon', 'IsExternal');
    expect(isExternal).toBe(true);

    const fireRating = properties.getPropertyValue(4, 'Pset_WallCommon', 'FireRating');
    expect(fireRating).toBe('REI60');
  });

  it('should preserve quantity data through round-trip', async () => {
    const writer = new BinaryCacheWriter();
    const cacheBuffer = await writer.write(dataStore, undefined, sourceBuffer, {
      includeGeometry: false,
    });

    const reader = new BinaryCacheReader();
    const result = await reader.read(cacheBuffer);

    const { quantities } = result.dataStore;
    const qsets = quantities.getForEntity(4);

    expect(qsets.length).toBe(1);
    expect(qsets[0].name).toBe('Qto_WallBaseQuantities');

    const length = quantities.getQuantityValue(4, 'Qto_WallBaseQuantities', 'Length');
    expect(length).toBe(5.5);
  });

  it('should preserve relationship data through round-trip', async () => {
    const writer = new BinaryCacheWriter();
    const cacheBuffer = await writer.write(dataStore, undefined, sourceBuffer, {
      includeGeometry: false,
    });

    const reader = new BinaryCacheReader();
    const result = await reader.read(cacheBuffer);

    const { relationships } = result.dataStore;

    // Check forward relationships
    const contained = relationships.getRelated(3, RelationshipType.ContainsElements, 'forward');
    expect(contained).toContain(4);
    expect(contained).toContain(5);

    // Check inverse relationships
    const containers = relationships.getRelated(4, RelationshipType.ContainsElements, 'inverse');
    expect(containers).toContain(3);
  });

  it('should preserve entity index byte offsets through round-trip', async () => {
    const writer = new BinaryCacheWriter();
    const cacheBuffer = await writer.write(dataStore, undefined, sourceBuffer, {
      includeGeometry: false,
    });

    const reader = new BinaryCacheReader();
    const result = await reader.read(cacheBuffer);

    expect(result.entityIndex).toBeDefined();
    expect(Array.from(result.entityIndex!.ids)).toEqual([1, 2, 3, 4, 5]);
    const wallIndex = Array.from(result.entityIndex!.ids).indexOf(4);
    expect(result.entityIndex!.typeNames[result.entityIndex!.typeIndices[wallIndex]]).toBe('IFCWALL');
    const wallText = new TextDecoder().decode(
      new Uint8Array(sourceBuffer).subarray(
        result.entityIndex!.byteOffsets[wallIndex],
        result.entityIndex!.byteOffsets[wallIndex] + result.entityIndex!.byteLengths[wallIndex],
      ),
    );
    expect(wallText).toBe("#4=IFCWALL('guid-wall-1');");
  });

  it('should preserve ifcType in geometry through round-trip', async () => {
    const meshes: MeshData[] = [
      {
        expressId: 4,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
        color: [0.8, 0.8, 0.8, 1.0],
        ifcType: 'IfcWall',
      },
      {
        expressId: 5,
        positions: new Float32Array([0, 0, 0, 2, 0, 0, 2, 2, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
        color: [0.6, 0.6, 0.6, 1.0],
        ifcType: 'IfcSlab',
      },
    ];

    const coordinateInfo: CoordinateInfo = {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 0 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 0 } },
      hasLargeCoordinates: false,
    };

    const geometry = {
      meshes,
      totalVertices: 6,
      totalTriangles: 2,
      coordinateInfo,
    };

    const writer = new BinaryCacheWriter();
    const cacheBuffer = await writer.write(dataStore, geometry, sourceBuffer);

    const reader = new BinaryCacheReader();
    const result = await reader.read(cacheBuffer);

    expect(result.geometry).toBeTruthy();
    expect(result.geometry!.meshes.length).toBe(2);
    expect(result.geometry!.meshes[0].ifcType).toBe('IfcWall');
    expect(result.geometry!.meshes[1].ifcType).toBe('IfcSlab');
  });

  it('should skip geometry when requested', async () => {
    const meshes: MeshData[] = [
      {
        expressId: 4,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
        color: [0.8, 0.8, 0.8, 1.0],
      },
    ];

    const geometry = {
      meshes,
      totalVertices: 3,
      totalTriangles: 1,
      coordinateInfo: {
        originShift: { x: 0, y: 0, z: 0 },
        originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
        shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
        hasLargeCoordinates: false,
      },
    };

    const writer = new BinaryCacheWriter();
    const cacheBuffer = await writer.write(dataStore, geometry, sourceBuffer);

    const reader = new BinaryCacheReader();
    const result = await reader.read(cacheBuffer, { skipGeometry: true });

    expect(result.geometry).toBeUndefined();
    expect(result.dataStore.entities).toBeTruthy();
  });
});
