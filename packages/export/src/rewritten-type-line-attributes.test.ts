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
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Foo',$,IFCLABEL('new'),$)");
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
});
