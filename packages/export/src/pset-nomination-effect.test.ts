/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * github.com/LTplus-AG/ifc-lite/issues/2474: the property-set and quantity-set
 * sites still counted INTENT after #2469 converted the source-line pipeline to
 * report EFFECT.
 *
 * Both nominate from a set NAME the session's mutation history mentions, which
 * says nothing about whether the name resolves to content. Two reachable
 * sessions where it does not:
 *
 *   - `deletePropertySet(id, 'AName')` on a host that owns no such set. The
 *     name is still "affected", nothing matches, nothing is generated and
 *     nothing is withheld — and a full export reported `modifiedEntityCount: 1`
 *     with a header claiming a modification over a byte-identical file.
 *   - an UNDONE quantity-set creation. `getMutations()` is append-only, so the
 *     `CREATE_QUANTITY` record still names the qset after
 *     `removeQuantityMutation` has taken it out of the overlay, and the
 *     generator finds nothing to write.
 *
 * ## The test used for "changed"
 *
 * Effect on the emitted FILE: this export either wrote a line for the host's
 * set or left one out. Regenerating a set with identical property VALUES still
 * counts — the replacement carries fresh express ids, so it genuinely is
 * different bytes. Deleting a set that exists counts through the withheld side.
 * Deleting one that does not exist touches neither.
 *
 * Every case reads the FILE first and the count second. The `still counts`
 * block is the bounding control: settling the set kinds from effect and then
 * never recording one would zero the count for real edits just as quietly, and
 * the no-op block alone would be green for it.
 */

import { describe, expect, it } from 'vitest';
import { QuantityType } from '@ifc-lite/data';
import { IfcParser, extractPropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** The "N modification(s)" the HEADER's FILE_DESCRIPTION claims, or null when
 *  it makes no such claim. */
function headerClaimedModifications(stepText: string): number | null {
  const m = /Re-exported by ifc-lite, (\d+) modification/.exec(stepText);
  return m ? Number(m[1]) : null;
}

/** Every `#id=CLASS(...)` defining line in the DATA section. */
function dataEntityLines(stepText: string): string[] {
  const start = stepText.indexOf('DATA;') + 'DATA;'.length;
  const data = stepText.slice(start, stepText.indexOf('ENDSEC;', start));
  return data.split('\n').map((l) => l.trim()).filter((l) => /^#\d+\s*=/.test(l));
}

const WALL_ID = 8;
const WALL_TYPE_ID = 5;
/** Defining lines in {@link BASE_IFC}: an unchanged full export drops none. */
const SOURCE_ENTITY_COUNT = 8;

const BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-08-08T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#5=IFCWALLTYPE('0OSuGGYUFyIf0LtE29OSuT',$,'WT1',$,$,(#30),$,$,$,.STANDARD.);
#8=IFCWALL('0OSuGGYUFyIf0LtE29OSuH',$,'Existing Wall',$,$,$,$,$,$);
#30=IFCPROPERTYSET('0OSuGGYUFyIf0LtE29OSuP',$,'Pset_TypeOwned',$,(#31));
#31=IFCPROPERTYSINGLEVALUE('Foo',$,IFCTEXT('old'),$);
#50=IFCPROPERTYSET('0OSuGGYUFyIf0LtE29OSuQ',$,'Pset_WallCommon',$,(#51));
#51=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#52=IFCRELDEFINESBYPROPERTIES('0OSuGGYUFyIf0LtE29OSuR',$,$,$,(#8),#50);
ENDSEC;
END-ISO-10303-21;`;

async function parseBase(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(BASE_IFC)));
}

function newSession(store: IfcDataStore) {
  const view = new MutablePropertyView(null, 'test-model');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  return { view, editor: new StoreEditor(store, view) };
}

/** The DATA lines of an untouched export of {@link BASE_IFC} — what "the file
 *  did not change" means, checked against the exporter rather than by eye. */
async function untouchedDataLines(): Promise<string[]> {
  const store = await parseBase();
  const result = new StepExporter(store).export({ schema: 'IFC4' });
  return dataEntityLines(new TextDecoder().decode(result.content));
}

describe('a set edit that resolves to nothing is not a modification', () => {
  it('deleting a property set the entity does not own claims nothing, over an unchanged file', async () => {
    const store = await parseBase();
    const { view } = newSession(store);
    // #2474's reproduction verbatim: #8 owns Pset_WallCommon and nothing else.
    view.deletePropertySet(WALL_ID, 'Pset_DoesNotExist');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    // The file first: every source line still there, byte-for-byte.
    expect(dataEntityLines(text)).toEqual(await untouchedDataLines());
    // ...so the header may not claim a modification, and the stat may not
    // either. Both halves, because the header is built from the stat.
    expect(result.stats.modifiedEntityCount).toBe(0);
    expect(headerClaimedModifications(text)).toBeNull();
    // A full export has no delta format to blame for this and nothing for the
    // caller to do about it, so the count says it alone.
    expect(result.stats.warnings).toEqual([]);
  });

  it('the same on a TYPE object, whose repoint resolves to the list already there', async () => {
    const store = await parseBase();
    const { view } = newSession(store);
    // #5 owns Pset_TypeOwned through HasPropertySets. Deleting a name it does
    // not own still routes it through the type-object rewrite — the affected
    // set matches none of its ids and generates no replacement, so slot 5 comes
    // back byte-identical.
    view.deletePropertySet(WALL_TYPE_ID, 'Pset_NotOwnedByThisType');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    // The line is still WRITTEN — `rewrittenEntityIds` made the source pass
    // skip #5, so withholding it here would delete the record (#2469) — it is
    // simply not a modification.
    // Sorted: this pass appends #5's line after the source-iteration ones, so
    // the ORDER differs from an untouched export while the content does not.
    expect(dataEntityLines(text).sort()).toEqual((await untouchedDataLines()).sort());
    expect(dataEntityLines(text)).toHaveLength(SOURCE_ENTITY_COUNT);
    expect(result.stats.modifiedEntityCount).toBe(0);
    expect(headerClaimedModifications(text)).toBeNull();
  });

  it('an UNDONE quantity-set creation claims nothing: the history still names it', async () => {
    const store = await parseBase();
    const { view } = newSession(store);
    view.createQuantitySet(WALL_ID, 'Qto_WallBaseQuantities', [
      { name: 'NetVolume', value: 1.5, quantityType: QuantityType.Volume },
    ]);
    // Undo. The overlay drops the qset; `getMutations()` is append-only and
    // still carries the CREATE_QUANTITY that names it, which is what reaches
    // the quantity nomination site.
    view.removeQuantityMutation(WALL_ID, 'Qto_WallBaseQuantities');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    expect(text).not.toContain('IFCELEMENTQUANTITY');
    expect(dataEntityLines(text)).toEqual(await untouchedDataLines());
    expect(result.stats.modifiedEntityCount).toBe(0);
    expect(headerClaimedModifications(text)).toBeNull();
  });

  it('a no-op set deletion alongside a real rename still counts the host ONCE', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.setAttribute(WALL_ID, 'Name', 'Renamed');
    view.deletePropertySet(WALL_ID, 'Pset_DoesNotExist');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    // The rename is a real change to #8's line, so #8 is a modification — the
    // withdrawn set kind must neither add a second count nor cancel this one.
    expect(text).toContain("'Renamed'");
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(headerClaimedModifications(text)).toBe(
      result.stats.newEntityCount + result.stats.modifiedEntityCount,
    );
    expect(result.stats.warnings).toEqual([]);
  });
});

describe('a set edit that changes the file still counts', () => {
  it('adding a property set counts once and the replacement content is there', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.addPropertySet(WALL_ID, 'Pset_New', [{ name: 'Foo', value: 'bar', type: 'TEXT' }]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain('Pset_New');
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(headerClaimedModifications(text)).toBe(
      result.stats.newEntityCount + result.stats.modifiedEntityCount,
    );
  });

  it('deleting a REL-DEFINED property set counts, and it is the withheld lines that say so', async () => {
    const store = await parseBase();
    const { view } = newSession(store);
    view.deletePropertySet(WALL_ID, 'Pset_WallCommon');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    // A deletion generates NO replacement content, so the generator's emission
    // record cannot cover it: the change is the lines this export left out.
    expect(text).not.toContain('Pset_WallCommon');
    expect(text).not.toContain('IFCRELDEFINESBYPROPERTIES');
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(headerClaimedModifications(text)).toBe(
      result.stats.newEntityCount + result.stats.modifiedEntityCount,
    );
  });

  it('deleting a TYPE-OWNED property set counts, and the type line loses its reference', async () => {
    const store = await parseBase();
    const { view } = newSession(store);
    view.deletePropertySet(WALL_TYPE_ID, 'Pset_TypeOwned');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    expect(text).not.toContain('Pset_TypeOwned');
    expect(text).toMatch(/#5=IFCWALLTYPE\([^;]*\$,\$,\$,\$,\$,\$,\.STANDARD\.\);/);
    expect(result.stats.modifiedEntityCount).toBe(1);
  });

  it('REPLACING a source quantity set counts, and the source lines are gone', async () => {
    // Not a deletion, deliberately: nothing can REMOVE a source quantity set —
    // there is no delete-quantity-set on the view, and `DELETE_QUANTITY` reaches
    // no handler — so the quantity side has no counterpart to the property
    // deletion above, and the qset skip is always accompanied by regenerated
    // content. Editing one quantity is what a session can actually do to a
    // source qset, and it is the case the count has to get right.
    const withQto = BASE_IFC.replace(
      '#52=IFCRELDEFINESBYPROPERTIES',
      `#60=IFCELEMENTQUANTITY('0OSuGGYUFyIf0LtE29OSuV',$,'Qto_WallBaseQuantities',$,$,(#61));
#61=IFCQUANTITYVOLUME('NetVolume',$,$,1.5,$);
#62=IFCRELDEFINESBYPROPERTIES('0OSuGGYUFyIf0LtE29OSuW',$,$,$,(#8),#60);
#52=IFCRELDEFINESBYPROPERTIES`,
    );
    const store = await new IfcParser().parseColumnar(
      toArrayBuffer(new TextEncoder().encode(withQto)),
    );
    const view = new MutablePropertyView(null, 'test-model');
    view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
    view.setQuantity(WALL_ID, 'Qto_WallBaseQuantities', 'NetVolume', 2.5, QuantityType.Volume);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    // Every source line of the old set is withheld — the container, its
    // quantity atom and the relationship that attached it — and a replacement
    // is written in their place, carrying the new value.
    expect(text).not.toContain('#60=IFCELEMENTQUANTITY');
    expect(text).not.toContain('#61=IFCQUANTITYVOLUME');
    expect(text).not.toContain("'0OSuGGYUFyIf0LtE29OSuW'");
    expect(text).toContain('Qto_WallBaseQuantities');
    expect(text).toContain('2.5');
    expect(result.stats.modifiedEntityCount).toBe(1);
  });
});

describe('deltaOnly keeps its nomination-based warnings', () => {
  it('a no-op set deletion is still named as undelivered, not silently dropped', async () => {
    const store = await parseBase();
    const { view } = newSession(store);
    view.deletePropertySet(WALL_ID, 'Pset_DoesNotExist');

    const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });
    const text = new TextDecoder().decode(result.content);

    // The count is settled from emission in this mode already, and the
    // nomination is NOT withdrawn — it is the count rule that changed, so a
    // delta's warning cannot go stale behind it.
    expect(dataEntityLines(text)).toEqual([]);
    expect(result.stats.modifiedEntityCount).toBe(0);
    expect(result.stats.warnings).toHaveLength(1);
    expect(result.stats.warnings[0]).toContain(`#${WALL_ID}`);
    expect(result.stats.warnings[0]).toContain('property-set changes');
  });

  it('a session with nothing but a no-op set deletion still returns an empty delta', async () => {
    const store = await parseBase();
    const { view } = newSession(store);
    view.deletePropertySet(WALL_ID, 'Pset_DoesNotExist');

    const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });
    const text = new TextDecoder().decode(result.content);

    // The early return for an empty delta is driven by `modifiedEntities`,
    // which is still populated at intent — so it fires or does not fire exactly
    // as before, and either way the file has no entity lines and the header no
    // claim.
    expect(dataEntityLines(text)).toEqual([]);
    expect(headerClaimedModifications(text)).toBeNull();
    expect(result.stats.entityCount).toBe(0);
  });
});
