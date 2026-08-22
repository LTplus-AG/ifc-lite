/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Type-mapping, escaping, ordering and emitted-runtime coverage for the
 * TypeScript generator.
 *
 * The existing typescript-generator tests only exercise REAL/INTEGER/BOOLEAN/
 * STRING and all-uppercase enum fixtures, so several load-bearing rules were
 * free to change without a single failing test:
 *
 *  - `LOGICAL -> 'boolean | null'` (three-valued) could become `'boolean'`.
 *  - `BINARY -> 'string'` could become anything.
 *  - `STRING(22)` / `BINARY(32)` bounded forms could stop mapping to `string`.
 *  - the `endsWith('Measure') -> number` rule could become `startsWith`.
 *  - the union parenthesisation that makes `LIST OF LOGICAL` emit
 *    `(boolean | null)[]` instead of the precedence-misparsed
 *    `boolean | null[]` could be deleted — this one has an explaining comment
 *    in the source but no guard.
 *  - enum MEMBER names could stop being upper-cased (every fixture value was
 *    already uppercase, so the call was untestable).
 *  - the single-quote / newline escaping in SCHEMA_REGISTRY could be dropped,
 *    emitting a generated file that does not parse.
 *  - topologicalSort could stop visiting parents first.
 *  - the runtime helpers the generator emits as TEXT (getEntityMetadata,
 *    normalizeTypeName, getAllAttributesForEntity, ...) were never executed
 *    anywhere in this package — only substring-matched by name.
 */

import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { parseExpressSchema, type ExpressSchema } from '../src/express-parser.js';
import { generateTypeScript } from '../src/typescript-generator.js';

/** The runtime surface the emitted `schema-registry.ts` ships to consumers. */
interface EmittedAttributeMetadata {
  name: string;
  type: string;
  optional: boolean;
}

interface EmittedEntityMetadata {
  name: string;
  isAbstract: boolean;
  parent?: string;
  attributes: EmittedAttributeMetadata[];
  allAttributes?: EmittedAttributeMetadata[];
  inheritanceChain?: string[];
}

interface EmittedSchemaRegistry {
  SCHEMA_REGISTRY: {
    name: string;
    entities: Record<string, EmittedEntityMetadata>;
    types: Record<string, string>;
    enums: Record<string, string[]>;
    selects: Record<string, string[]>;
  };
  getEntityMetadata(typeName: string): EmittedEntityMetadata | undefined;
  getAllAttributesForEntity(typeName: string): EmittedAttributeMetadata[];
  getInheritanceChainForEntity(typeName: string): string[];
  isKnownEntity(typeName: string): boolean;
}

/**
 * Transpile an emitted, self-contained generated module and evaluate it.
 * This is what turns "the generator printed the right characters" into "the
 * code the generator ships actually behaves".
 */
async function evalEmitted(code: string): Promise<EmittedSchemaRegistry> {
  const js = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

describe('EXPRESS -> TypeScript type mapping', () => {
  const code = generateTypeScript(
    parseExpressSchema(`
      SCHEMA TEST_MAPPING;

      ENTITY IfcTest;
        Flag : LOGICAL;
        Blob : BINARY;
        Bounded : BINARY(32);
        Guid : STRING(22);
        Len : IfcLengthMeasure;
        Label : IfcLabel;
        Custom : SomeUnmappedType;
      END_ENTITY;

      END_SCHEMA;
    `),
  );

  it('maps LOGICAL to the three-valued `boolean | null`, not `boolean`', () => {
    expect(code.entities).toContain('\n  Flag: boolean | null;\n');
    expect(code.entities).not.toContain('\n  Flag: boolean;\n');
  });

  it('maps BINARY and bounded BINARY(N) to string', () => {
    // Anchored on the newline + indent: an unanchored 'Blob: string;' would
    // also match inside another attribute whose name ENDS in Blob.
    expect(code.entities).toContain('\n  Blob: string;\n');
    expect(code.entities).toContain('\n  Bounded: string;\n');
  });

  it('maps bounded STRING(N) to string', () => {
    expect(code.entities).toContain('\n  Guid: string;\n');
  });

  it('maps *Measure defined types to number by SUFFIX, not prefix', () => {
    expect(code.entities).toContain('\n  Len: number;\n');
    // Both directions: an Ifc name that does NOT end in Measure passes through
    // unchanged, so the rule cannot be a blanket "starts with Ifc -> number".
    expect(code.entities).toContain('\n  Label: IfcLabel;\n');
  });

  it('passes unknown/custom types through unchanged', () => {
    expect(code.entities).toContain('\n  Custom: SomeUnmappedType;\n');
  });
});

describe('collection element types are parenthesised when they are unions', () => {
  const code = generateTypeScript(
    parseExpressSchema(`
      SCHEMA TEST_COLLECTIONS;

      TYPE IfcLogicalList = LIST [1:?] OF LOGICAL;
      END_TYPE;

      ENTITY IfcTest;
        Flags : LIST [1:?] OF LOGICAL;
        Points : LIST [1:?] OF IfcCartesianPoint;
      END_ENTITY;

      END_SCHEMA;
    `),
  );

  it('wraps a union element type on the attribute path: (boolean | null)[]', () => {
    expect(code.entities).toContain('\n  Flags: (boolean | null)[];\n');
    // The misparse this guards against: `boolean | null[]` is
    // `boolean | (null[])`, a completely different type.
    expect(code.entities).not.toContain('\n  Flags: boolean | null[];\n');
  });

  it('does NOT parenthesise a non-union element type', () => {
    expect(code.entities).toContain('\n  Points: IfcCartesianPoint[];\n');
    expect(code.entities).not.toContain('\n  Points: (IfcCartesianPoint)[];\n');
  });

  it('wraps a union element type on the type-alias path too', () => {
    expect(code.types).toContain('export type IfcLogicalList = (boolean | null)[];');
  });
});

describe('enum member naming', () => {
  const code = generateTypeScript(
    parseExpressSchema(`
      SCHEMA TEST_ENUM_CASE;

      TYPE IfcCaseEnum = ENUMERATION OF
        (lowercase
        ,MixedCase
        ,ALREADYUPPER);
      END_TYPE;

      END_SCHEMA;
    `),
  );

  it('upper-cases the member NAME while preserving the literal VALUE', () => {
    expect(code.enums).toContain("  LOWERCASE = 'lowercase',");
    expect(code.enums).toContain("  MIXEDCASE = 'MixedCase',");
    expect(code.enums).toContain("  ALREADYUPPER = 'ALREADYUPPER',");
  });

  it('never emits the un-upper-cased member name', () => {
    expect(code.enums).not.toContain("  lowercase = ");
    expect(code.enums).not.toContain("  MixedCase = ");
  });
});

describe('SCHEMA_REGISTRY escapes values that would break the generated file', () => {
  // Built directly rather than parsed: the point is that whatever a schema
  // manages to put in these strings, the emitted module must still parse.
  const schema: ExpressSchema = {
    name: 'TEST_ESCAPING',
    entities: [],
    types: [{ name: 'IfcQuoted', underlyingType: "STRING\nWITH 'quote'" }],
    enums: [{ name: 'IfcQuotedEnum', values: ["IT'S"] }],
    selects: [{ name: 'IfcQuotedSelect', types: ["A'B"] }],
  };
  const code = generateTypeScript(schema);

  it('escapes quotes and flattens newlines in the emitted source', () => {
    expect(code.schemaRegistry).toContain("IfcQuoted: 'STRING WITH \\'quote\\''");
    expect(code.schemaRegistry).toContain("IfcQuotedEnum: ['IT\\'S']");
    expect(code.schemaRegistry).toContain("IfcQuotedSelect: ['A\\'B']");
  });

  it('produces a registry that still parses and carries the original values', async () => {
    const mod = await evalEmitted(code.schemaRegistry);
    expect(mod.SCHEMA_REGISTRY.types.IfcQuoted).toBe("STRING WITH 'quote'");
    expect(mod.SCHEMA_REGISTRY.enums.IfcQuotedEnum).toEqual(["IT'S"]);
    expect(mod.SCHEMA_REGISTRY.selects.IfcQuotedSelect).toEqual(["A'B"]);
  });
});

describe('entity interfaces are emitted parents-first', () => {
  it('sorts a child declared before its parent behind that parent', () => {
    const code = generateTypeScript(
      parseExpressSchema(`
        SCHEMA TEST_ORDER;

        ENTITY IfcChild
          SUBTYPE OF (IfcParent);
          ChildAttr : IfcLabel;
        END_ENTITY;

        ENTITY IfcParent;
          ParentAttr : IfcLabel;
        END_ENTITY;

        END_SCHEMA;
      `),
    );

    const parentAt = code.entities.indexOf('export interface IfcParent');
    const childAt = code.entities.indexOf('export interface IfcChild extends IfcParent');
    expect(parentAt).toBeGreaterThanOrEqual(0);
    expect(childAt).toBeGreaterThanOrEqual(0);
    expect(parentAt).toBeLessThan(childAt);
  });
});

describe('emitted SCHEMA_REGISTRY runtime helpers (executed, not substring-matched)', () => {
  const code = generateTypeScript(
    parseExpressSchema(`
      SCHEMA TEST_RUNTIME;

      ENTITY IfcRoot
        ABSTRACT;
        GlobalId : IfcGloballyUniqueId;
      END_ENTITY;

      ENTITY IfcWall
        SUBTYPE OF (IfcRoot);
        PredefinedType : OPTIONAL IfcWallTypeEnum;
      END_ENTITY;

      END_SCHEMA;
    `),
  );

  it('getEntityMetadata resolves the PascalCase name', async () => {
    const mod = await evalEmitted(code.schemaRegistry);
    expect(mod.getEntityMetadata('IfcWall')?.name).toBe('IfcWall');
  });

  it('getEntityMetadata normalises the UPPERCASE STEP spelling', async () => {
    const mod = await evalEmitted(code.schemaRegistry);
    expect(mod.getEntityMetadata('IFCWALL')?.name).toBe('IfcWall');
  });

  it('getEntityMetadata returns undefined for an unknown type (negative direction)', async () => {
    const mod = await evalEmitted(code.schemaRegistry);
    expect(mod.getEntityMetadata('IFCNOTATHING')).toBeUndefined();
  });

  it('getAllAttributesForEntity includes INHERITED attributes, parent-first', async () => {
    const mod = await evalEmitted(code.schemaRegistry);
    expect(mod.getAllAttributesForEntity('IfcWall').map((a) => a.name)).toEqual([
      'GlobalId',
      'PredefinedType',
    ]);
    // Both directions: the own-attributes list must NOT include the parent's.
    expect(mod.getEntityMetadata('IfcWall')?.attributes.map((a) => a.name)).toEqual([
      'PredefinedType',
    ]);
  });

  it('getAllAttributesForEntity returns [] for an unknown type', async () => {
    const mod = await evalEmitted(code.schemaRegistry);
    expect(mod.getAllAttributesForEntity('IFCNOTATHING')).toEqual([]);
  });

  it('getInheritanceChainForEntity runs root -> leaf, and [] when unknown', async () => {
    const mod = await evalEmitted(code.schemaRegistry);
    expect(mod.getInheritanceChainForEntity('IfcWall')).toEqual(['IfcRoot', 'IfcWall']);
    expect(mod.getInheritanceChainForEntity('IFCNOTATHING')).toEqual([]);
  });

  it('isKnownEntity answers both directions', async () => {
    const mod = await evalEmitted(code.schemaRegistry);
    expect(mod.isKnownEntity('IfcWall')).toBe(true);
    expect(mod.isKnownEntity('IFCWALL')).toBe(true);
    expect(mod.isKnownEntity('IFCNOTATHING')).toBe(false);
  });

  it('carries isAbstract through to the runtime metadata, both values', async () => {
    const mod = await evalEmitted(code.schemaRegistry);
    expect(mod.getEntityMetadata('IfcRoot')?.isAbstract).toBe(true);
    expect(mod.getEntityMetadata('IfcWall')?.isAbstract).toBe(false);
    expect(mod.getEntityMetadata('IfcWall')?.parent).toBe('IfcRoot');
  });
});
