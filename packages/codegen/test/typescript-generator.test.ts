/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for TypeScript generator
 */

import { describe, it, expect } from 'vitest';
import { parseExpressSchema } from '../src/express-parser.js';
import { generateTypeScript } from '../src/typescript-generator.js';

describe('TypeScript Generator', () => {
  describe('Entity interface generation', () => {
    it('should generate simple interface', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        ENTITY IfcRoot;
          GlobalId : IfcGloballyUniqueId;
          Name : OPTIONAL IfcLabel;
        END_ENTITY;

        END_SCHEMA;
      `);

      const code = generateTypeScript(schema);

      expect(code.entities).toContain('export interface IfcRoot');
      expect(code.entities).toContain('GlobalId: IfcGloballyUniqueId;');
      expect(code.entities).toContain('Name?: IfcLabel;');
    });

    it('ends entity output with one POSIX newline', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        ENTITY IfcRoot;
        END_ENTITY;

        END_SCHEMA;
      `);

      const code = generateTypeScript(schema);

      expect(code.entities).toMatch(/[^\n]\n$/);
    });

    it('should generate interface with inheritance', () => {
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

      const code = generateTypeScript(schema);

      expect(code.entities).toContain('export interface IfcObject extends IfcRoot');
      expect(code.entities).toContain('ObjectType?: IfcLabel;');
    });

    it('should generate JSDoc comments', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        ENTITY IfcRoot
          ABSTRACT;
          GlobalId : IfcGloballyUniqueId;
        END_ENTITY;

        END_SCHEMA;
      `);

      const code = generateTypeScript(schema);

      expect(code.entities).toContain('/**');
      expect(code.entities).toContain('* IfcRoot');
      expect(code.entities).toContain('* @abstract');
    });

    it('should handle array attributes', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        ENTITY IfcTest;
          Items : LIST [1:?] OF IfcCartesianPoint;
          Coords : ARRAY [1:3] OF REAL;
          Tags : SET [0:?] OF IfcLabel;
        END_ENTITY;

        END_SCHEMA;
      `);

      const code = generateTypeScript(schema);

      expect(code.entities).toContain('Items: IfcCartesianPoint[];');
      expect(code.entities).toContain('Coords: number[];');
      expect(code.entities).toContain('Tags: IfcLabel[];');
    });

    it('should map EXPRESS types to TypeScript types', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        ENTITY IfcTest;
          RealValue : REAL;
          IntValue : INTEGER;
          BoolValue : BOOLEAN;
          StrValue : STRING;
        END_ENTITY;

        END_SCHEMA;
      `);

      const code = generateTypeScript(schema);

      expect(code.entities).toContain('RealValue: number;');
      expect(code.entities).toContain('IntValue: number;');
      expect(code.entities).toContain('BoolValue: boolean;');
      expect(code.entities).toContain('StrValue: string;');
    });
  });

  describe('Type alias generation', () => {
    it('should generate type aliases', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        TYPE IfcLabel = STRING;
        END_TYPE;

        TYPE IfcLengthMeasure = REAL;
        END_TYPE;

        END_SCHEMA;
      `);

      const code = generateTypeScript(schema);

      expect(code.types).toContain('export type IfcLabel = string;');
      expect(code.types).toContain('export type IfcLengthMeasure = number;');
    });
  });

  describe('Enum generation', () => {
    it('should generate enums', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        TYPE IfcWallTypeEnum = ENUMERATION OF
          (MOVABLE
          ,PARAPET
          ,SOLIDWALL);
        END_TYPE;

        END_SCHEMA;
      `);

      const code = generateTypeScript(schema);

      expect(code.enums).toContain('export enum IfcWallTypeEnum');
      expect(code.enums).toContain("MOVABLE = 'MOVABLE'");
      expect(code.enums).toContain("PARAPET = 'PARAPET'");
      expect(code.enums).toContain("SOLIDWALL = 'SOLIDWALL'");
    });
  });

  describe('Select type generation', () => {
    it('should generate union types', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        TYPE IfcValue = SELECT
          (IfcLabel
          ,IfcInteger
          ,IfcReal);
        END_TYPE;

        END_SCHEMA;
      `);

      const code = generateTypeScript(schema);

      expect(code.selects).toContain('export type IfcValue =');
      expect(code.selects).toContain('IfcLabel | IfcInteger | IfcReal');
    });
  });

  describe('Schema registry generation', () => {
    it('should generate schema registry', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        ENTITY IfcRoot;
          GlobalId : IfcGloballyUniqueId;
          Name : OPTIONAL IfcLabel;
        END_ENTITY;

        END_SCHEMA;
      `);

      const code = generateTypeScript(schema);

      expect(code.schemaRegistry).toContain('export const SCHEMA_REGISTRY');
      expect(code.schemaRegistry).toContain("name: 'TEST'");
      expect(code.schemaRegistry).toContain('IfcRoot: {');
      expect(code.schemaRegistry).toContain("name: 'IfcRoot'");
      expect(code.schemaRegistry).toContain("name: 'GlobalId'");
    });

    it('should include inheritance chain in registry', () => {
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

      const code = generateTypeScript(schema);

      expect(code.schemaRegistry).toContain("inheritanceChain: ['IfcRoot', 'IfcObject']");
    });

    it('should include allAttributes in registry', () => {
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

      const code = generateTypeScript(schema);

      // IfcObject should have allAttributes including GlobalId from parent
      expect(code.schemaRegistry).toContain('allAttributes: [');
      expect(code.schemaRegistry).toMatch(/IfcObject[\s\S]*allAttributes:[\s\S]*GlobalId/);
    });

    it('should generate helper functions', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;
        ENTITY IfcRoot;
          GlobalId : IfcGloballyUniqueId;
        END_ENTITY;
        END_SCHEMA;
      `);

      const code = generateTypeScript(schema);

      expect(code.schemaRegistry).toContain('export function getEntityMetadata');
      expect(code.schemaRegistry).toContain('export function getAllAttributesForEntity');
      expect(code.schemaRegistry).toContain('export function getInheritanceChainForEntity');
      expect(code.schemaRegistry).toContain('export function isKnownEntity');
    });
  });

  describe('Full generation', () => {
    it('should generate all code sections', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        TYPE IfcLabel = STRING;
        END_TYPE;

        TYPE IfcWallTypeEnum = ENUMERATION OF
          (MOVABLE
          ,SOLIDWALL);
        END_TYPE;

        TYPE IfcValue = SELECT
          (IfcLabel
          ,IfcInteger);
        END_TYPE;

        ENTITY IfcRoot;
          GlobalId : IfcGloballyUniqueId;
          Name : OPTIONAL IfcLabel;
        END_ENTITY;

        ENTITY IfcWall
          SUBTYPE OF (IfcRoot);
          PredefinedType : OPTIONAL IfcWallTypeEnum;
        END_ENTITY;

        END_SCHEMA;
      `);

      const code = generateTypeScript(schema);

      // Check all sections are generated
      expect(code.entities).toBeTruthy();
      expect(code.types).toBeTruthy();
      expect(code.enums).toBeTruthy();
      expect(code.selects).toBeTruthy();
      expect(code.schemaRegistry).toBeTruthy();

      // Check content
      expect(code.entities).toContain('export interface IfcRoot');
      expect(code.entities).toContain('export interface IfcWall extends IfcRoot');
      expect(code.types).toContain('export type IfcLabel = string');
      expect(code.enums).toContain('export enum IfcWallTypeEnum');
      expect(code.selects).toContain('export type IfcValue');
      expect(code.schemaRegistry).toContain('SCHEMA_REGISTRY');
    });
  });

  describe('Edge cases', () => {
    it('should handle entities with no attributes', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        ENTITY IfcEmpty;
        END_ENTITY;

        END_SCHEMA;
      `);

      const code = generateTypeScript(schema);

      expect(code.entities).toContain('export interface IfcEmpty');
    });

    it('should handle empty schema', () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;
        END_SCHEMA;
      `);

      const code = generateTypeScript(schema);

      expect(code.entities).toBeTruthy();
      expect(code.types).toBeTruthy();
      expect(code.enums).toBeTruthy();
      expect(code.selects).toBeTruthy();
      expect(code.schemaRegistry).toBeTruthy();
    });
  });
});
