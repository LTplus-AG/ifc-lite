/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The REPORTING half of #4125, at the export's own surface.
 *
 * `by-index-writers-refuse.test.ts` pins that the writers refuse and that
 * `SourceLineMutations.unreadable` says so. That flag is internal: nothing there
 * fails if the export never turns it into something a caller can see. Deleting
 * the `unreadableRecordEditsDroppedWarning` push left the whole suite green,
 * which is the same "silent discard" shape #4125 is about, surviving inside the
 * change that prevents it. So each of the two passes that write a source entity
 * line gets a case here asserting the warning reaches `result.stats.warnings` —
 * the collection an exporter's caller actually reads.
 *
 * The last case is the other direction, and the reason the report is not simply
 * pushed where it is produced: a record whose line the export WITHHOLDS must not
 * also be reported as "written exactly as the source file has it". Two warnings
 * for one outcome, one of them false.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Two undoubled apostrophes in adjacent string attributes, which is what an
 * authoring tool emits when it forgets to double one. The scan closes the string
 * at the first stray apostrophe and reopens at the next, swallowing the comma
 * between them: quote parity stays even and paren depth returns to zero, so the
 * split produces parts that are not the record's slots. Every phantom below has
 * the same shape.
 *
 * `#10` (the wall) and `#20` (the containment relationship) carry one each;
 * `#5`'s is placed AFTER `HasPropertySets` so the parser still resolves the
 * type-owned pset list and the rewrite pass this file is about still runs.
 */
const BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-09-09T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#5=IFCWALLTYPE('0OSuGGYUFyIf0LtE29OSuT',$,'WT1',$,$,(#30),$,'a's','b's',.STANDARD.);
#10=IFCWALL('0OSuGGYUFyIf0LtE29OSuW',$,'W1',$,$,$,$,'a's','b's');
#20=IFCRELCONTAINEDINSPATIALSTRUCTURE('0OSuGGYUFyIf0LtE29OSuR',$,'a's','b's',(#10),#40);
#30=IFCPROPERTYSET('0OSuGGYUFyIf0LtE29OSuP',$,'Pset_TypeOwned',$,(#31));
#31=IFCPROPERTYSINGLEVALUE('Foo',$,IFCTEXT('old'),$);
#40=IFCBUILDINGSTOREY('0OSuGGYUFyIf0LtE29OSuS',$,'Level 0',$,$,$,$,$,$,0.);
ENDSEC;
END-ISO-10303-21;`;

/** The same three records with their apostrophes doubled: the control file. */
const CONTROL_IFC = BASE_IFC.replace(/'a's','b's'/g, "'a''s','b''s'");

const WALL_ID = 10;
const WALL_TYPE_ID = 5;
const REL_ID = 20;

async function parse(text: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(text)));
}

function newSession(store: IfcDataStore) {
  const view = new MutablePropertyView(null, 'test-model');
  return { view, editor: new StoreEditor(store, view) };
}

/**
 * The refusal report, matched on the sentence that makes the claim rather than
 * on the whole string: a reworded warning should not fail this, but a warning
 * that stopped being pushed must.
 */
function refusalReportsFor(warnings: string[], expressId: number): string[] {
  return warnings.filter(
    (w) => w.includes(`#${expressId}`) && w.includes('was written exactly as the source file has it'),
  );
}

describe('an unreadable record whose edits were dropped is reported to the caller', () => {
  it('the source-iteration pass says so, in the export result', async () => {
    const store = await parse(BASE_IFC);
    const { view, editor } = newSession(store);
    editor.setAttribute(WALL_ID, 'Description', 'NEWDESC');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    // The edit was genuinely dropped: the record still reads as the file had it.
    expect(text).not.toContain('NEWDESC');
    // ...and the caller can see that it was, without inferring it from absence.
    expect(refusalReportsFor(result.stats.warnings, WALL_ID)).toHaveLength(1);
  });

  it('the type-object HasPropertySets rewrite says so too', async () => {
    // This pass REPLACES the source-iteration pass's line for these ids
    // (`rewrittenEntityIds` makes that pass skip them), so a report made only
    // there would be silent for exactly the entities this branch owns.
    const store = await parse(BASE_IFC);
    const { view, editor } = newSession(store);
    editor.setAttribute(WALL_TYPE_ID, 'Name', 'RENAMED-TYPE');
    editor.addPropertySet(WALL_TYPE_ID, 'Pset_TypeOwned', [
      { name: 'Foo', value: 'new', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    expect(text).not.toContain('RENAMED-TYPE');
    expect(refusalReportsFor(result.stats.warnings, WALL_TYPE_ID)).toHaveLength(1);
  });

  it('control: a readable record takes the edit and is not reported', async () => {
    // Without this, a green result above could come from the writers having
    // stopped writing rather than from them refusing the record they should.
    const store = await parse(CONTROL_IFC);
    const { view, editor } = newSession(store);
    editor.setAttribute(WALL_ID, 'Description', 'NEWDESC');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain('NEWDESC');
    expect(refusalReportsFor(result.stats.warnings, WALL_ID)).toHaveLength(0);
  });

  it('a record the export WITHHELD is not also reported as written as the source has it', async () => {
    // #20 is unreadable AND names an entity this session deleted, in a list that
    // has no other member — so `filterHiddenRefsFromRelationshipLine` withholds
    // the whole line and pushes its own warning. The refusal report is about a
    // line that is going out; this one is not, so only the withheld warning is
    // true of this entity.
    const store = await parse(BASE_IFC);
    const { view, editor } = newSession(store);
    editor.setAttribute(REL_ID, 'Description', 'NEWDESC');
    editor.removeEntity(WALL_ID);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    // The line really is withheld.
    expect(text).not.toMatch(new RegExp(`^#${REL_ID}\\s*=`, 'm'));
    // The withholding is reported...
    expect(result.stats.warnings.some((w) => w.includes(`#${REL_ID}`))).toBe(true);
    // ...and NOT by a second warning claiming the entity was written.
    expect(refusalReportsFor(result.stats.warnings, REL_ID)).toHaveLength(0);
  });
});
