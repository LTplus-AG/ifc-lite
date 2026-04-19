/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for Material Extractor
 */

import { describe, it, expect } from 'vitest';
import { extractMaterials, getMaterialForElement, getMaterialNameForElement } from '../src/material-extractor.js';
import type { IfcEntity } from '../src/entity-extractor.js';

describe('Material Extractor', () => {
  it('should extract IfcMaterial', () => {
    const entities = new Map<number, IfcEntity>();

    // Create IfcMaterial
    entities.set(100, {
      expressId: 100,
      type: 'IfcMaterial',
      attributes: ['Concrete', 'C30/37 Concrete', 'Structural'],
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcMaterial', [100]);

    const data = extractMaterials(entities, entitiesByType);

    expect(data.materials.size).toBe(1);

    const material = data.materials.get(100);
    expect(material).toBeDefined();
    expect(material?.name).toBe('Concrete');
    expect(material?.description).toBe('C30/37 Concrete');
    expect(material?.category).toBe('Structural');
  });

  it('should extract IfcMaterialLayer', () => {
    const entities = new Map<number, IfcEntity>();

    // Create IfcMaterial
    entities.set(100, {
      expressId: 100,
      type: 'IfcMaterial',
      attributes: ['Concrete', null, null],
    });

    // Create IfcMaterialLayer
    entities.set(200, {
      expressId: 200,
      type: 'IfcMaterialLayer',
      attributes: [
        '#100',  // Material reference
        0.2,     // Thickness (200mm)
        null,    // IsVentilated
        'Structural Layer',
        null,
        null,
        1,       // Priority
      ],
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcMaterial', [100]);
    entitiesByType.set('IfcMaterialLayer', [200]);

    const data = extractMaterials(entities, entitiesByType);

    expect(data.materialLayers.size).toBe(1);

    const layer = data.materialLayers.get(200);
    expect(layer).toBeDefined();
    expect(layer?.material).toBe(100);
    expect(layer?.thickness).toBe(0.2);
    expect(layer?.name).toBe('Structural Layer');
    expect(layer?.priority).toBe(1);
  });

  it('should extract IfcMaterialLayerSet', () => {
    const entities = new Map<number, IfcEntity>();

    // Create layers
    entities.set(200, {
      expressId: 200,
      type: 'IfcMaterialLayer',
      attributes: ['#100', 0.15, null, 'Layer 1', null, null, null],
    });

    entities.set(201, {
      expressId: 201,
      type: 'IfcMaterialLayer',
      attributes: ['#101', 0.10, null, 'Layer 2', null, null, null],
    });

    // Create IfcMaterialLayerSet
    entities.set(300, {
      expressId: 300,
      type: 'IfcMaterialLayerSet',
      attributes: [
        ['#200', '#201'],  // Layers
        'Multi-layer Wall',
        'External wall assembly',
      ],
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcMaterialLayer', [200, 201]);
    entitiesByType.set('IfcMaterialLayerSet', [300]);

    const data = extractMaterials(entities, entitiesByType);

    expect(data.materialLayerSets.size).toBe(1);

    const layerSet = data.materialLayerSets.get(300);
    expect(layerSet).toBeDefined();
    expect(layerSet?.name).toBe('Multi-layer Wall');
    expect(layerSet?.layers).toEqual([200, 201]);
    expect(layerSet?.totalThickness).toBe(0.25);  // 150mm + 100mm
  });

  it('should extract IfcRelAssociatesMaterial', () => {
    const entities = new Map<number, IfcEntity>();

    // Create material
    entities.set(100, {
      expressId: 100,
      type: 'IfcMaterial',
      attributes: ['Steel', null, null],
    });

    // Create wall
    entities.set(500, {
      expressId: 500,
      type: 'IfcWall',
      attributes: ['GlobalId', null, 'Wall-001'],
    });

    // Create material association
    entities.set(600, {
      expressId: 600,
      type: 'IfcRelAssociatesMaterial',
      attributes: [
        'RelId',
        null,
        'Material Association',
        null,
        ['#500'],  // RelatedObjects (walls)
        '#100',    // RelatingMaterial
      ],
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcMaterial', [100]);
    entitiesByType.set('IfcRelAssociatesMaterial', [600]);

    const data = extractMaterials(entities, entitiesByType);

    expect(data.associations.length).toBe(1);

    const assoc = data.associations[0];
    expect(assoc.relationshipId).toBe(600);
    expect(assoc.relatingMaterialId).toBe(100);
    expect(assoc.materialType).toBe('Material');
    expect(assoc.relatedObjects).toEqual([500]);
  });

  it('should get material for element', () => {
    const entities = new Map<number, IfcEntity>();

    entities.set(100, {
      expressId: 100,
      type: 'IfcMaterial',
      attributes: ['Concrete', null, null],
    });

    entities.set(600, {
      expressId: 600,
      type: 'IfcRelAssociatesMaterial',
      attributes: ['RelId', null, null, null, ['#500', '#501'], '#100'],
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcMaterial', [100]);
    entitiesByType.set('IfcRelAssociatesMaterial', [600]);

    const data = extractMaterials(entities, entitiesByType);

    // Element 500 should have material 100
    const materialId = getMaterialForElement(500, data);
    expect(materialId).toBe(100);

    // Element 501 should also have material 100
    const materialId2 = getMaterialForElement(501, data);
    expect(materialId2).toBe(100);

    // Element 999 should have no material
    const materialId3 = getMaterialForElement(999, data);
    expect(materialId3).toBeUndefined();
  });

  it('should get material name for element', () => {
    const entities = new Map<number, IfcEntity>();

    entities.set(100, {
      expressId: 100,
      type: 'IfcMaterial',
      attributes: ['Concrete C30/37', null, null],
    });

    entities.set(600, {
      expressId: 600,
      type: 'IfcRelAssociatesMaterial',
      attributes: ['RelId', null, null, null, ['#500'], '#100'],
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcMaterial', [100]);
    entitiesByType.set('IfcRelAssociatesMaterial', [600]);

    const data = extractMaterials(entities, entitiesByType);

    const materialName = getMaterialNameForElement(500, data);
    expect(materialName).toBe('Concrete C30/37');
  });
});
