/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for TypeScript generator
 */

import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { parseExpressSchema } from '../src/express-parser.js';
import { generateTypeScript } from '../src/typescript-generator.js';
import type { RegistryData, RegistryEntity, RegistryAttribute } from '../src/schema-registry-codec.js';

/** Run an emitted schema-registry.ts and return what it exports. The registry
 *  is a compact string decoded at run time, so its content is only visible by
 *  running it. */
async function emittedRegistry(code: string): Promise<{
  SCHEMA_REGISTRY: RegistryData;
  getSchemaRegistry(): RegistryData;
  getEntityMetadata(name: string): RegistryEntity | undefined;
  getAllAttributesForEntity(name: string): RegistryAttribute[];
  getInheritanceChainForEntity(name: string): string[];
  isKnownEntity(name: string): boolean;
}> {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

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

    /**
     * attr.type reaches two emitters: the interface property type, where tsc
     * would reject a stray `UNIQUE`, and schema-registry.ts, where it is
     * emitted inside a string literal that no typecheck can ever look at.
     * Assert both, so a leak cannot hide in the quiet channel.
     */
    it('never emits an EXPRESS element qualifier into a type or the registry', async () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        ENTITY EntQualified;
          SymbolicBound : LIST [1:Dim] OF UNIQUE IfcGridAxis;
          Unbounded : LIST OF UNIQUE IfcGridAxis;
          OptionalUnique : ARRAY [1:3] OF OPTIONAL UNIQUE IfcGridAxis;
        END_ENTITY;

        END_SCHEMA;
      `);

      const code = generateTypeScript(schema);

      expect(code.entities).not.toMatch(/\bUNIQUE\b/);
      expect(code.entities).toContain('SymbolicBound: IfcGridAxis[];');
      expect(code.schemaRegistry).not.toMatch(/\bUNIQUE\b/);
      // Paired with the negative above so an empty or attribute-less registry
      // cannot satisfy it by having nothing to leak.
      const { SCHEMA_REGISTRY } = await emittedRegistry(code.schemaRegistry);
      const types = SCHEMA_REGISTRY.entities.EntQualified.attributes.map((a) => [a.name, a.type]);
      expect(types).toEqual([['SymbolicBound', 'IfcGridAxis'], ['Unbounded', 'IfcGridAxis'], ['OptionalUnique', 'IfcGridAxis']]);
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
    it('should generate schema registry', async () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;

        ENTITY IfcRoot;
          GlobalId : IfcGloballyUniqueId;
          Name : OPTIONAL IfcLabel;
        END_ENTITY;

        END_SCHEMA;
      `);

      const code = generateTypeScript(schema);

      const mod = await emittedRegistry(code.schemaRegistry);
      expect(mod.SCHEMA_REGISTRY.name).toBe('TEST');
      expect(Object.keys(mod.SCHEMA_REGISTRY.entities)).toEqual(['IfcRoot']);
      expect(mod.SCHEMA_REGISTRY.entities.IfcRoot).toEqual({
        name: 'IfcRoot',
        isAbstract: false,
        attributes: [
          { name: 'GlobalId', type: 'IfcGloballyUniqueId', optional: false, isArray: false, isList: false, isSet: false },
          { name: 'Name', type: 'IfcLabel', optional: true, isArray: false, isList: false, isSet: false },
        ],
        allAttributes: [
          { name: 'GlobalId', type: 'IfcGloballyUniqueId', optional: false, isArray: false, isList: false, isSet: false },
          { name: 'Name', type: 'IfcLabel', optional: true, isArray: false, isList: false, isSet: false },
        ],
        inheritanceChain: ['IfcRoot'],
      });
      // A root entity has no `parent` key at all, as the literal registry had.
      expect(Object.keys(mod.SCHEMA_REGISTRY.entities.IfcRoot)).toEqual(['name', 'isAbstract', 'attributes', 'allAttributes', 'inheritanceChain']);
      // Decoded once: the getter and the constant are the same object.
      expect(mod.getSchemaRegistry()).toBe(mod.SCHEMA_REGISTRY);
    });

    it('should include inheritance chain in registry', async () => {
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

      const { SCHEMA_REGISTRY } = await emittedRegistry(code.schemaRegistry);
      expect(SCHEMA_REGISTRY.entities.IfcObject.inheritanceChain).toEqual(['IfcRoot', 'IfcObject']);
      expect(SCHEMA_REGISTRY.entities.IfcObject.parent).toBe('IfcRoot');
    });

    it('should include allAttributes in registry', async () => {
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
      const { SCHEMA_REGISTRY } = await emittedRegistry(code.schemaRegistry);
      const object = SCHEMA_REGISTRY.entities.IfcObject;
      expect(object.attributes.map((a) => a.name)).toEqual(['ObjectType']);
      expect(object.allAttributes?.map((a) => a.name)).toEqual(['GlobalId', 'ObjectType']);
      // Inherited entries are the child's own objects, not shared with the parent.
      expect(object.allAttributes?.[0]).not.toBe(SCHEMA_REGISTRY.entities.IfcRoot.allAttributes?.[0]);
    });

    it('should generate helper functions', async () => {
      const schema = parseExpressSchema(`
        SCHEMA TEST;
        ENTITY IfcRoot;
          GlobalId : IfcGloballyUniqueId;
        END_ENTITY;
        END_SCHEMA;
      `);

      const code = generateTypeScript(schema);

      const mod = await emittedRegistry(code.schemaRegistry);
      expect(mod.getEntityMetadata('IFCROOT')?.name).toBe('IfcRoot');
      expect(mod.getAllAttributesForEntity('IfcRoot').map((a) => a.name)).toEqual(['GlobalId']);
      expect(mod.getInheritanceChainForEntity('IFCROOT')).toEqual(['IfcRoot']);
      expect(mod.isKnownEntity('IfcRoot')).toBe(true);
      // Own-property lookups only (#3063).
      expect(mod.isKnownEntity('constructor')).toBe(false);
      expect(mod.getEntityMetadata('__proto__')).toBeUndefined();
    });
  });

  describe('Full generation', () => {
    it('should generate all code sections', async () => {
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
      const { SCHEMA_REGISTRY } = await emittedRegistry(code.schemaRegistry);
      expect(SCHEMA_REGISTRY.enums.IfcWallTypeEnum).toEqual(['MOVABLE', 'SOLIDWALL']);
      expect(SCHEMA_REGISTRY.selects.IfcValue).toEqual(['IfcLabel', 'IfcInteger']);
      expect(SCHEMA_REGISTRY.types.IfcLabel).toBe('STRING');
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
