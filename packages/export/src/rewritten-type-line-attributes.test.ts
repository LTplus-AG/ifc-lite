/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A type object whose type-owned `HasPropertySets` is repointed gets its line
 * written by the `rewrittenEntityLines` pass instead of by the
 * source-iteration pass — `rewrittenEntityIds` makes that pass skip it. The
 * rewrite only replaced slot 5, so every OTHER edit to the same entity was
 * dropped: renaming a wall type and editing one of its type-owned psets in one
 * session wrote the new pset list and the OLD name, with no error and no
 * warning.
 *
 * Found while verifying issue #2462 (which is about the delta count); this is
 * the FULL export path, so the count was never wrong here — one modification
 * was claimed and one landed. The rename simply vanished.
 *
 * Special-casing the rename fixed one edit kind and left the other two —
 * `setEntityType` and `setPositionalAttribute` — dropped on exactly the same
 * line, with exactly the same silence. So the rewrite now runs the ONE
 * pipeline the source pass runs (`applySourceLineMutations`: retype, then
 * named attributes, then positional) and replaces `HasPropertySets` on its
 * output. Every edit kind gets its own case below, per CALL SITE rather than
 * per feature, so dropping any single kind from that pipeline fails a test.
 *
 * The `alone` cases are the controls: each edit on its own has always worked,
 * so the defect is the interaction, not either mechanism.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const WALL_TYPE_ID = 5;

const BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-08-08T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#5=IFCWALLTYPE('0OSuGGYUFyIf0LtE29OSuT',$,'WT1',$,$,(#30),$,$,$,.STANDARD.);
#30=IFCPROPERTYSET('0OSuGGYUFyIf0LtE29OSuP',$,'Pset_TypeOwned',$,(#31));
#31=IFCPROPERTYSINGLEVALUE('Foo',$,IFCTEXT('old'),$);
ENDSEC;
END-ISO-10303-21;`;

async function parseBase(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(BASE_IFC)));
}

function newSession(store: IfcDataStore) {
  const view = new MutablePropertyView(null, 'test-model');
  return { view, editor: new StoreEditor(store, view) };
}

/** The single defining line for `expressId`, or null. */
function lineFor(stepText: string, expressId: number): string | null {
  const m = new RegExp(`^#${expressId}\\s*=.*$`, 'm').exec(stepText);
  return m ? m[0] : null;
}

describe('a rewritten type-object line keeps the entity’s other edits', () => {
  it('carries an attribute edit made in the same session as a type-owned pset edit', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.setAttribute(WALL_TYPE_ID, 'Name', 'RENAMED-TYPE');
    editor.addPropertySet(WALL_TYPE_ID, 'Pset_TypeOwned', [
      { name: 'Foo', value: 'new', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);
    const line = lineFor(text, WALL_TYPE_ID);

    // Exactly one line for the type object, and it carries BOTH edits.
    expect(line).not.toBeNull();
    expect(line).toContain("'RENAMED-TYPE'");
    expect(line).not.toContain("'WT1'");
    // HasPropertySets was repointed at the regenerated pset, not the source one.
    expect(line).not.toContain('(#30)');
    // `IFCTEXT`, not `IFCLABEL`: the property is authored as Text and #2472
    // stopped the serializer writing it as the bounded name-like primitive.
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Foo',$,IFCTEXT('new'),$)");
  });

  it('control: the attribute edit alone still lands', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.setAttribute(WALL_TYPE_ID, 'Name', 'RENAMED-TYPE');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const line = lineFor(new TextDecoder().decode(result.content), WALL_TYPE_ID);

    expect(line).toContain("'RENAMED-TYPE'");
    // Untouched pset list.
    expect(line).toContain('(#30)');
  });

  it('control: the type-owned pset edit alone still repoints HasPropertySets', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.addPropertySet(WALL_TYPE_ID, 'Pset_TypeOwned', [
      { name: 'Foo', value: 'new', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const line = lineFor(new TextDecoder().decode(result.content), WALL_TYPE_ID);

    expect(line).toContain("'WT1'");
    expect(line).not.toContain('(#30)');
  });

  it('carries the attribute edit through a deltaOnly export too', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.setAttribute(WALL_TYPE_ID, 'Name', 'RENAMED-TYPE');
    editor.addPropertySet(WALL_TYPE_ID, 'Pset_TypeOwned', [
      { name: 'Foo', value: 'new', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });
    const line = lineFor(new TextDecoder().decode(result.content), WALL_TYPE_ID);

    // The rewritten line is the one in-place change a delta does carry, so the
    // rename rides along with it and the count is honest.
    expect(line).toContain("'RENAMED-TYPE'");
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(result.stats.warnings).toEqual([]);
  });

  // ── retype (`setEntityType`) ───────────────────────────────────────────────
  // Its own case, because the pipeline applies it at its own step: drop the
  // retype and only these two fail.

  it('carries a RETYPE made in the same session as a type-owned pset edit', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.setEntityType(WALL_TYPE_ID, 'IfcSlabType');
    editor.addPropertySet(WALL_TYPE_ID, 'Pset_TypeOwned', [
      { name: 'Foo', value: 'new', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);
    const line = lineFor(text, WALL_TYPE_ID);

    // Before: `#5=IFCWALLTYPE(…,'WT1',$,$,(#33),$,$,$,.STANDARD.);` — the new
    // pset list landed and the class change did not.
    expect(line).toContain('IFCSLABTYPE');
    expect(line).not.toContain('IFCWALLTYPE');
    // `.STANDARD.` is IfcWallTypeEnum; the retype clears the PredefinedType it
    // cannot carry over, exactly as the source-iteration pass does.
    expect(line).not.toContain('.STANDARD.');
    // …and the pset repoint is still there.
    expect(line).not.toContain('(#30)');
  });

  it('control: the retype alone still lands', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.setEntityType(WALL_TYPE_ID, 'IfcSlabType');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const line = lineFor(new TextDecoder().decode(result.content), WALL_TYPE_ID);

    expect(line).toContain('IFCSLABTYPE');
    expect(line).toContain('(#30)');
  });

  it('carries the retype through a deltaOnly export too', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.setEntityType(WALL_TYPE_ID, 'IfcSlabType');
    editor.addPropertySet(WALL_TYPE_ID, 'Pset_TypeOwned', [
      { name: 'Foo', value: 'new', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });
    const line = lineFor(new TextDecoder().decode(result.content), WALL_TYPE_ID);

    expect(line).toContain('IFCSLABTYPE');
    // Still ONE modification for one host: the ledger is keyed per entity, and
    // the pset edit already nominated #5. The retype rides the same line.
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(result.stats.warnings).toEqual([]);
  });

  // ── positional (`setPositionalAttribute`) ──────────────────────────────────

  it('carries a POSITIONAL edit made in the same session as a type-owned pset edit', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    // Slot 3 is IfcTypeObject.Description — no named-attribute route involved,
    // so this exercises the positional step and nothing else.
    editor.setPositionalAttribute(WALL_TYPE_ID, 3, 'DESC-POS');
    editor.addPropertySet(WALL_TYPE_ID, 'Pset_TypeOwned', [
      { name: 'Foo', value: 'new', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const line = lineFor(new TextDecoder().decode(result.content), WALL_TYPE_ID);

    // Before: `#5=IFCWALLTYPE(…,'WT1',$,$,(#33),…)` — slot 3 still `$`.
    expect(line).toContain("'DESC-POS'");
    expect(line).not.toContain('(#30)');
  });

  it('control: the positional edit alone still lands', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.setPositionalAttribute(WALL_TYPE_ID, 3, 'DESC-POS');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const line = lineFor(new TextDecoder().decode(result.content), WALL_TYPE_ID);

    expect(line).toContain("'DESC-POS'");
    expect(line).toContain('(#30)');
  });

  it('carries the positional edit through a deltaOnly export too', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.setPositionalAttribute(WALL_TYPE_ID, 3, 'DESC-POS');
    editor.addPropertySet(WALL_TYPE_ID, 'Pset_TypeOwned', [
      { name: 'Foo', value: 'new', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });
    const line = lineFor(new TextDecoder().decode(result.content), WALL_TYPE_ID);

    expect(line).toContain("'DESC-POS'");
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(result.stats.warnings).toEqual([]);
  });

  it('a retype rides the cleared line when a pset DELETION is the only other edit', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.setEntityType(WALL_TYPE_ID, 'IfcSlabType');
    view.deletePropertySet(WALL_TYPE_ID, 'Pset_TypeOwned');

    const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });
    const line = lineFor(new TextDecoder().decode(result.content), WALL_TYPE_ID);

    // The ledger check: a deletion generates no replacement content, so the
    // rewritten line is #5's ONLY contribution to the delta — and it now
    // carries the retype as well as the emptied `HasPropertySets`. The count
    // must stay at one honest modification for one host, and the "carried
    // nothing" warning must stay silent.
    expect(line).toContain('IFCSLABTYPE');
    expect(line).not.toContain('(#30)');
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(result.stats.warnings).toEqual([]);
  });

  // ── ordering ───────────────────────────────────────────────────────────────

  it('resolves HasPropertySets LAST, so a positional edit to slot 5 cannot clobber it', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    // Slot 5 IS `HasPropertySets`. `setPositionalAttribute(id, 5, null)` is an
    // explicit "clear the list", and the pset generator has already decided
    // which psets survive — so the resolved list has to be applied AFTER the
    // mutation pipeline. Replace slot 5 first instead and this positional pass
    // overwrites it with `$`, orphaning the pset the export just generated:
    // the same silent drop, one slot over.
    editor.setPositionalAttribute(WALL_TYPE_ID, 5, null);
    editor.addPropertySet(WALL_TYPE_ID, 'Pset_TypeOwned', [
      { name: 'Foo', value: 'new', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);
    const line = lineFor(text, WALL_TYPE_ID);

    // The regenerated pset is referenced, not orphaned…
    const generated = /IFCPROPERTYSET\('[^']*',\$,'Pset_TypeOwned'/.exec(text);
    expect(generated).not.toBeNull();
    const generatedId = /^#(\d+)=/m.exec(
      text.slice(text.lastIndexOf('\n', generated!.index) + 1),
    )![1];
    expect(line).toContain(`(#${generatedId})`);
    // …and the source pset it replaced is gone.
    expect(line).not.toContain('(#30)');
  });

  // ── every kind at once ─────────────────────────────────────────────────────

  it('carries a retype, a named edit and a positional edit together with the pset repoint', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.setEntityType(WALL_TYPE_ID, 'IfcSlabType');
    editor.setAttribute(WALL_TYPE_ID, 'Name', 'RENAMED-TYPE');
    editor.setPositionalAttribute(WALL_TYPE_ID, 3, 'DESC-POS');
    editor.addPropertySet(WALL_TYPE_ID, 'Pset_TypeOwned', [
      { name: 'Foo', value: 'new', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const line = lineFor(new TextDecoder().decode(result.content), WALL_TYPE_ID);

    expect(line).toContain('IFCSLABTYPE');
    // The retype runs first, so `Name` resolves against IfcSlabType's slots.
    expect(line).toContain("'RENAMED-TYPE'");
    expect(line).toContain("'DESC-POS'");
    expect(line).not.toContain('(#30)');
    // One host, one modification.
    expect(result.stats.modifiedEntityCount).toBe(1);
  });

  // ── deletion ───────────────────────────────────────────────────────────────

  it('a DELETED type object contributes no line, and no orphan pset, on either path', async () => {
    for (const deltaOnly of [false, true]) {
      const store = await parseBase();
      const { view, editor } = newSession(store);
      editor.addPropertySet(WALL_TYPE_ID, 'Pset_TypeOwned', [
        { name: 'Foo', value: 'new', type: 'TEXT' },
      ]);
      editor.removeEntity(WALL_TYPE_ID);

      const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly });
      const text = new TextDecoder().decode(result.content);

      // A tombstoned host is dropped before the pset loop (`isDeleted`) and
      // again by `willBeEmitted` at the rewrite loop, so this line shares the
      // shape retypes and positional edits have elsewhere: nothing emitted,
      // nothing counted, nothing to warn about. Deletions are not counted as
      // modifications anywhere in the exporter.
      expect(lineFor(text, WALL_TYPE_ID)).toBeNull();
      // No REPLACEMENT pset was generated for a host that is gone. A full
      // export still carries the source pset #30 verbatim — deliberately, as
      // an orphan rather than a dangling reference — and a delta carries
      // nothing at all.
      expect(text).not.toContain("IFCTEXT('new')");
      expect(text).not.toContain("IFCLABEL('new')");
      expect(lineFor(text, 30)).toBe(deltaOnly ? null : `#30=IFCPROPERTYSET('0OSuGGYUFyIf0LtE29OSuP',$,'Pset_TypeOwned',$,(#31));`);
      expect(result.stats.modifiedEntityCount).toBe(0);
      expect(result.stats.warnings).toEqual([]);
    }
  });
});
