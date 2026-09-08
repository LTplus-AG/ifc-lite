/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression cover for github.com/LTplus-AG/ifc-lite/issues/2006.
 *
 * `StepExporter` applied `getAttributeMutationsByEntity()` only to records that
 * exist in the SOURCE BUFFER. An entity created through the mutation overlay
 * (`entity_create` / `store.addEntity`) has no source record, so it was written
 * from its authored creation payload alone and every attribute edit made after
 * the create was silently dropped on save — no error, no warning, the file just
 * said something else.
 *
 * The assertions here re-PARSE the exported STEP rather than matching the
 * emitted string: the contract is that the saved file MEANS what the user set,
 * and a string match would still pass if the value landed in the wrong slot of
 * a line that no longer parses.
 */

import { describe, expect, it, vi } from 'vitest';
import { IfcParser, EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

const BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-03-05T16:26:36+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('3hDMyWaBD34QvUUlT4RWFp',$,'My Project',$,$,$,$,$,$);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCWALL('1wall0000000000000000a',$,'Existing Wall',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

/** IFC4X3 source with a class the parser's IFC4-pinned registry does not
 *  carry, for the source-buffer half of the same registry defect. */
const BASE_IFC4X3 = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-03-05T16:26:36+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('3hDMyWaBD34QvUUlT4RWFp',$,'My Project',$,$,$,$,$,$);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCROAD('1road000000000000000a',$,'Old Road',$,$,$,$,$,.ELEMENT.,$);
ENDSEC;
END-ISO-10303-21;`;

/** IfcWall positional layout (IFC4), hardcoded so the test does not depend on
 *  the same schema lookup the exporter uses to place the edits. */
const WALL_SLOTS = {
  GlobalId: 0,
  OwnerHistory: 1,
  Name: 2,
  Description: 3,
  ObjectType: 4,
  ObjectPlacement: 5,
  Representation: 6,
  Tag: 7,
  PredefinedType: 8,
} as const;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function parseBase(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(BASE_IFC)));
}

/** Parse an exported STEP buffer and pull one entity's positional attributes
 *  back out of the re-parsed source. */
async function reparseAttributes(
  content: Uint8Array,
  expressId: number,
): Promise<{ type: string; attributes: unknown[] }> {
  const reparsed = await new IfcParser().parseColumnar(toArrayBuffer(content));
  const ref = reparsed.entityIndex.byId.get(expressId);
  if (!ref) throw new Error(`#${expressId} is absent from the re-parsed export`);
  const entity = new EntityExtractor(reparsed.source!).extractEntity(ref);
  if (!entity) throw new Error(`#${expressId} did not extract from the re-parsed export`);
  return { type: ref.type, attributes: entity.attributes };
}

/** The emitted `#N=...;` record, for assertions about TOKEN FORM that a
 *  re-parse would normalise away (`.USERDEFINED.` vs `'USERDEFINED'`). */
function emittedRecord(content: Uint8Array, expressId: number): string {
  const text = new TextDecoder().decode(content);
  const match = text.match(new RegExp(`#${expressId}=[^;]*;`));
  if (!match) throw new Error(`#${expressId} is absent from the export`);
  return match[0];
}

function newView(store: IfcDataStore): { view: MutablePropertyView; editor: StoreEditor } {
  const view = new MutablePropertyView(null, 'test-model');
  return { view, editor: new StoreEditor(store, view) };
}

describe('overlay-created entities carry their later edits into the export (#2006)', () => {
  it('round-trips every attribute the mutation surface accepts', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);

    // Exactly the MCP sequence from the issue: entity_create, then
    // entity_set_attribute for each attribute that tool accepts.
    const wall = editor.addEntity('IfcWall', [
      '0aaaaaaaaaaaaaaaaaaaaa', null, 'untitled', null, null, null, null, null, null,
    ]);
    editor.setAttribute(wall.expressId, 'Name', 'Wall C');
    editor.setAttribute(wall.expressId, 'Description', 'North face, load bearing');
    editor.setAttribute(wall.expressId, 'ObjectType', 'Basic Wall:Generic 200mm');
    editor.setAttribute(wall.expressId, 'Tag', 'WAL-0042');

    const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });
    const { type, attributes } = await reparseAttributes(result.content, wall.expressId);

    expect(type).toBe('IFCWALL');
    expect(attributes[WALL_SLOTS.Name]).toBe('Wall C');
    expect(attributes[WALL_SLOTS.Description]).toBe('North face, load bearing');
    expect(attributes[WALL_SLOTS.ObjectType]).toBe('Basic Wall:Generic 200mm');
    expect(attributes[WALL_SLOTS.Tag]).toBe('WAL-0042');
    // Untouched slots keep the authored payload, and the record keeps its
    // arity — an edit must not shift or drop neighbouring arguments.
    expect(attributes[WALL_SLOTS.GlobalId]).toBe('0aaaaaaaaaaaaaaaaaaaaa');
    expect(attributes).toHaveLength(9);

    // The wall is emitted once, as a NEW entity. Before the count fix it was
    // also tallied as a modification, so the header claimed two affected
    // entities for one created-then-renamed wall.
    expect(result.stats.newEntityCount).toBe(1);
    expect(result.stats.modifiedEntityCount).toBe(0);
  });

  it('does not drop an edit whose slot is past the end of a short creation payload', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);

    // `entity_create` takes whatever positional list the caller passes; a wall
    // authored with three arguments still has a real Tag slot at index 7.
    const wall = editor.addEntity('IfcWall', ['0bbbbbbbbbbbbbbbbbbbbb', null, 'untitled']);
    editor.setAttribute(wall.expressId, 'Tag', 'WAL-0043');

    const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });
    const { attributes } = await reparseAttributes(result.content, wall.expressId);

    expect(attributes[WALL_SLOTS.Tag]).toBe('WAL-0043');
    // Padding fills the gap with `$`, it does not shuffle the authored values up.
    expect(attributes[WALL_SLOTS.GlobalId]).toBe('0bbbbbbbbbbbbbbbbbbbbb');
    expect(attributes[WALL_SLOTS.Name]).toBe('untitled');
    expect(attributes[WALL_SLOTS.Description]).toBeNull();
    expect(attributes[WALL_SLOTS.ObjectPlacement]).toBeNull();
    // Padding runs to the class's FULL declared arity, not just to the edited
    // slot. Stopping at Tag would emit eight arguments where IFC4 IfcWall
    // declares nine: this parser tolerates that, a validating consumer does not.
    expect(attributes).toHaveLength(9);
    expect(attributes[WALL_SLOTS.PredefinedType]).toBeNull();
  });

  it('round-trips a positional override applied after the create', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);

    // The other half of the same defect: `setPositionalAttribute` also lands in
    // the overlay, and the new-entities pass ignored it too.
    const profile = editor.addEntity('IfcRectangleProfileDef', ['.AREA.', null, null, 0.3, 0.4]);
    editor.setPositionalAttribute(profile.expressId, 3, 0.25);

    const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });
    const { type, attributes } = await reparseAttributes(result.content, profile.expressId);

    expect(type).toBe('IFCRECTANGLEPROFILEDEF');
    expect(attributes[3]).toBe(0.25);
    expect(attributes[4]).toBe(0.4);
  });

  // The parser's schema registry is pinned to IFC4, so an IFC4X3-only class
  // resolved no attribute slots at all and every named edit on one was
  // discarded by the same `index < 0` path. `getAttributeNamesAcrossSchemas`
  // is the counterpart the parser exposes for exactly these classes.
  it('applies named edits to an IFC4X3-only class the IFC4 registry does not carry', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);

    // IfcCourse layout (IFC4X3): …, ObjectPlacement 5, Representation 6,
    // Tag 7, PredefinedType 8 — same shape as IfcWall, different registry.
    const course = editor.addEntity('IfcCourse', [
      '0eeeeeeeeeeeeeeeeeeeee', null, 'untitled', null, null, null, null, null, null,
    ]);
    editor.setAttribute(course.expressId, 'Name', 'Base course');
    editor.setAttribute(course.expressId, 'Description', 'Sub-base layer');
    editor.setAttribute(course.expressId, 'Tag', 'CRS-0001');

    const result = new StepExporter(store, view).export({ schema: 'IFC4X3', applyMutations: true });
    const { type, attributes } = await reparseAttributes(result.content, course.expressId);

    expect(type).toBe('IFCCOURSE');
    expect(attributes[2]).toBe('Base course');
    expect(attributes[3]).toBe('Sub-base layer');
    expect(attributes[7]).toBe('CRS-0001');
    expect(attributes[0]).toBe('0eeeeeeeeeeeeeeeeeeeee');
  });

  // `serializeAttributeValue` infers the STEP form from the token it replaces.
  // Over `$` there is nothing to infer from, so an enum came out quoted —
  // a schema-invalid record rather than a merely wrong value.
  it('writes an enum-typed edit as an enumeration token even over a null slot', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);

    const wall = editor.addEntity('IfcWall', [
      '0fffffffffffffffffffff', null, 'untitled', null, null, null, null, null, null,
    ]);
    editor.setAttribute(wall.expressId, 'PredefinedType', 'USERDEFINED');

    const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });

    // Assert the TOKEN, not just the round-trip: a re-parse can normalise the
    // two forms to the same string and hide the invalidity.
    const record = emittedRecord(result.content, wall.expressId);
    expect(record).toContain('.USERDEFINED.');
    expect(record).not.toContain("'USERDEFINED'");

    const { attributes } = await reparseAttributes(result.content, wall.expressId);
    expect(attributes[WALL_SLOTS.PredefinedType]).toBe('.USERDEFINED.');
  });

  // The registry defect is not specific to created entities either: the
  // source-buffer rewrite resolved slots through the same IFC4 pin, so a named
  // edit on an EXISTING IfcRoad in an IFC4X3 file was dropped just as silently.
  it('applies a named edit to an existing IFC4X3-only entity read from the source buffer', async () => {
    const store = await new IfcParser().parseColumnar(
      toArrayBuffer(new TextEncoder().encode(BASE_IFC4X3)),
    );
    const view = new MutablePropertyView(null, 'test-model');
    view.setAttribute(3, 'Name', 'Renamed Road');
    view.setAttribute(3, 'Description', 'Trunk road');

    const result = new StepExporter(store, view).export({ schema: 'IFC4X3', applyMutations: true });
    const { type, attributes } = await reparseAttributes(result.content, 3);

    expect(type).toBe('IFCROAD');
    expect(attributes[2]).toBe('Renamed Road');
    expect(attributes[3]).toBe('Trunk road');
    // A source record is never padded or reshaped: same arity, same neighbours.
    expect(attributes).toHaveLength(10);
    expect(attributes[8]).toBe('.ELEMENT.');
  });

  // Same defect on the source-buffer path: it shares the one
  // `serializeAttributeValue` call, so an existing wall with a `$`
  // PredefinedType was quoted exactly like a created one.
  it('writes an enum-typed edit on an EXISTING entity as an enumeration token', async () => {
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    // #4 in the base file is an IfcWall whose PredefinedType is `$`.
    view.setAttribute(4, 'PredefinedType', 'USERDEFINED');

    const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });

    const record = emittedRecord(result.content, 4);
    expect(record).toContain('.USERDEFINED.');
    expect(record).not.toContain("'USERDEFINED'");

    const { attributes } = await reparseAttributes(result.content, 4);
    expect(attributes[WALL_SLOTS.PredefinedType]).toBe('.USERDEFINED.');
    // The rest of the record is untouched.
    expect(attributes[WALL_SLOTS.Name]).toBe('Existing Wall');
  });

  // The padding argument never depended on which API queued the edit: the
  // class is fixed at `addEntity` time either way, so a short payload is
  // partial authoring for a positional override too.
  it('pads for a positional override past the end of a short creation payload', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);

    const wall = editor.addEntity('IfcWall', ['0ggggggggggggggggggggg', null, 'untitled']);
    editor.setPositionalAttribute(wall.expressId, WALL_SLOTS.Tag, 'WAL-0045');

    const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });
    const { attributes } = await reparseAttributes(result.content, wall.expressId);

    expect(attributes[WALL_SLOTS.Tag]).toBe('WAL-0045');
    expect(attributes[WALL_SLOTS.Name]).toBe('untitled');
    // Same arity rule as the named-attribute branch — one rule, not two.
    expect(attributes).toHaveLength(9);
  });

  it('does not grow the record for an index past the declared layout', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);

    // IfcWall declares nine attributes; index 12 is not a slot, so it cannot
    // justify inventing arguments. It stays dropped, as on the source path.
    const wall = editor.addEntity('IfcWall', ['0hhhhhhhhhhhhhhhhhhhhh', null, 'untitled']);
    editor.setPositionalAttribute(wall.expressId, 12, 'nowhere');

    const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });
    const { attributes } = await reparseAttributes(result.content, wall.expressId);

    expect(attributes).toHaveLength(3);
    expect(emittedRecord(result.content, wall.expressId)).not.toContain('nowhere');
  });

  // The union data set carries attribute NAMES but no per-attribute type, so a
  // leaf's INHERITED enum types come from the nearest ancestor the pinned
  // registry does carry — IfcRoad.CompositionType is declared on
  // IfcSpatialStructureElement as IfcElementCompositionEnum.
  it('writes an inherited enum slot on an unpinned class as an enumeration token', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);

    // IfcRoad: …, LongName 7, CompositionType 8, PredefinedType 9.
    const road = editor.addEntity('IfcRoad', [
      '0iiiiiiiiiiiiiiiiiiiii', null, 'untitled', null, null, null, null, null, null, null,
    ]);
    editor.setAttribute(road.expressId, 'CompositionType', 'ELEMENT');

    const result = new StepExporter(store, view).export({ schema: 'IFC4X3', applyMutations: true });

    const record = emittedRecord(result.content, road.expressId);
    expect(record).toContain('.ELEMENT.');
    expect(record).not.toContain("'ELEMENT'");

    const { attributes } = await reparseAttributes(result.content, road.expressId);
    expect(attributes[8]).toBe('.ELEMENT.');
  });

  // Stratum leaves are emitted by real authoring tools but modelled upstream
  // only as the abstract IfcGeotechnicalStratum, so the parser resolves them
  // through an alias table. Slot lookups have to canonicalize the same way or
  // they answer about a different attribute list.
  it('resolves enum slots through the stratum alias table', async () => {
    const store = await parseBase();
    const { view } = newView(store);

    const stratum = view.createEntity('IfcSolidStratum', [
      '0jjjjjjjjjjjjjjjjjjjjj', null, 'untitled', null, null, null, null, null, null,
    ]);
    view.setAttribute(stratum.expressId, 'PredefinedType', 'SOLID');

    const result = new StepExporter(store, view).export({ schema: 'IFC4X3', applyMutations: true });

    const record = emittedRecord(result.content, stratum.expressId);
    expect(record).toContain('.SOLID.');
    expect(record).not.toContain("'SOLID'");

    const { attributes } = await reparseAttributes(result.content, stratum.expressId);
    expect(attributes[8]).toBe('.SOLID.');
  });

  // The attribute loop was guarded against double-counting; the property and
  // quantity loops next to it were not. All three are the only counting sites
  // an overlay-created id can reach: the georef sites read
  // `dataStore.entityIndex.byType` and the retype/positional sites iterate the
  // source index, and an overlay-created entity is deliberately in neither.
  it('counts an overlay-created entity with property edits as new only', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);

    const wall = editor.addEntity('IfcWall', [
      '0kkkkkkkkkkkkkkkkkkkkk', null, 'New Wall', null, null, null, null, null, null,
    ]);
    view.setProperty(wall.expressId, 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean);

    const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });

    // The wall plus the three entities its pset generates — every one of them new.
    expect(result.stats.newEntityCount).toBe(4);
    expect(result.stats.modifiedEntityCount).toBe(0);
  });

  it('counts an overlay-created entity with quantity edits as new only', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);

    const wall = editor.addEntity('IfcWall', [
      '0lllllllllllllllllllll', null, 'New Wall', null, null, null, null, null, null,
    ]);
    view.setQuantity(wall.expressId, 'Qto_WallBaseQuantities', 'Length', 3, QuantityType.Length);

    const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });

    expect(result.stats.newEntityCount).toBe(4);
    expect(result.stats.modifiedEntityCount).toBe(0);
  });

  it('still counts an EXISTING entity with property edits as modified', async () => {
    // The guard must key on overlay-created, not on "has property edits" —
    // otherwise it would silently stop counting real modifications.
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    view.setProperty(4, 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean);

    const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });

    expect(result.stats.modifiedEntityCount).toBe(1);
  });

  // An enum value carrying a comma or a quote is not a wrong VALUE, it is a
  // broken record: `.A,B.` re-parses as two arguments and shifts every slot
  // after it. The arity assertions are the point of these two.
  it('does not shift slots when an enum edit is not a lexically valid token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = await parseBase();
      const { view, editor } = newView(store);

      const wall = editor.addEntity('IfcWall', [
        '0mmmmmmmmmmmmmmmmmmmmm', null, 'untitled', null, null, null, null, null, null,
      ]);
      editor.setAttribute(wall.expressId, 'PredefinedType', 'A,B');

      const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });

      expect(emittedRecord(result.content, wall.expressId)).not.toContain('.A,B.');

      const { attributes } = await reparseAttributes(result.content, wall.expressId);
      // Nine arguments, not ten: the comma stayed inside a string literal.
      expect(attributes).toHaveLength(9);
      expect(attributes[WALL_SLOTS.PredefinedType]).toBe('A,B');
      // The value is preserved, not dropped — a dropped edit is the bug class
      // this whole change exists to fix.
      expect(attributes[WALL_SLOTS.Name]).toBe('untitled');
      // Match the message, not the call count: the parser warns about this
      // fixture's missing spatial structure on every parse.
      expect(warn.mock.calls.flat().join(' ')).toContain('not a valid STEP enumeration symbol');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not break the record when an enum edit contains a quote', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = await parseBase();
      const view = new MutablePropertyView(null, 'test-model');
      // Source-buffer path: an unescaped `'` here would open a string literal
      // that swallows the rest of the file, not just this record.
      view.setAttribute(4, 'PredefinedType', "O'Brien");

      const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });
      const { attributes } = await reparseAttributes(result.content, 4);

      expect(attributes).toHaveLength(9);
      expect(attributes[WALL_SLOTS.PredefinedType]).toBe("O'Brien");
      expect(attributes[WALL_SLOTS.Name]).toBe('Existing Wall');
      expect(warn.mock.calls.flat().join(' ')).toContain('not a valid STEP enumeration symbol');
    } finally {
      warn.mockRestore();
    }
  });

  // A room or tag literally named `#12` is ordinary on a real project. Over a
  // `$` slot the old inference emitted it as an entity reference.
  it('quotes a token-shaped value in a text slot on a padded overlay record', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);

    // Short payload, so the Tag slot is one the padding created as `$`.
    const wall = editor.addEntity('IfcWall', ['0nnnnnnnnnnnnnnnnnnnnn', null, 'untitled']);
    editor.setAttribute(wall.expressId, 'Tag', '#12');

    const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });

    expect(emittedRecord(result.content, wall.expressId)).toContain("'#12'");

    const { attributes } = await reparseAttributes(result.content, wall.expressId);
    expect(attributes[WALL_SLOTS.Tag]).toBe('#12');
  });

  it('quotes a token-shaped value in a text slot on an existing record', async () => {
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    // #4's Description and ObjectType are `$` in the source, so the same hole
    // was open on records nobody created — this PR only widened it.
    view.setAttribute(4, 'Description', '#12');
    view.setAttribute(4, 'ObjectType', '.FOO.');

    const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });
    const { attributes } = await reparseAttributes(result.content, 4);

    expect(attributes[WALL_SLOTS.Description]).toBe('#12');
    expect(attributes[WALL_SLOTS.ObjectType]).toBe('.FOO.');
    expect(attributes).toHaveLength(9);
  });

  it('still writes a bare reference into a reference slot', async () => {
    // The guard must key on the DECLARED type, not on the value's shape —
    // otherwise it would quote `#3` into ObjectPlacement and break the link.
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    view.setAttribute(4, 'ObjectPlacement', '#3');

    const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });

    expect(emittedRecord(result.content, 4)).toContain(',#3,');
    expect(emittedRecord(result.content, 4)).not.toContain("'#3'");
  });

  it('keeps an attribute edit when the created entity was also retyped', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);

    // Retype and attribute edits are two overlay features on the same line.
    // The retype re-lays the authored payload out by name; the attribute
    // override then has to compose with that rather than be dropped by it.
    const proxy = editor.addEntity('IfcBuildingElementProxy', [
      '0ccccccccccccccccccccc', null, 'untitled', null, null, null, null, null, null,
    ]);
    editor.setEntityType(proxy.expressId, 'IfcWall');
    editor.setAttribute(proxy.expressId, 'Name', 'Retyped wall');
    editor.setAttribute(proxy.expressId, 'Tag', 'WAL-0044');

    const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });
    const { type, attributes } = await reparseAttributes(result.content, proxy.expressId);

    expect(type).toBe('IFCWALL');
    expect(attributes[WALL_SLOTS.Name]).toBe('Retyped wall');
    expect(attributes[WALL_SLOTS.Tag]).toBe('WAL-0044');
  });
});
