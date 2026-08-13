/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Integration tests for IFC Mutations (Property Editing and Export)
 *
 * Tests:
 * 1. MutablePropertyView with on-demand extraction
 * 2. BulkQueryEngine entity selection
 * 3. Property mutations (SET, DELETE)
 * 4. Full editing flow
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ColumnarParser, extractPropertiesOnDemand } from '../../parser/src/columnar-parser.js';
import { StepTokenizer } from '../../parser/src/tokenizer.js';
import { PropertyValueType } from '../../data/src/index.js';
import { MutablePropertyView, BulkQueryEngine } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function hasMaterializedIfcContent(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    // Git LFS pointer files start with this header and do not contain IFC payload data.
    if (content.startsWith('version https://git-lfs.github.com/spec/v1')) {
      return false;
    }
    return content.includes('ISO-10303-21');
  } catch {
    return false;
  }
}

// Find test IFC file
const monorepoRoot = path.resolve(__dirname, '../../..');
const testFiles = [
  path.join(monorepoRoot, 'tests', 'models', 'ara3d', 'AC20-FZK-Haus.ifc'),
  path.join(monorepoRoot, 'tests', 'models', 'ara3d', 'IfcOpenHouse_IFC4.ifc'),
  path.join(monorepoRoot, 'tests', 'models', '01_BIMcollab_Example_ARC.ifc'),
  path.join(monorepoRoot, 'tests', 'models', 'test.ifc'),
];

let testFile: string | null = null;
for (const file of testFiles) {
  if (fs.existsSync(file) && hasMaterializedIfcContent(file)) {
    testFile = file;
    break;
  }
}

// Parsed store - shared across tests
let store: Awaited<ReturnType<ColumnarParser['parseLite']>>;

describe.skipIf(!testFile)('IFC Mutations Integration', () => {
  beforeAll(async () => {
    if (!testFile) return;

    // Parse the IFC file
    const fileBuffer = fs.readFileSync(testFile);
    const uint8Buffer = new Uint8Array(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.length);

    // Scan entities using tokenizer
    const tokenizer = new StepTokenizer(uint8Buffer);
    const entityRefs: Array<{
      expressId: number;
      type: string;
      byteOffset: number;
      byteLength: number;
      lineNumber: number;
    }> = [];

    for (const ref of tokenizer.scanEntitiesFast()) {
      entityRefs.push({
        expressId: ref.expressId,
        type: ref.type,
        byteOffset: ref.offset,
        byteLength: ref.length,
        lineNumber: ref.line,
      });
    }

    // Build columnar store
    const columnarParser = new ColumnarParser();
    store = await columnarParser.parseLite(fileBuffer.buffer, entityRefs, {});
  });

  describe('On-Demand Property Extraction', () => {
    it('should have populated on-demand property map', () => {
      expect(store.onDemandPropertyMap).toBeDefined();
      expect(store.onDemandPropertyMap!.size).toBeGreaterThan(0);
    });

    it('should extract properties for entity with properties', () => {
      const entityId = store.onDemandPropertyMap!.keys().next().value;
      if (entityId === undefined) {
        console.log('No entities with properties found');
        return;
      }

      const properties = extractPropertiesOnDemand(store, entityId);
      expect(Array.isArray(properties)).toBe(true);
      expect(properties.length).toBeGreaterThan(0);
    });

    it('should return empty for entity without properties', () => {
      // Find an entity without properties
      let entityWithoutProps: number | null = null;
      for (let i = 0; i < Math.min(store.entities.count, 100); i++) {
        const id = store.entities.expressId[i];
        if (!store.onDemandPropertyMap!.has(id)) {
          entityWithoutProps = id;
          break;
        }
      }

      if (entityWithoutProps === null) {
        console.log('All entities have properties, skipping test');
        return;
      }

      const properties = extractPropertiesOnDemand(store, entityWithoutProps);
      expect(Array.isArray(properties)).toBe(true);
      expect(properties.length).toBe(0);
    });
  });

  describe('MutablePropertyView', () => {
    it('should work with on-demand extractor', () => {
      const view = new MutablePropertyView(store.properties, 'test-model');
      view.setOnDemandExtractor((entityId: number) => {
        return extractPropertiesOnDemand(store, entityId);
      });

      const entityId = store.onDemandPropertyMap!.keys().next().value;
      if (entityId === undefined) {
        console.log('No entities with properties found');
        return;
      }

      const props = view.getForEntity(entityId);
      expect(props.length).toBeGreaterThan(0);
    });

    it('should create mutation on setProperty', () => {
      const view = new MutablePropertyView(store.properties, 'test-model');
      view.setOnDemandExtractor((entityId: number) => extractPropertiesOnDemand(store, entityId));

      const entityId = store.onDemandPropertyMap!.keys().next().value;
      if (entityId === undefined) {
        console.log('No entities with properties found');
        return;
      }

      const mutation = view.setProperty(
        entityId,
        'TestPset',
        'TestProperty',
        'TestValue',
        PropertyValueType.String
      );

      expect(mutation).not.toBeNull();
      expect(mutation!.entityId).toBe(entityId);
      expect(mutation!.psetName).toBe('TestPset');
      expect(mutation!.propName).toBe('TestProperty');
      expect(mutation!.newValue).toBe('TestValue');

      const value = view.getPropertyValue(entityId, 'TestPset', 'TestProperty');
      expect(value).toBe('TestValue');
    });

    it('should track mutation history', () => {
      const view = new MutablePropertyView(store.properties, 'test-model');
      view.setOnDemandExtractor((entityId: number) => extractPropertiesOnDemand(store, entityId));

      const entityId = store.onDemandPropertyMap!.keys().next().value;
      if (entityId === undefined) {
        console.log('No entities with properties found');
        return;
      }

      view.setProperty(entityId, 'Pset1', 'Prop1', 'Value1', PropertyValueType.String);
      view.setProperty(entityId, 'Pset1', 'Prop2', 42, PropertyValueType.Integer);
      view.setProperty(entityId, 'Pset2', 'PropA', true, PropertyValueType.Boolean);

      const mutations = view.getMutations();
      expect(mutations.length).toBe(3);
      expect(view.getModifiedEntityCount()).toBe(1);
    });
  });

  describe('BulkQueryEngine', () => {
    it('should select all entities with empty criteria', () => {
      const view = new MutablePropertyView(store.properties, 'test-model');
      view.setOnDemandExtractor((entityId: number) => extractPropertiesOnDemand(store, entityId));

      const engine = new BulkQueryEngine(
        store.entities,
        view,
        store.spatialHierarchy || null,
        store.properties || null,
        store.strings || null
      );

      const selected = engine.select({});
      expect(selected.length).toBe(store.entities.count);
    });

    it('should filter by entity type', () => {
      const view = new MutablePropertyView(store.properties, 'test-model');
      view.setOnDemandExtractor((entityId: number) => extractPropertiesOnDemand(store, entityId));

      const engine = new BulkQueryEngine(
        store.entities,
        view,
        store.spatialHierarchy || null,
        store.properties || null,
        store.strings || null
      );

      // Find a type enum that exists in the model
      const typeEnumSet = new Set<number>();
      for (let i = 0; i < store.entities.count; i++) {
        typeEnumSet.add(store.entities.typeEnum[i]);
      }

      const firstType = typeEnumSet.values().next().value;
      if (firstType === undefined) {
        console.log('No entity types found');
        return;
      }

      const selected = engine.select({ entityTypes: [firstType] });
      expect(selected.length).toBeGreaterThan(0);
    });

    it('should execute bulk update', () => {
      const view = new MutablePropertyView(store.properties, 'test-model');
      view.setOnDemandExtractor((entityId: number) => extractPropertiesOnDemand(store, entityId));

      const engine = new BulkQueryEngine(
        store.entities,
        view,
        store.spatialHierarchy || null,
        store.properties || null,
        store.strings || null
      );

      // Get first 5 entity IDs
      const entityIds: number[] = [];
      for (let i = 0; i < Math.min(5, store.entities.count); i++) {
        entityIds.push(store.entities.expressId[i]);
      }

      const result = engine.execute({
        select: { expressIds: entityIds },
        action: {
          type: 'SET_PROPERTY',
          psetName: 'BulkTestPset',
          propName: 'BulkTestProp',
          value: 'BulkValue',
          valueType: PropertyValueType.String,
        },
      });

      expect(result.success).toBe(true);
      expect(result.mutations.length).toBe(entityIds.length);
    });
  });

  describe('Full Edit Flow', () => {
    it('should complete load -> edit -> verify flow', () => {
      const view = new MutablePropertyView(store.properties, 'full-test-model');
      view.setOnDemandExtractor((entityId: number) => extractPropertiesOnDemand(store, entityId));

      const engine = new BulkQueryEngine(
        store.entities,
        view,
        store.spatialHierarchy || null,
        store.properties || null,
        store.strings || null
      );

      // Step 1: Select entities
      const allEntities = engine.select({});
      expect(allEntities.length).toBe(store.entities.count);

      // Step 2: Apply bulk update to first 10 entities
      const targetEntities = allEntities.slice(0, 10);
      const updateResult = engine.execute({
        select: { expressIds: targetEntities },
        action: {
          type: 'SET_PROPERTY',
          psetName: 'FlowTestPset',
          propName: 'FlowTestProp',
          value: 'FlowTestValue',
          valueType: PropertyValueType.String,
        },
      });
      expect(updateResult.mutations.length).toBe(targetEntities.length);

      // Step 3: Verify mutations are in the view
      const mutations = view.getMutations();
      expect(mutations.length).toBeGreaterThanOrEqual(targetEntities.length);

      // Step 4: Verify property values are retrievable
      for (const entityId of targetEntities.slice(0, 3)) {
        const value = view.getPropertyValue(entityId, 'FlowTestPset', 'FlowTestProp');
        expect(value).toBe('FlowTestValue');
      }
    });
  });
});
