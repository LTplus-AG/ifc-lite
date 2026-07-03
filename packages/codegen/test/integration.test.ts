/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Integration tests - full code generation from real schemas
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseExpressSchema } from '../src/express-parser.js';
import { generateTypeScript } from '../src/typescript-generator.js';

describe('Integration Tests', () => {
  describe('IFC4 ADD2 TC1 Schema', () => {
    it('should parse IFC4 schema without errors', () => {
      const schemaPath = join(process.cwd(), 'schemas', 'IFC4_ADD2_TC1.exp');
      const content = readFileSync(schemaPath, 'utf-8');

      expect(() => {
        parseExpressSchema(content);
      }).not.toThrow();
    });

    it('should find expected entities in IFC4', () => {
      const schemaPath = join(process.cwd(), 'schemas', 'IFC4_ADD2_TC1.exp');
      const content = readFileSync(schemaPath, 'utf-8');
      const schema = parseExpressSchema(content);

      // Check for key entities
      const entityNames = schema.entities.map(e => e.name);

      expect(entityNames).toContain('IfcRoot');
      expect(entityNames).toContain('IfcProject');
      expect(entityNames).toContain('IfcBuilding');
      expect(entityNames).toContain('IfcWall');
      expect(entityNames).toContain('IfcDoor');
      expect(entityNames).toContain('IfcWindow');
      expect(entityNames).toContain('IfcSlab');
      expect(entityNames).toContain('IfcColumn');
      expect(entityNames).toContain('IfcBeam');

      console.log(`\n✓ Parsed ${schema.entities.length} entities from IFC4`);
    });

    it('should find expected types in IFC4', () => {
      const schemaPath = join(process.cwd(), 'schemas', 'IFC4_ADD2_TC1.exp');
      const content = readFileSync(schemaPath, 'utf-8');
      const schema = parseExpressSchema(content);

      // Check for key types
      const typeNames = schema.types.map(t => t.name);

      expect(typeNames).toContain('IfcLabel');
      expect(typeNames).toContain('IfcText');
      expect(typeNames).toContain('IfcLengthMeasure');
      expect(typeNames).toContain('IfcAreaMeasure');
      expect(typeNames).toContain('IfcVolumeMeasure');

      console.log(`✓ Parsed ${schema.types.length} types from IFC4`);
    });

    it('should find expected enums in IFC4', () => {
      const schemaPath = join(process.cwd(), 'schemas', 'IFC4_ADD2_TC1.exp');
      const content = readFileSync(schemaPath, 'utf-8');
      const schema = parseExpressSchema(content);

      // Check for key enums
      const enumNames = schema.enums.map(e => e.name);

      expect(enumNames).toContain('IfcWallTypeEnum');
      expect(enumNames).toContain('IfcDoorTypeEnum');
      expect(enumNames).toContain('IfcWindowTypeEnum');

      console.log(`✓ Parsed ${schema.enums.length} enums from IFC4`);
    });

    it('should find expected selects in IFC4', () => {
      const schemaPath = join(process.cwd(), 'schemas', 'IFC4_ADD2_TC1.exp');
      const content = readFileSync(schemaPath, 'utf-8');
      const schema = parseExpressSchema(content);

      // Check for key selects
      const selectNames = schema.selects.map(s => s.name);

      expect(selectNames).toContain('IfcValue');

      console.log(`✓ Parsed ${schema.selects.length} select types from IFC4`);
    });

    it('should correctly parse IfcWall with all attributes', () => {
      const schemaPath = join(process.cwd(), 'schemas', 'IFC4_ADD2_TC1.exp');
      const content = readFileSync(schemaPath, 'utf-8');
      const schema = parseExpressSchema(content);

      const wall = schema.entities.find(e => e.name === 'IfcWall');

      expect(wall).toBeDefined();
      expect(wall?.supertype).toBe('IfcBuildingElement');
      expect(wall?.attributes).toHaveLength(1);
      expect(wall?.attributes[0].name).toBe('PredefinedType');
      expect(wall?.attributes[0].optional).toBe(true);

      console.log('\n✓ IfcWall parsed correctly');
      console.log(`  - Supertype: ${wall?.supertype}`);
      console.log(`  - Attributes: ${wall?.attributes.length}`);
    });

    it('should correctly parse IfcRoot hierarchy', () => {
      const schemaPath = join(process.cwd(), 'schemas', 'IFC4_ADD2_TC1.exp');
      const content = readFileSync(schemaPath, 'utf-8');
      const schema = parseExpressSchema(content);

      const root = schema.entities.find(e => e.name === 'IfcRoot');

      expect(root).toBeDefined();
      expect(root?.isAbstract).toBe(true);
      expect(root?.attributes.length).toBeGreaterThan(0);

      const globalId = root?.attributes.find(a => a.name === 'GlobalId');
      expect(globalId).toBeDefined();
      expect(globalId?.optional).toBe(false);

      console.log('\n✓ IfcRoot parsed correctly');
      console.log(`  - Abstract: ${root?.isAbstract}`);
      console.log(`  - Attributes: ${root?.attributes.map(a => a.name).join(', ')}`);
    });

    it('should generate valid TypeScript from IFC4', () => {
      const schemaPath = join(process.cwd(), 'schemas', 'IFC4_ADD2_TC1.exp');
      const content = readFileSync(schemaPath, 'utf-8');
      const schema = parseExpressSchema(content);

      expect(() => {
        generateTypeScript(schema);
      }).not.toThrow();
    });

    it('should generate compilable TypeScript interfaces', () => {
      const schemaPath = join(process.cwd(), 'schemas', 'IFC4_ADD2_TC1.exp');
      const content = readFileSync(schemaPath, 'utf-8');
      const schema = parseExpressSchema(content);
      const code = generateTypeScript(schema);

      // Check for valid TypeScript syntax patterns
      expect(code.entities).toContain('export interface');
      expect(code.entities).toContain('extends');
      expect(code.entities).not.toContain('undefined');
      // Note: 'null' may appear in LOGICAL types (boolean | null) which is valid

      // Check for proper interface structure
      expect(code.entities).toMatch(/export interface \w+ \{/);
      expect(code.entities).toMatch(/\w+\??: \w+;/);

      console.log('\n✓ Generated TypeScript is well-formed');
    });

    it('should generate complete schema registry', () => {
      const schemaPath = join(process.cwd(), 'schemas', 'IFC4_ADD2_TC1.exp');
      const content = readFileSync(schemaPath, 'utf-8');
      const schema = parseExpressSchema(content);
      const code = generateTypeScript(schema);

      expect(code.schemaRegistry).toContain('export const SCHEMA_REGISTRY');
      expect(code.schemaRegistry).toContain('entities: {');
      expect(code.schemaRegistry).toContain('types: {');
      expect(code.schemaRegistry).toContain('enums: {');
      expect(code.schemaRegistry).toContain('selects: {');

      // Check for helper functions
      expect(code.schemaRegistry).toContain('export function getEntityMetadata');
      expect(code.schemaRegistry).toContain('export function isKnownEntity');

      console.log('✓ Schema registry includes all sections');
    });
  });

  describe('IFC4X3 Schema', () => {
    it('should parse IFC4X3 schema without errors', () => {
      const schemaPath = join(process.cwd(), 'schemas', 'IFC4X3.exp');
      const content = readFileSync(schemaPath, 'utf-8');

      expect(() => {
        parseExpressSchema(content);
      }).not.toThrow();
    });

    it('should generate valid TypeScript from IFC4X3', () => {
      const schemaPath = join(process.cwd(), 'schemas', 'IFC4X3.exp');
      const content = readFileSync(schemaPath, 'utf-8');
      const schema = parseExpressSchema(content);

      expect(() => {
        generateTypeScript(schema);
      }).not.toThrow();

      console.log('✓ Successfully generated TypeScript from IFC4X3');
    });
  });
});
