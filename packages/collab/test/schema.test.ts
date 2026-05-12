/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  assertSchemaInvariants,
  createCollabDoc,
  entitiesMap,
  geometryMap,
  relationshipsMap,
} from '../src/doc/schema.js';
import {
  createEntity,
  deleteAttribute,
  deleteEntity,
  entityToJSON,
  getAttribute,
  getPropertyValue,
  moveEntity,
  promoteEntityType,
  setAttribute,
  setChild,
  setPropertyValue,
} from '../src/doc/entity.js';
import {
  addTarget,
  cascadeDeleteRelationships,
  createRelationship,
  getTargets,
  removeTarget,
} from '../src/doc/relationship.js';
import { createGeometry, setGeometryParam, bumpGeometryVersion, geometryToJSON } from '../src/doc/geometry.js';

describe('schema', () => {
  it('createCollabDoc produces all three top-level shared types', () => {
    const doc = createCollabDoc();
    expect(entitiesMap(doc)).toBeInstanceOf(Y.Map);
    expect(relationshipsMap(doc)).toBeInstanceOf(Y.Map);
    expect(geometryMap(doc)).toBeInstanceOf(Y.Map);
    expect(() => assertSchemaInvariants(doc)).not.toThrow();
  });
});

describe('entity ops', () => {
  it('creates an entity with attributes, children, inherits, meta', () => {
    const doc = createCollabDoc();
    const wallPath = 'wall-1';
    createEntity(doc, wallPath, {
      ifcClass: 'IfcWall',
      attributes: { 'bsi::ifc::class': { code: 'IfcWall' } },
      children: { Body: 'body-1' },
      inherits: { ProjectShell: 'shell-1' },
    });

    const json = entityToJSON(entitiesMap(doc).get(wallPath)!);
    expect(json.attributes['bsi::ifc::class']).toEqual({ code: 'IfcWall' });
    expect(json.children).toEqual({ Body: 'body-1' });
    expect(json.inherits).toEqual({ ProjectShell: 'shell-1' });
    expect(json.meta.ifcClass).toBe('IfcWall');
  });

  it('setAttribute / deleteAttribute round-trip', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'w', { ifcClass: 'IfcWall' });
    setAttribute(doc, 'w', 'Name', 'Wall-A');
    expect(getAttribute(doc, 'w', 'Name')).toBe('Wall-A');
    deleteAttribute(doc, 'w', 'Name');
    expect(getAttribute(doc, 'w', 'Name')).toBeUndefined();
  });

  it('setPropertyValue stores typed values inside Psets', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'w', { ifcClass: 'IfcWall' });
    setPropertyValue(doc, 'w', 'Pset_WallCommon', 'FireRating', {
      type: 'IfcLabel',
      value: 'EI60',
    });
    const v = getPropertyValue(doc, 'w', 'Pset_WallCommon', 'FireRating');
    expect(v?.value).toBe('EI60');
    expect(v?.type).toBe('IfcLabel');
  });

  it('moveEntity updates both endpoints atomically', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'storey-1');
    createEntity(doc, 'storey-2');
    createEntity(doc, 'wall-1');
    setChild(doc, 'storey-1', 'Wall', 'wall-1');
    moveEntity(doc, 'wall-1', 'storey-1', 'storey-2', 'Wall');

    const s1 = entityToJSON(entitiesMap(doc).get('storey-1')!);
    const s2 = entityToJSON(entitiesMap(doc).get('storey-2')!);
    expect(s1.children).toEqual({});
    expect(s2.children).toEqual({ Wall: 'wall-1' });
  });

  it('promoteEntityType deletes the old path and seeds the new with previousPath', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'old', {
      ifcClass: 'IfcWall',
      attributes: { Name: 'Wall-1' },
    });
    setChild(doc, 'old', 'Body', 'body-1');
    promoteEntityType(doc, 'old', 'new', 'IfcCurtainWall');
    expect(entitiesMap(doc).has('old')).toBe(false);
    const newJson = entityToJSON(entitiesMap(doc).get('new')!);
    expect(newJson.meta.previousPath).toBe('old');
    expect(newJson.meta.ifcClass).toBe('IfcCurtainWall');
    expect(newJson.children).toEqual({ Body: 'body-1' });
  });

  it('deleteEntity removes the entity', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'gone');
    deleteEntity(doc, 'gone');
    expect(entitiesMap(doc).has('gone')).toBe(false);
  });
});

describe('relationship ops', () => {
  it('add/remove targets and cascade delete', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall');
    createEntity(doc, 'storey');
    createEntity(doc, 'space');
    createRelationship(doc, 'rel-1', {
      ifcClass: 'IfcRelContainedInSpatialStructure',
      source: 'storey',
      targets: ['wall'],
    });
    addTarget(doc, 'rel-1', 'space');
    expect(getTargets(doc, 'rel-1')).toEqual(['wall', 'space']);
    removeTarget(doc, 'rel-1', 'wall');
    expect(getTargets(doc, 'rel-1')).toEqual(['space']);

    cascadeDeleteRelationships(doc, 'space');
    expect(getTargets(doc, 'rel-1')).toEqual([]);
  });

  it('cascade-deletes relationships sourced at the entity', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'a');
    createEntity(doc, 'b');
    createRelationship(doc, 'rel', {
      ifcClass: 'IfcRelAggregates',
      source: 'a',
      targets: ['b'],
    });
    cascadeDeleteRelationships(doc, 'a');
    // relationship is gone
    const rels = doc.getMap('relationships');
    expect(rels.has('rel')).toBe(false);
  });
});

describe('geometry ops', () => {
  it('stores params + bumps a per-peer version vector', () => {
    const doc = createCollabDoc();
    createGeometry(doc, 'g1', {
      type: 'parametric',
      source: 'extruded-area-solid',
      params: { width: 0.2, height: 3 },
    });
    setGeometryParam(doc, 'g1', 'depth', 5.5);
    bumpGeometryVersion(doc, 'g1', doc.clientID);
    bumpGeometryVersion(doc, 'g1', doc.clientID);
    const json = geometryToJSON(doc.getMap('geometry').get('g1') as Y.Map<unknown>);
    expect(json.params.depth).toBe(5.5);
    expect(json.versionVector[String(doc.clientID)]).toBe(2);
  });
});
