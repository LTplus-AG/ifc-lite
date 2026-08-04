/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for EXPRESS parser
 */

import { describe, it, expect } from 'vitest';
import { parseExpressSchema, getAllAttributes, getInheritanceChain } from '../src/express-parser.js';

describe('EXPRESS Parser', () => {
  describe('Schema parsing', () => {
    it('should parse schema name', () => {
      const schema = parseExpressSchema(`
        SCHEMA IFC4_ADD2_TC1;
        END_SCHEMA;
      `);

      expect(schema.name).toBe('IFC4_ADD2_TC1');
    });

    it('should handle comments', () => {
      const schema = parseExpressSchema(`
        (* This is a comment *)
        SCHEMA TEST;
        (* Multi-line
           comment
        *)
        END_SCHEMA;
      `);

      expect(schema.name).toBe('TEST');
    });
  });

  describe('Entity parsing', () => {
    it('should parse simple entity', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        ENTITY IfcRoot;
          GlobalId : IfcGloballyUniqueId;
          Name : OPTIONAL IfcLabel;
        END_ENTITY;

        END_SCHEMA;
      `);

      expect(schema.entities).toHaveLength(1);
      expect(schema.entities[0].name).toBe('IfcRoot');
      expect(schema.entities[0].attributes).toHaveLength(2);

      const globalId = schema.entities[0].attributes[0];
      expect(globalId.name).toBe('GlobalId');
      expect(globalId.type).toBe('IfcGloballyUniqueId');
      expect(globalId.optional).toBe(false);

      const name = schema.entities[0].attributes[1];
      expect(name.name).toBe('Name');
      expect(name.type).toBe('IfcLabel');
      expect(name.optional).toBe(true);
    });

    it('should parse entity with inheritance', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        ENTITY IfcRoot;
          GlobalId : IfcGloballyUniqueId;
        END_ENTITY;

        ENTITY IfcObject
          SUBTYPE OF (IfcRoot);
          ObjectType : OPTIONAL IfcLabel;
        END_ENTITY;

        END_SCHEMA;
      `);

      expect(schema.entities).toHaveLength(2);

      const ifcObject = schema.entities.find(e => e.name === 'IfcObject');
      expect(ifcObject).toBeDefined();
      expect(ifcObject?.supertype).toBe('IfcRoot');
    });

    it('should parse abstract entity', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        ENTITY IfcRoot
          ABSTRACT SUPERTYPE OF (ONEOF
            (IfcObject));
          GlobalId : IfcGloballyUniqueId;
        END_ENTITY;

        END_SCHEMA;
      `);

      const root = schema.entities[0];
      expect(root.isAbstract).toBe(true);
      expect(root.supertypeOf).toEqual(['IfcObject']);
    });

    it('should parse LIST attributes', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        ENTITY IfcTest;
          Items : LIST [1:?] OF IfcCartesianPoint;
        END_ENTITY;

        END_SCHEMA;
      `);

      const attr = schema.entities[0].attributes[0];
      expect(attr.name).toBe('Items');
      expect(attr.type).toBe('IfcCartesianPoint');
      expect(attr.isList).toBe(true);
      expect(attr.arrayBounds).toEqual([1, Infinity]); // ? becomes Infinity
    });

    it('should parse ARRAY attributes', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        ENTITY IfcTest;
          Coords : ARRAY [1:3] OF REAL;
        END_ENTITY;

        END_SCHEMA;
      `);

      const attr = schema.entities[0].attributes[0];
      expect(attr.name).toBe('Coords');
      expect(attr.type).toBe('REAL');
      expect(attr.isArray).toBe(true);
      expect(attr.arrayBounds).toEqual([1, 3]);
    });

    it('should parse SET attributes', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        ENTITY IfcTest;
          Tags : SET [1:?] OF IfcLabel;
        END_ENTITY;

        END_SCHEMA;
      `);

      const attr = schema.entities[0].attributes[0];
      expect(attr.name).toBe('Tags');
      expect(attr.type).toBe('IfcLabel');
      expect(attr.isSet).toBe(true);
    });
  });

  describe('Type parsing', () => {
    it('should parse simple types', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        TYPE IfcLabel = STRING;
        END_TYPE;

        TYPE IfcLengthMeasure = REAL;
        END_TYPE;

        END_SCHEMA;
      `);

      expect(schema.types).toHaveLength(2);

      const label = schema.types.find(t => t.name === 'IfcLabel');
      expect(label?.underlyingType).toBe('STRING');

      const length = schema.types.find(t => t.name === 'IfcLengthMeasure');
      expect(length?.underlyingType).toBe('REAL');
    });

    it('should parse types with WHERE clauses', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        TYPE IfcPositiveInteger = INTEGER;
         WHERE
          WR1 : SELF > 0;
        END_TYPE;

        END_SCHEMA;
      `);

      const type = schema.types[0];
      expect(type.whereRules).toBeDefined();
      expect(type.whereRules).toHaveLength(1);
    });
  });

  describe('Enum parsing', () => {
    it('should parse enumerations', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        TYPE IfcWallTypeEnum = ENUMERATION OF
          (MOVABLE
          ,PARAPET
          ,PARTITIONING
          ,SOLIDWALL);
        END_TYPE;

        END_SCHEMA;
      `);

      expect(schema.enums).toHaveLength(1);

      const enumDef = schema.enums[0];
      expect(enumDef.name).toBe('IfcWallTypeEnum');
      expect(enumDef.values).toEqual([
        'MOVABLE',
        'PARAPET',
        'PARTITIONING',
        'SOLIDWALL',
      ]);
    });

    it('should handle multi-line enums', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        TYPE IfcColorEnum = ENUMERATION OF
          (RED,
           GREEN,
           BLUE);
        END_TYPE;

        END_SCHEMA;
      `);

      const enumDef = schema.enums[0];
      expect(enumDef.values).toEqual(['RED', 'GREEN', 'BLUE']);
    });
  });

  describe('Select parsing', () => {
    it('should parse SELECT types', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        TYPE IfcValue = SELECT
          (IfcLabel
          ,IfcInteger
          ,IfcReal);
        END_TYPE;

        END_SCHEMA;
      `);

      expect(schema.selects).toHaveLength(1);

      const select = schema.selects[0];
      expect(select.name).toBe('IfcValue');
      expect(select.types).toEqual(['IfcLabel', 'IfcInteger', 'IfcReal']);
    });
  });

  describe('Inheritance utilities', () => {
    it('should get all attributes including inherited', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        ENTITY IfcRoot;
          GlobalId : IfcGloballyUniqueId;
          Name : OPTIONAL IfcLabel;
        END_ENTITY;

        ENTITY IfcObject
          SUBTYPE OF (IfcRoot);
          ObjectType : OPTIONAL IfcLabel;
        END_ENTITY;

        ENTITY IfcProduct
          SUBTYPE OF (IfcObject);
          Tag : OPTIONAL IfcLabel;
        END_ENTITY;

        END_SCHEMA;
      `);

      const product = schema.entities.find(e => e.name === 'IfcProduct')!;
      const allAttrs = getAllAttributes(product, schema);

      expect(allAttrs).toHaveLength(4);
      expect(allAttrs.map(a => a.name)).toEqual([
        'GlobalId',  // IfcRoot
        'Name',      // IfcRoot
        'ObjectType', // IfcObject
        'Tag',       // IfcProduct
      ]);
    });

    it('should get inheritance chain', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        ENTITY IfcRoot;
          GlobalId : IfcGloballyUniqueId;
        END_ENTITY;

        ENTITY IfcObject
          SUBTYPE OF (IfcRoot);
          ObjectType : OPTIONAL IfcLabel;
        END_ENTITY;

        ENTITY IfcProduct
          SUBTYPE OF (IfcObject);
          Tag : OPTIONAL IfcLabel;
        END_ENTITY;

        END_SCHEMA;
      `);

      const product = schema.entities.find(e => e.name === 'IfcProduct')!;
      const chain = getInheritanceChain(product, schema);

      expect(chain).toEqual(['IfcRoot', 'IfcObject', 'IfcProduct']);
    });
  });

  describe('Attribute section boundary', () => {
    /**
     * The attributes section ends at the FIRST of WHERE / DERIVE / INVERSE /
     * UNIQUE. Every existing fixture had at most one of those keywords, so
     * "first" and "last" were the same index and the choice was untestable —
     * picking the last one instead swallows the INVERSE/DERIVE block and turns
     * its lines into bogus attributes.
     */
    it('stops at the FIRST section keyword when several are present', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        ENTITY IfcTest
          SUBTYPE OF (IfcRoot);
          RealAttr : IfcLabel;
         DERIVE
          DerivedAttr : IfcLabel := 'x';
         INVERSE
          InverseAttr : SET [0:?] OF IfcRelAssigns FOR RelatedObjects;
         WHERE
          WR1 : EXISTS(RealAttr);
        END_ENTITY;

        END_SCHEMA;
      `);

      const test = schema.entities[0];
      expect(test.attributes.map(a => a.name)).toEqual(['RealAttr']);
      // Both directions: the derived and inverse names must not leak in.
      expect(test.attributes.map(a => a.name)).not.toContain('DerivedAttr');
      expect(test.attributes.map(a => a.name)).not.toContain('InverseAttr');
    });
  });

  describe('Real IFC schema parsing', () => {
    it('should parse IfcWall from real schema', () => {
      const schema = parseExpressSchema(`
        SCHEMA IFC4;

        ENTITY IfcBuildingElement
          SUBTYPE OF (IfcElement);
        END_ENTITY;

        ENTITY IfcWall
          SUPERTYPE OF (ONEOF
            (IfcWallElementedCase
            ,IfcWallStandardCase))
          SUBTYPE OF (IfcBuildingElement);
          PredefinedType : OPTIONAL IfcWallTypeEnum;
         WHERE
          CorrectPredefinedType : NOT(EXISTS(PredefinedType)) OR
            (PredefinedType <> IfcWallTypeEnum.USERDEFINED);
        END_ENTITY;

        END_SCHEMA;
      `);

      const wall = schema.entities.find(e => e.name === 'IfcWall')!;
      expect(wall).toBeDefined();
      expect(wall.supertype).toBe('IfcBuildingElement');
      expect(wall.supertypeOf).toContain('IfcWallStandardCase');
      expect(wall.attributes).toHaveLength(1);
      expect(wall.attributes[0].name).toBe('PredefinedType');
      expect(wall.whereRules).toBeDefined();
    });
  });
});
