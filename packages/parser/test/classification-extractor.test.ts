/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for Classification Extractor
 */

import { describe, it, expect } from 'vitest';
import {
  extractClassifications,
  getClassificationsForElement,
  getClassificationCodeForElement,
  getClassificationPath,
  groupElementsByClassification,
  getClassificationSystemName,
} from '../src/classification-extractor.js';
import type { IfcEntity } from '../src/entity-extractor.js';

describe('Classification Extractor', () => {
  it('should extract IfcClassification', () => {
    const entities = new Map<number, IfcEntity>();

    entities.set(100, {
      expressId: 100,
      type: 'IfcClassification',
      attributes: [
        'BuildingSmart',  // Source
        '2.0',            // Edition
        '2015-01-01',     // EditionDate
        'Uniclass 2015',  // Name
        'UK classification system',
        'http://uniclass.thenbs.com',
        ['Pr', 'EF', 'Ss'],  // ReferenceTokens
      ],
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcClassification', [100]);

    const data = extractClassifications(entities, entitiesByType);

    expect(data.classifications.size).toBe(1);

    const classification = data.classifications.get(100);
    expect(classification).toBeDefined();
    expect(classification?.name).toBe('Uniclass 2015');
    expect(classification?.source).toBe('BuildingSmart');
    expect(classification?.edition).toBe('2.0');
  });

  it('should extract IfcClassificationReference', () => {
    const entities = new Map<number, IfcEntity>();

    entities.set(200, {
      expressId: 200,
      type: 'IfcClassificationReference',
      attributes: [
        'http://uniclass.thenbs.com/Pr_60_10_32',  // Location
        'Pr_60_10_32',     // Identification
        'External wall',    // Name
        '#100',            // ReferencedSource
        'Load-bearing external wall',
        null,              // Sort
      ],
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcClassificationReference', [200]);

    const data = extractClassifications(entities, entitiesByType);

    expect(data.classificationReferences.size).toBe(1);

    const ref = data.classificationReferences.get(200);
    expect(ref).toBeDefined();
    expect(ref?.identification).toBe('Pr_60_10_32');
    expect(ref?.name).toBe('External wall');
    expect(ref?.referencedSource).toBe(100);
  });

  it('should extract IfcRelAssociatesClassification', () => {
    const entities = new Map<number, IfcEntity>();

    // Classification reference
    entities.set(200, {
      expressId: 200,
      type: 'IfcClassificationReference',
      attributes: [null, 'Pr_60_10_32', 'External wall', '#100', null, null],
    });

    // Wall
    entities.set(500, {
      expressId: 500,
      type: 'IfcWall',
      attributes: ['GlobalId', null, 'Wall-001'],
    });

    // Association
    entities.set(600, {
      expressId: 600,
      type: 'IfcRelAssociatesClassification',
      attributes: [
        'RelId',
        null,
        'Classification Association',
        null,
        ['#500', '#501'],  // RelatedObjects
        '#200',            // RelatingClassification
      ],
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcClassificationReference', [200]);
    entitiesByType.set('IfcRelAssociatesClassification', [600]);

    const data = extractClassifications(entities, entitiesByType);

    expect(data.associations.length).toBe(1);

    const assoc = data.associations[0];
    expect(assoc.classificationId).toBe(200);
    expect(assoc.relatedObjects).toEqual([500, 501]);
  });

  it('should get classifications for element', () => {
    const entities = new Map<number, IfcEntity>();

    entities.set(200, {
      expressId: 200,
      type: 'IfcClassificationReference',
      attributes: [null, 'Pr_60_10_32', 'External wall', null, null, null],
    });

    entities.set(201, {
      expressId: 201,
      type: 'IfcClassificationReference',
      attributes: [null, 'EF_25_10', 'Load bearing', null, null, null],
    });

    entities.set(600, {
      expressId: 600,
      type: 'IfcRelAssociatesClassification',
      attributes: ['RelId', null, null, null, ['#500'], '#200'],
    });

    entities.set(601, {
      expressId: 601,
      type: 'IfcRelAssociatesClassification',
      attributes: ['RelId', null, null, null, ['#500'], '#201'],
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcClassificationReference', [200, 201]);
    entitiesByType.set('IfcRelAssociatesClassification', [600, 601]);

    const data = extractClassifications(entities, entitiesByType);

    const classifications = getClassificationsForElement(500, data);

    expect(classifications).toHaveLength(2);
    expect(classifications[0].identification).toBe('Pr_60_10_32');
    expect(classifications[1].identification).toBe('EF_25_10');
  });

  it('should get classification code for element', () => {
    const entities = new Map<number, IfcEntity>();

    entities.set(200, {
      expressId: 200,
      type: 'IfcClassificationReference',
      attributes: [null, 'Pr_60_10_32', 'External wall', null, null, null],
    });

    entities.set(600, {
      expressId: 600,
      type: 'IfcRelAssociatesClassification',
      attributes: ['RelId', null, null, null, ['#500'], '#200'],
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcClassificationReference', [200]);
    entitiesByType.set('IfcRelAssociatesClassification', [600]);

    const data = extractClassifications(entities, entitiesByType);

    const code = getClassificationCodeForElement(500, data);
    expect(code).toBe('Pr_60_10_32');
  });

  it('should get classification path', () => {
    const entities = new Map<number, IfcEntity>();

    // Root classification
    entities.set(100, {
      expressId: 100,
      type: 'IfcClassification',
      attributes: ['BuildingSmart', null, null, 'Uniclass 2015', null, null, null],
    });

    // Level 1: Pr (Products)
    entities.set(200, {
      expressId: 200,
      type: 'IfcClassificationReference',
      attributes: [null, 'Pr', 'Products', '#100', null, null],
    });

    // Level 2: Pr_60 (Walls and barriers)
    entities.set(201, {
      expressId: 201,
      type: 'IfcClassificationReference',
      attributes: [null, 'Pr_60', 'Walls and barriers', '#200', null, null],
    });

    // Level 3: Pr_60_10 (Walls)
    entities.set(202, {
      expressId: 202,
      type: 'IfcClassificationReference',
      attributes: [null, 'Pr_60_10', 'Walls', '#201', null, null],
    });

    // Level 4: Pr_60_10_32 (External walls)
    entities.set(203, {
      expressId: 203,
      type: 'IfcClassificationReference',
      attributes: [null, 'Pr_60_10_32', 'External walls', '#202', null, null],
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcClassification', [100]);
    entitiesByType.set('IfcClassificationReference', [200, 201, 202, 203]);

    const data = extractClassifications(entities, entitiesByType);

    const path = getClassificationPath(203, data);

    expect(path).toEqual([
      'Uniclass 2015',
      'Pr',
      'Pr_60',
      'Pr_60_10',
      'Pr_60_10_32',
    ]);
  });

  it('should group elements by classification', () => {
    const entities = new Map<number, IfcEntity>();

    entities.set(200, {
      expressId: 200,
      type: 'IfcClassificationReference',
      attributes: [null, 'Pr_60_10_32', 'External wall', null, null, null],
    });

    entities.set(201, {
      expressId: 201,
      type: 'IfcClassificationReference',
      attributes: [null, 'Pr_60_10_36', 'Internal wall', null, null, null],
    });

    entities.set(600, {
      expressId: 600,
      type: 'IfcRelAssociatesClassification',
      attributes: ['RelId', null, null, null, ['#500', '#501'], '#200'],
    });

    entities.set(601, {
      expressId: 601,
      type: 'IfcRelAssociatesClassification',
      attributes: ['RelId', null, null, null, ['#502'], '#201'],
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcClassificationReference', [200, 201]);
    entitiesByType.set('IfcRelAssociatesClassification', [600, 601]);

    const data = extractClassifications(entities, entitiesByType);

    const groups = groupElementsByClassification(data);

    expect(groups.size).toBe(2);
    expect(groups.get('Pr_60_10_32')).toEqual([500, 501]);
    expect(groups.get('Pr_60_10_36')).toEqual([502]);
  });

  it('should get classification system name', () => {
    const entities = new Map<number, IfcEntity>();

    entities.set(100, {
      expressId: 100,
      type: 'IfcClassification',
      attributes: [null, null, null, 'Omniclass', null, null, null],
    });

    entities.set(200, {
      expressId: 200,
      type: 'IfcClassificationReference',
      attributes: [null, '23-11 00 00', 'Columns', '#100', null, null],
    });

    const entitiesByType = new Map<string, number[]>();
    entitiesByType.set('IfcClassification', [100]);
    entitiesByType.set('IfcClassificationReference', [200]);

    const data = extractClassifications(entities, entitiesByType);

    const systemName = getClassificationSystemName(200, data);
    expect(systemName).toBe('Omniclass');
  });
});
