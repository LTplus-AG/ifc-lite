/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A type object whose type-owned `HasPropertySets` is repointed has its line
 * written by the `rewrittenEntityLines` pass — `rewrittenEntityIds` makes the
 * source-iteration pass skip it, on the promise that the rewrite pass writes a
 * replacement. The rewrite kept that promise only `if (rewritten)`, and
 * `replaceStepArgument` returns null for a record it cannot parse as
 * `#id=TYPE(...);` with at least six arguments. Both passes then wrote nothing
 * and the ENTITY DISAPPEARED FROM THE FILE — not a wrong attribute, the whole
 * defining line, with no error.
 *
 * The schema cannot produce that: every `IfcTypeObject` subtype declares
 * `HasPropertySets` at slot 5, and `isTypeClass` gates entry. The INPUT can. A
 * truncated or hand-mangled line is a live input class here — see the
 * malformed-input hardening thread — and the parser indexes it happily, which
 * is what makes it reach this pass at all.
 *
 * So the fallback emits the line the mutation pipeline produced, which is
 * byte-for-byte what the source-iteration pass would have written. The
 * property-set edit is lost either way; the difference is that the rest of the
 * file is not, and `stats.warnings` now says so.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const WALL_TYPE_ID = 5;

/**
 * `#5` is truncated after `Name`: three arguments where `IfcWallType` declares
 * ten, so there is no slot 5 to write `HasPropertySets` into. `#9` is the
 * bystander — the file must not lose it either.
 */
const TRUNCATED_TYPE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('truncated.ifc','2026-08-08T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#5=IFCWALLTYPE('0OSuGGYUFyIf0LtE29OSuT',$,'WT1');
#9=IFCWALL('0OSuGGYUFyIf0LtE29OSuW',$,'W1',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

/** The same file with `#5` intact — the control for every case below. */
const WELL_FORMED_TYPE_IFC = TRUNCATED_TYPE_IFC.replace(
  "#5=IFCWALLTYPE('0OSuGGYUFyIf0LtE29OSuT',$,'WT1');",
  "#5=IFCWALLTYPE('0OSuGGYUFyIf0LtE29OSuT',$,'WT1',$,$,$,$,$,$,.STANDARD.);",
);

async function parse(text: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(text)));
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

const SLOT_WARNING = /^Type object #5: its source line does not parse as a STEP record/;

describe('a type object whose HasPropertySets cannot be repointed keeps its line', () => {
  it('does not delete the entity from a full export', async () => {
    const store = await parse(TRUNCATED_TYPE_IFC);
    const { view, editor } = newSession(store);
    editor.addPropertySet(WALL_TYPE_ID, 'Pset_TypeOwned', [
      { name: 'Foo', value: 'new', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    // Before the fix this was `null`: #5 was skipped by the source-iteration
    // pass and never written by the rewrite pass.
    expect(lineFor(text, WALL_TYPE_ID)).toBe("#5=IFCWALLTYPE('0OSuGGYUFyIf0LtE29OSuT',$,'WT1');");
    // The bystander is untouched — this is about one record, not the file.
    expect(lineFor(text, 9)).not.toBeNull();
  });

  it('says out loud that the property-set edit did not land', async () => {
    const store = await parse(TRUNCATED_TYPE_IFC);
    const { view, editor } = newSession(store);
    editor.addPropertySet(WALL_TYPE_ID, 'Pset_TypeOwned', [
      { name: 'Foo', value: 'new', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });

    // Keeping the line is not the same as applying the edit, and a silent
    // partial success is what made this defect class hard to see in the first
    // place. The warning has to name the entity and say the pset went nowhere.
    expect(result.stats.warnings.filter((w) => SLOT_WARNING.test(w))).toHaveLength(1);
    expect(result.stats.warnings[0]).toContain('property-set change was not applied');
  });

  it('the kept line still carries the session’s OTHER edits', async () => {
    const store = await parse(TRUNCATED_TYPE_IFC);
    const { view, editor } = newSession(store);
    editor.setAttribute(WALL_TYPE_ID, 'Name', 'RENAMED-TYPE');
    editor.addPropertySet(WALL_TYPE_ID, 'Pset_TypeOwned', [
      { name: 'Foo', value: 'new', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const line = lineFor(new TextDecoder().decode(result.content), WALL_TYPE_ID);

    // The fallback emits the MUTATION PIPELINE's output, not the raw source
    // bytes — the same line the source-iteration pass would have written. Fall
    // back to `sourceLine` instead and the rename is dropped as silently as
    // the whole record used to be.
    expect(line).toContain("'RENAMED-TYPE'");
    expect(line).not.toContain("'WT1'");
  });

  it('control: a well-formed line is still repointed, and warns about nothing', async () => {
    const store = await parse(WELL_FORMED_TYPE_IFC);
    const { view, editor } = newSession(store);
    editor.addPropertySet(WALL_TYPE_ID, 'Pset_TypeOwned', [
      { name: 'Foo', value: 'new', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);
    const line = lineFor(text, WALL_TYPE_ID);

    // The generated pset is referenced from slot 5, which is the whole point of
    // the pass — the fallback must not have quietly taken over the happy path.
    const generatedId = /^#(\d+)=IFCPROPERTYSET\('[^']*',\$,'Pset_TypeOwned'/m.exec(text)![1];
    expect(line).toContain(`(#${generatedId})`);
    expect(result.stats.warnings).toEqual([]);
    expect(result.stats.modifiedEntityCount).toBe(1);
  });

  describe('deltaOnly', () => {
    it('carries no line for a host whose only edit failed, and does not count it', async () => {
      const store = await parse(TRUNCATED_TYPE_IFC);
      const { view, editor } = newSession(store);
      editor.addPropertySet(WALL_TYPE_ID, 'Pset_TypeOwned', [
        { name: 'Foo', value: 'new', type: 'TEXT' },
      ]);

      const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });
      const text = new TextDecoder().decode(result.content);

      // Nothing is LOST here — the source-iteration pass never runs under
      // deltaOnly, so #5's line was always going to come from the file being
      // patched. A delta carries changes, and the pipeline left this line
      // identical to its source, so repeating it would be noise.
      expect(lineFor(text, WALL_TYPE_ID)).toBeNull();
      expect(result.stats.warnings.filter((w) => SLOT_WARNING.test(w))).toHaveLength(1);
    });

    it('carries the line when the pipeline DID change it', async () => {
      const store = await parse(TRUNCATED_TYPE_IFC);
      const { view, editor } = newSession(store);
      editor.setAttribute(WALL_TYPE_ID, 'Name', 'RENAMED-TYPE');
      editor.addPropertySet(WALL_TYPE_ID, 'Pset_TypeOwned', [
        { name: 'Foo', value: 'new', type: 'TEXT' },
      ]);

      const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });
      const line = lineFor(new TextDecoder().decode(result.content), WALL_TYPE_ID);

      // The rename is a real in-place change and this line is the only place a
      // delta can put it, so it goes in and the host counts as delivered — the
      // pset edit that failed is what the warning is for.
      expect(line).toContain("'RENAMED-TYPE'");
      expect(result.stats.modifiedEntityCount).toBe(1);
      expect(result.stats.warnings.filter((w) => SLOT_WARNING.test(w))).toHaveLength(1);
    });
  });
});
