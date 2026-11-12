/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The compact schema-registry encoding must decode to exactly the registry
 * the schema describes: same keys in the same order, a missing `parent`
 * still missing, fresh objects per attribute occurrence.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { parseExpressSchema } from '../src/express-parser.js';
import {
  buildSchemaRegistry,
  decodeSchemaRegistry,
  encodeSchemaRegistry,
  registryFingerprint,
  type RegistryData,
  type RegistryAttribute,
} from '../src/schema-registry-codec.js';

async function runEmitted(code: string): Promise<{ SCHEMA_REGISTRY: RegistryData; getSchemaRegistry(): RegistryData }> {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

const attr = (name: string, extra: Partial<RegistryAttribute> = {}): RegistryAttribute => ({
  name, type: 'IfcLabel', optional: false, isArray: false, isList: false, isSet: false, ...extra,
});

describe('schema registry compact encoding', () => {
  // The committed files are what every bundle ships. Decoding them through the
  // EMITTED decoder (not the codec module's twin) must give the registry the
  // .exp file describes, for each of the three schemas.
  for (const [exp, dir] of [['IFC4_ADD2_TC1.exp', 'ifc4'], ['IFC4X3.exp', 'ifc4x3'], ['IFC2X3_TC1.exp', 'ifc2x3']] as const) {
    it(`committed generated/${dir}/schema-registry.ts decodes to the registry of ${exp}`, async () => {
      const schema = parseExpressSchema(readFileSync(join(process.cwd(), 'schemas', exp), 'utf-8').replace(/\r\n?/g, '\n'));
      const expected = buildSchemaRegistry(schema);
      const mod = await runEmitted(readFileSync(join(process.cwd(), 'generated', dir, 'schema-registry.ts'), 'utf-8'));
      expect(registryFingerprint(mod.SCHEMA_REGISTRY)).toBe(registryFingerprint(expected));
      expect(mod.getSchemaRegistry()).toBe(mod.SCHEMA_REGISTRY);
      expect(Object.keys(expected.entities).length).toBeGreaterThan(600);
    });
  }

  it('lists attributes and ancestry explicitly where deriving them from the parent would be wrong', () => {
    const reg: RegistryData = {
      name: 'EDGES',
      entities: {
        // Child before parent: decoding must not depend on registry order.
        Child: { name: 'Child', isAbstract: false, parent: 'Base', attributes: [attr('C')], allAttributes: [attr('B'), attr('C')], inheritanceChain: ['Base', 'Child'] },
        Base: { name: 'Base', isAbstract: true, attributes: [attr('B', { isList: true, arrayBounds: [1, 3] })], allAttributes: [attr('B', { isList: true, arrayBounds: [1, 3] })], inheritanceChain: ['Base'] },
        // Parent named but absent from the registry.
        Orphan: { name: 'Orphan', isAbstract: false, parent: 'Missing', attributes: [attr('O')], allAttributes: [attr('O')], inheritanceChain: ['Missing', 'Orphan'] },
        // A cycle: each claims the other as parent.
        CycA: { name: 'CycA', isAbstract: false, parent: 'CycB', attributes: [attr('A')], allAttributes: [attr('A')], inheritanceChain: ['CycA'] },
        CycB: { name: 'CycB', isAbstract: false, parent: 'CycA', attributes: [attr('Bb')], allAttributes: [attr('Bb')], inheritanceChain: ['CycB'] },
      },
      types: { IfcLabel: 'STRING' },
      enums: { E: ['A', 'B'] },
      selects: { S: ['IfcLabel'] },
    };
    const encoded = encodeSchemaRegistry(reg);
    const decoded = decodeSchemaRegistry(JSON.parse(JSON.stringify(encoded)));
    expect(registryFingerprint(decoded)).toBe(registryFingerprint(reg));
    // Child keeps a mismatching attribute list explicit (Base's B carries bounds, Child's does not).
    const childRow = encoded.e.find((row) => encoded.s[row[0]] === 'Child');
    expect(childRow?.[4]).not.toBe(0);
    expect(Object.keys(decoded.entities.Base)).toEqual(['name', 'isAbstract', 'attributes', 'allAttributes', 'inheritanceChain']);
    expect(Object.keys(decoded.entities.Child)).toEqual(['name', 'isAbstract', 'parent', 'attributes', 'allAttributes', 'inheritanceChain']);
  });

  it('decodes fresh objects for each attribute occurrence', () => {
    const schema = parseExpressSchema(`
      SCHEMA FRESH;
      ENTITY IfcRoot; GlobalId : IfcGloballyUniqueId; END_ENTITY;
      ENTITY IfcObject SUBTYPE OF (IfcRoot); ObjectType : OPTIONAL IfcLabel; END_ENTITY;
      END_SCHEMA;
    `);
    const decoded = decodeSchemaRegistry(JSON.parse(JSON.stringify(encodeSchemaRegistry(buildSchemaRegistry(schema)))));
    const root = decoded.entities.IfcRoot;
    const object = decoded.entities.IfcObject;
    expect(object.allAttributes?.[0]).toEqual(root.attributes[0]);
    expect(object.allAttributes?.[0]).not.toBe(root.attributes[0]);
    expect(object.allAttributes?.[0]).not.toBe(root.allAttributes?.[0]);
    expect(root.allAttributes?.[0]).not.toBe(root.attributes[0]);
  });

  it('refuses a registry whose entity carries a key the encoding does not know', () => {
    const reg = {
      name: 'BAD', types: {}, enums: {}, selects: {},
      entities: { X: { name: 'X', isAbstract: false, attributes: [], allAttributes: [], inheritanceChain: ['X'], extra: 1 } },
    } as unknown as RegistryData;
    expect(() => encodeSchemaRegistry(reg)).toThrow(/entity X has keys/);
  });
});
