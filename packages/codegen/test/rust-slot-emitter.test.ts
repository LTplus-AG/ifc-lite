/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the typed-slot emitter (packages/codegen/src/rust-slot-emitter.ts)
 * behind `rust/core/src/generated/slots.rs` (F3e-0b, #7780).
 *
 * A synthetic three-release schema pins each classification rule; the five
 * committed EXPRESS files then pin the cases the campaign depends on. The Rust
 * side re-derives every generated slot from `attribute_names()` independently
 * (rust/core/src/slot_tests.rs).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExpressSchema } from '../src/express-parser.js';
import {
  ABSENT,
  classifySlots,
  generateSlots,
  screamingSnake,
  slotSchemaOf,
  type SlotEntity,
  type SlotSchemaInput,
} from '../src/rust-slot-emitter.js';
import { parseRenames, type RenameTable } from '../src/rust-slot-renames.js';

const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
const NO_RENAMES: RenameTable = { renames: [], omit: [] };
const input = (version: SlotSchemaInput['version'], source: string): SlotSchemaInput => ({
  version,
  schema: parseExpressSchema(source),
});

const OLD = `
  SCHEMA IFC2X3;
  TYPE IfcLabel = STRING; END_TYPE;
  TYPE IfcCount = INTEGER; END_TYPE;
  ENTITY IfcRoot ABSTRACT;
    Id : IfcLabel;
    Name : OPTIONAL IfcLabel;
  END_ENTITY;
  ENTITY IfcThing SUBTYPE OF (IfcRoot);
    Stays : IfcLabel;
    OldOnly : OPTIONAL IfcLabel;
    Moves : OPTIONAL IfcLabel;
    Flips : IfcLabel;
  END_ENTITY;
  ENTITY IfcGone;
    Value : IfcLabel;
  END_ENTITY;
`;
const NEW = `
  SCHEMA IFC4X3_DEV_x;
  TYPE IfcLabel = STRING; END_TYPE;
  TYPE IfcCount = INTEGER; END_TYPE;
  ENTITY IfcRoot ABSTRACT;
    Identification : IfcLabel;
    Name : OPTIONAL IfcLabel;
  END_ENTITY;
  ENTITY IfcThing SUBTYPE OF (IfcRoot);
    Stays : IfcLabel;
    Inserted : OPTIONAL IfcLabel;
    Moves : OPTIONAL IfcLabel;
    Flips : IfcCount;
    Added : OPTIONAL IfcLabel;
  END_ENTITY;
  ENTITY IfcNewer;
    Value : IfcLabel;
  END_ENTITY;
`;

function classify(table: RenameTable = NO_RENAMES): Map<string, SlotEntity> {
  const entities = classifySlots(
    input('Ifc4x3', NEW),
    [input('Ifc2x3', OLD)],
    table,
    () => true,
  );
  return new Map(entities.map((e) => [e.name, e]));
}
const attr = (entity: SlotEntity | undefined, name: string) =>
  entity?.attributes.find((a) => a.name === name);

describe('classifySlots (synthetic)', () => {
  it('stable: same position wherever the entity is declared', () => {
    const thing = classify().get('IfcThing');
    expect(attr(thing, 'Stays')).toMatchObject({ index: 2, bySchema: null, kind: 'Text' });
  });

  it('trailing: past the end of the older record, absent either way', () => {
    // Added sits at 6, past IfcThing's six-slot 2X3 record; IfcNewer exists in the newer release only.
    const thing = classify().get('IfcThing');
    expect(attr(thing, 'Added')).toMatchObject({ index: 6, bySchema: null });
    expect(classify().get('IfcNewer')?.attributes[0]).toMatchObject({ index: 0, bySchema: null });
  });

  it('moving: a different position, or something else at the position, per schema', () => {
    const thing = classify().get('IfcThing');
    // Inserted exists only in the newer release (at 3, where 2X3 has OldOnly).
    expect(attr(thing, 'Inserted')?.bySchema).toEqual([ABSENT, ABSENT, ABSENT, ABSENT, 3]);
    // Moves is at 4 in both releases: stable, not moving.
    expect(attr(thing, 'Moves')?.bySchema).toBeNull();
  });

  it('an attribute only an older release declares still gets a slot', () => {
    const thing = classify().get('IfcThing');
    expect(attr(thing, 'OldOnly')).toMatchObject({ index: 3, bySchema: [3, ABSENT, ABSENT, ABSENT, ABSENT] });
    // An entity IFC4X3 dropped keeps its slots under the older names.
    expect(classify().get('IfcGone')?.attributes.map((a) => a.name)).toEqual(['Value']);
  });

  it('a kind that differs between releases is read as Select', () => {
    expect(attr(classify().get('IfcThing'), 'Flips')).toMatchObject({ kind: 'Select', bySchema: null });
  });

  it('a listed same-position rename shares one slot; unlisted, it is two', () => {
    expect(attr(classify().get('IfcRoot'), 'Identification')?.bySchema).toEqual([ABSENT, ABSENT, ABSENT, ABSENT, 0]);
    expect(attr(classify().get('IfcRoot'), 'Id')?.bySchema).toEqual([0, ABSENT, ABSENT, ABSENT, ABSENT]);
    const renamed = classify({
      renames: [{ name: 'Identification', aliases: ['Id'], entities: ['IfcRoot'] }],
      omit: [],
    }).get('IfcThing');
    expect(attr(renamed, 'Identification')).toMatchObject({ index: 0, bySchema: null });
    expect(attr(renamed, 'Id')).toBeUndefined();
  });

  it('a rename row covers subtypes of the listed entity', () => {
    const thing = classify({
      renames: [{ name: 'Identification', aliases: ['Id'], entities: ['IfcRoot'] }],
      omit: [],
    }).get('IfcThing');
    expect(attr(thing, 'Identification')?.bySchema).toBeNull();
  });

  it('a rename whose names sit at different positions fails generation', () => {
    expect(() =>
      classify({
        renames: [{ name: 'Added', aliases: ['OldOnly'], entities: ['IfcThing'] }],
        omit: [],
      }),
    ).toThrow(/must keep the position/);
  });

  it('two attributes of one entity with the same slot name fail generation', () => {
    const clash = (src: string) => () =>
      classifySlots(input('Ifc4x3', src), [], NO_RENAMES, () => true);
    expect(
      clash('SCHEMA IFC4X3_x;\nTYPE T = STRING; END_TYPE;\nENTITY IfcA;\n  DeltaT : T;\n  Delta_T : T;\nEND_ENTITY;\n'),
    ).toThrow(/both name the slot DELTA_T/);
  });

  it('an omit row removes an older-release attribute, and a stale one fails', () => {
    const old = 'SCHEMA IFC2X3;\nTYPE T = STRING; END_TYPE;\nENTITY IfcA;\n  UrlReference : T;\nEND_ENTITY;\n';
    const next =
      'SCHEMA IFC4X3_x;\nTYPE T = STRING; END_TYPE;\nENTITY IfcA;\n  Extra : T;\n  URLReference : T;\nEND_ENTITY;\n';
    const run = (omit: RenameTable['omit']) =>
      classifySlots(input('Ifc4x3', next), [input('Ifc2x3', old)], { renames: [], omit }, () => true);
    expect(() => run([])).toThrow(/both name the slot URL_REFERENCE/);
    expect(run([{ entity: 'IfcA', attribute: 'UrlReference' }])[0].attributes.map((a) => a.name)).toEqual([
      'Extra',
      'URLReference',
    ]);
    expect(() =>
      run([
        { entity: 'IfcA', attribute: 'UrlReference' },
        { entity: 'IfcA', attribute: 'Nope' },
      ]),
    ).toThrow(/matches no older-release attribute/);
  });

  it('the entity filter keeps entities outside the IfcType universe out', () => {
    const only = classifySlots(input('Ifc4x3', NEW), [], NO_RENAMES, (n) => n === 'IfcNewer');
    expect(only.map((e) => e.name)).toEqual(['IfcNewer']);
  });
});

describe('names', () => {
  it('SCREAMING_SNAKE from the canonical spelling', () => {
    expect(screamingSnake('GlobalId')).toBe('GLOBAL_ID');
    expect(screamingSnake('URLReference')).toBe('URL_REFERENCE');
    expect(screamingSnake('UAxes')).toBe('U_AXES');
    expect(screamingSnake('DeltaT_Constant')).toBe('DELTA_T_CONSTANT');
    expect(screamingSnake('ModelOrDraughting')).toBe('MODEL_OR_DRAUGHTING');
  });

  it('schema labels resolve to their family', () => {
    expect(slotSchemaOf('IFC4X3_DEV_923b0514')).toBe('Ifc4x3');
    expect(slotSchemaOf('IFC4X2')).toBe('Ifc4x2');
    expect(slotSchemaOf('IFC4X1')).toBe('Ifc4x1');
    expect(slotSchemaOf('IFC4_ADD2_TC1')).toBe('Ifc4');
    expect(slotSchemaOf('IFC2X3')).toBe('Ifc2x3');
    expect(() => slotSchemaOf('IFC5')).toThrow();
  });
});

describe('committed schemas', () => {
  const read = (file: string) => parseExpressSchema(readFileSync(join(SCHEMAS, file), 'utf-8').replace(/\r\n?/g, '\n'));
  const table = parseRenames(JSON.parse(readFileSync(join(SCHEMAS, 'attribute-renames.json'), 'utf-8')));
  const canonical = { version: 'Ifc4x3' as const, schema: read('IFC4X3.exp') };
  const others = [
    { version: 'Ifc2x3' as const, schema: read('IFC2X3_TC1.exp') },
    { version: 'Ifc4' as const, schema: read('IFC4_ADD2_TC1.exp') },
    { version: 'Ifc4x1' as const, schema: read('IFC4X1.exp') },
    { version: 'Ifc4x2' as const, schema: read('IFC4X2.exp') },
  ];
  const entities = new Map(classifySlots(canonical, others, table, () => true).map((e) => [e.name, e]));

  it('IfcLinearPlacement and IfcAlignment.Axis are schema slots at the right positions (X1)', () => {
    const linear = entities.get('IfcLinearPlacement');
    expect(attr(linear, 'PlacementRelTo')?.bySchema).toBeNull();
    expect(attr(linear, 'RelativePlacement')?.bySchema).toEqual([ABSENT, ABSENT, ABSENT, ABSENT, 1]);
    expect(attr(linear, 'CartesianPosition')?.bySchema).toEqual([ABSENT, ABSENT, 3, 4, 2]);
    const alignment = entities.get('IfcAlignment');
    expect(attr(alignment, 'Axis')?.bySchema).toEqual([ABSENT, ABSENT, 7, 7, ABSENT]);
    expect(attr(alignment, 'PredefinedType')?.bySchema).toEqual([ABSENT, ABSENT, 8, 8, 7]);
  });

  it('a semantic replacement is a moving slot that is absent in IFC2X3, never an alias', () => {
    const space = entities.get('IfcSpace');
    expect(attr(space, 'PredefinedType')?.bySchema?.[0]).toBe(ABSENT);
    expect(attr(space, 'InteriorOrExteriorSpace')?.bySchema?.slice(1)).toEqual([ABSENT, ABSENT, ABSENT, ABSENT]);
    for (const row of table.renames) {
      expect(row.aliases).not.toContain('CompositionType');
      expect(row.aliases).not.toContain('InteriorOrExteriorSpace');
      expect(row.aliases).not.toContain('ShapeType');
      expect(row.aliases).not.toContain('BarRole');
      expect(row.aliases).not.toContain('OperationType');
    }
  });

  it('stable positions are what the geometry readers index today', () => {
    expect(attr(entities.get('IfcProject'), 'UnitsInContext')).toMatchObject({ index: 8, bySchema: null, kind: 'Ref' });
    expect(attr(entities.get('IfcWallStandardCase'), 'ObjectPlacement')).toMatchObject({ index: 5, bySchema: null });
    expect(attr(entities.get('IfcProductDefinitionShape'), 'Representations')).toMatchObject({
      index: 2,
      kind: 'RefList',
    });
  });

  it('every renamed pair resolves to a single slot', () => {
    for (const row of table.renames) {
      for (const entityName of row.entities) {
        const entity = entities.get(entityName);
        if (!entity) continue;
        for (const alias of row.aliases) expect(attr(entity, alias), `${entityName}.${alias}`).toBeUndefined();
      }
    }
  });

  it('emits one struct per entity with consts, and the test table binds each to its const', () => {
    const universe = [...canonical.schema.entities, ...others.flatMap((o) => o.schema.entities)];
    const { slots: source, table: index } = generateSlots(canonical, others, universe, table);
    expect(source).toContain('pub struct IfcLinearPlacement;');
    expect(source).toContain('pub const CARTESIAN_POSITION: SchemaSlot<Ref>');
    expect(source).toContain('pub const UNITS_IN_CONTEXT: Slot<Ref> = Slot::new(8, ids::IFCPROJECT);');
    expect(index).toContain('moving("IfcAlignment", "Axis", IfcAlignment::AXIS),');
    expect(index).toContain('fixed("IfcProject", "UnitsInContext", IfcProject::UNITS_IN_CONTEXT),');
    expect(source).not.toContain('fixed("IfcProject"');
    // Deterministic: the same inputs give the same bytes.
    expect(generateSlots(canonical, others, universe, table)).toEqual({ slots: source, table: index });
  });

  it('parseRenames rejects malformed rows', () => {
    expect(() => parseRenames({})).toThrow(/renames/);
    expect(() => parseRenames({ renames: [{ name: 'A', aliases: [], entities: ['E'] }] })).toThrow(/needs name/);
    expect(() => parseRenames({ renames: [], omit: [{ entity: 'E' }] })).toThrow(/omit row/);
  });
});
