/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression cover for github.com/LTplus-AG/ifc-lite/issues/2462: a
 * `deltaOnly` export claimed a modification count it could not deliver.
 *
 * `deltaOnly` skips the source-iteration pass wholesale, so the only lines a
 * source-backed host can contribute to a delta are the ones the property-set
 * generator, the quantity-set generator and the type-object `HasPropertySets`
 * rewrite produce for it. Three kinds of edit produce none of those and still
 * counted — an in-place attribute edit, a georeferencing edit to an EXISTING
 * `IfcProjectedCRS` / `IfcMapConversion`, and a property-set deletion. The
 * reported case read `"Re-exported by ifc-lite, 1 modification"` over a DATA
 * section with zero entity lines.
 *
 * Every assertion below reads the emitted file TEXT and checks that the
 * HEADER and the BODY agree — a header claim is only ever verified against the
 * entity lines actually present, never against a counter alone. The
 * `full export` block is the bounding control: the same edits through the
 * normal (non-delta) path must still be counted and still land in `DATA`.
 *
 * The accompanying `stats.warnings` entries are keyed per (entity, EDIT KIND).
 * The count is per entity — a host with one delivered kind is one modification,
 * however many of its other edits were dropped — but the warning names each
 * dropped kind, so "1 modification, no warnings" can no longer be returned for
 * a session whose rename went nowhere. See the mixed attribute+pset case below.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
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
  const data = stepText.slice(stepText.indexOf('DATA;') + 'DATA;'.length, stepText.indexOf('ENDSEC;', stepText.indexOf('DATA;')));
  return data.split('\n').map((l) => l.trim()).filter((l) => /^#\d+\s*=/.test(l));
}

const WALL_ID = 8;
const WALL_TYPE_ID = 5;
const CRS_ID = 40;
const MAP_CONVERSION_ID = 41;
/** `Name` on IfcWall: GlobalId, OwnerHistory, Name. */
const WALL_NAME_SLOT = 2;
/** #8's line in {@link BASE_IFC}, verbatim — the no-op cases must not touch it. */
const WALL_LINE_VERBATIM = `#${WALL_ID}=IFCWALL('0OSuGGYUFyIf0LtE29OSuH',$,'Existing Wall',$,$,$,$,$,$);`;
/** Defining lines in {@link BASE_IFC}: a full export drops none of them. */
const SOURCE_ENTITY_COUNT = 10;

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
#40=IFCPROJECTEDCRS('EPSG:1000',$,$,$,$,$,$);
#41=IFCMAPCONVERSION($,#40,1000.,2000.,0.,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function parseBase(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(BASE_IFC)));
}

function newSession(store: IfcDataStore) {
  const view = new MutablePropertyView(null, 'test-model');
  return { view, editor: new StoreEditor(store, view) };
}

describe('deltaOnly modification count vs what the delta contains', () => {
  it('an attribute-only session produces an empty delta and claims nothing', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    // The ONLY edit. #2462's reproduction verbatim.
    editor.setAttribute(WALL_ID, 'Name', 'X');

    const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });
    const text = new TextDecoder().decode(result.content);

    // Body: nothing. A delta cannot rewrite the wall's own line.
    expect(dataEntityLines(text)).toEqual([]);
    // Header: therefore no claim. Both halves, as the issue asks.
    expect(headerClaimedModifications(text)).toBeNull();
    expect(result.stats.modifiedEntityCount).toBe(0);
    // ...and the drop is reported rather than silent.
    expect(result.stats.warnings.join('\n')).toContain(`#${WALL_ID}`);
    expect(result.stats.warnings.join('\n')).toMatch(/deltaOnly/);
  });

  it('a georeferencing edit to an EXISTING IfcProjectedCRS claims nothing either', async () => {
    const store = await parseBase();
    const { view } = newSession(store);

    // Queued as attribute edits against #40, which only the skipped
    // source-iteration pass would write.
    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      deltaOnly: true,
      georefMutations: { projectedCRS: { name: 'EPSG:2056' } },
    });
    const text = new TextDecoder().decode(result.content);

    expect(dataEntityLines(text)).toEqual([]);
    expect(headerClaimedModifications(text)).toBeNull();
    expect(result.stats.modifiedEntityCount).toBe(0);
    expect(result.stats.warnings.join('\n')).toContain(`#${CRS_ID}`);
    expect(result.stats.warnings.join('\n')).toContain('georeferencing edits');
  });

  it('a georeferencing edit to an EXISTING IfcMapConversion claims nothing either', async () => {
    const store = await parseBase();
    const { view } = newSession(store);

    // The map-conversion branch is a SECOND nomination site with the same
    // shape, and nothing pinned it: deleted, a delta claimed a modification for
    // #41 over an empty DATA section again, with the suite green.
    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      deltaOnly: true,
      georefMutations: { mapConversion: { eastings: 12345, northings: 67890 } },
    });
    const text = new TextDecoder().decode(result.content);

    expect(dataEntityLines(text)).toEqual([]);
    expect(headerClaimedModifications(text)).toBeNull();
    expect(result.stats.modifiedEntityCount).toBe(0);
    expect(result.stats.warnings.join('\n')).toContain(`#${MAP_CONVERSION_ID}`);
    expect(result.stats.warnings.join('\n')).toContain('georeferencing edits');
  });

  it('a property-set DELETION claims nothing: a delta has no replacement content to carry', async () => {
    const store = await parseBase();
    const { view } = newSession(store);
    view.deletePropertySet(WALL_ID, 'Pset_WallCommon');

    const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });
    const text = new TextDecoder().decode(result.content);

    expect(dataEntityLines(text)).toEqual([]);
    expect(headerClaimedModifications(text)).toBeNull();
    expect(result.stats.modifiedEntityCount).toBe(0);
    expect(result.stats.warnings.join('\n')).toContain(`#${WALL_ID}`);
  });

  it('exportPropertiesOnly inherits the fix — it is deltaOnly under the hood', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.setAttribute(WALL_ID, 'Name', 'X');

    const result = new StepExporter(store, view).exportPropertiesOnly({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    expect(dataEntityLines(text)).toEqual([]);
    expect(headerClaimedModifications(text)).toBeNull();
  });

  it('a pset edit is still counted under deltaOnly: the replacement pset really is in the delta', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.addPropertySet(WALL_ID, 'Pset_Delta', [{ name: 'Foo', value: 'bar', type: 'TEXT' }]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });
    const text = new TextDecoder().decode(result.content);

    // The host is counted because these lines exist, not despite them.
    expect(text).toContain('Pset_Delta');
    expect(text).toContain(`(#${WALL_ID})`);
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(headerClaimedModifications(text)).toBe(
      result.stats.newEntityCount + result.stats.modifiedEntityCount,
    );
    expect(result.stats.warnings).toEqual([]);
  });

  it('a quantity-set edit is still counted under deltaOnly: the replacement qset really is in the delta', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.addQuantitySet(WALL_ID, 'Qto_WallBaseQuantities', [
      { name: 'NetVolume', value: 1.5, quantityType: 'VOLUME' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });
    const text = new TextDecoder().decode(result.content);

    // The quantity-set generator is the SECOND of the three passes that can put
    // a source-backed host into a delta, and it has to record its emission for
    // itself: the pset pass never runs for this session. Without that record
    // the header would claim `newEntityCount` alone over a DATA section that
    // plainly carries the qset, AND the ledger would name #8 in a warning
    // saying its edits were dropped.
    expect(text).toContain('IFCELEMENTQUANTITY');
    expect(text).toContain('Qto_WallBaseQuantities');
    expect(text).toContain(`(#${WALL_ID})`);
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(headerClaimedModifications(text)).toBe(
      result.stats.newEntityCount + result.stats.modifiedEntityCount,
    );
    expect(result.stats.warnings).toEqual([]);
  });

  it('an attribute edit alongside a pset edit is counted ONCE, and the pset half is really there', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.setAttribute(WALL_ID, 'Name', 'X');
    editor.addPropertySet(WALL_ID, 'Pset_Delta', [{ name: 'Foo', value: 'bar', type: 'TEXT' }]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });
    const text = new TextDecoder().decode(result.content);

    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(text).toContain('Pset_Delta');
    // The rename is still not in the delta — that is the mode, not a count bug.
    expect(text).not.toContain(`#${WALL_ID}=IFCWALL`);
    expect(headerClaimedModifications(text)).toBe(
      result.stats.newEntityCount + result.stats.modifiedEntityCount,
    );
    // ...and it is now SAID, which is the whole point of the ledger. Keyed per
    // ENTITY (the shape this file shipped with in review), the pset emission
    // marked #8 delivered and suppressed this warning entirely: the caller got
    // "1 modification, no warnings" and could apply the delta believing the
    // rename was in it. Keyed per (entity, kind), the count stays 1 — the delta
    // really does carry a modification for #8 — and the kind that went nowhere
    // is named as such.
    expect(result.stats.warnings).toHaveLength(1);
    expect(result.stats.warnings[0]).toContain(`#${WALL_ID}`);
    expect(result.stats.warnings[0]).toContain('attribute edits');
    // The half that DID land must not be named — a warning that over-reports is
    // the same lie in the other direction.
    expect(result.stats.warnings[0]).not.toContain('property-set changes');
  });

  it('an attribute edit alongside a QUANTITY-set edit warns the same way', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.setAttribute(WALL_ID, 'Name', 'X');
    editor.addQuantitySet(WALL_ID, 'Qto_WallBaseQuantities', [
      { name: 'NetVolume', value: 1.5, quantityType: 'VOLUME' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });
    const text = new TextDecoder().decode(result.content);

    // The quantity-set generator is the other pass that can put a source-backed
    // host into a delta, and it must suppress the warning for its OWN kind only.
    expect(text).toContain('Qto_WallBaseQuantities');
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(result.stats.warnings).toHaveLength(1);
    expect(result.stats.warnings[0]).toContain('attribute edits');
    expect(result.stats.warnings[0]).toContain(`#${WALL_ID}`);
  });

  it('warns once per kind, listing every host: two dropped kinds, two warnings', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.setAttribute(WALL_ID, 'Name', 'X');
    view.deletePropertySet(WALL_ID, 'Pset_WallCommon');

    const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });

    expect(dataEntityLines(new TextDecoder().decode(result.content))).toEqual([]);
    expect(result.stats.modifiedEntityCount).toBe(0);
    // One host, two kinds, two warnings — the message says WHICH edits were
    // dropped, not just whose.
    expect(result.stats.warnings).toHaveLength(2);
    expect(result.stats.warnings[0]).toContain('attribute edits');
    expect(result.stats.warnings[1]).toContain('property-set changes');
    for (const warning of result.stats.warnings) expect(warning).toContain(`#${WALL_ID}`);
  });

  it('a type object whose HasPropertySets is rewritten IS in the delta, so it still counts', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.addPropertySet(WALL_TYPE_ID, 'Pset_TypeOwned', [{ name: 'Foo', value: 'new', type: 'TEXT' }]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });
    const text = new TextDecoder().decode(result.content);

    // The one in-place change a delta does carry: a rewritten source line.
    expect(text).toContain(`#${WALL_TYPE_ID}=IFCWALLTYPE`);
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(result.stats.warnings).toEqual([]);
  });

  it('an attribute edit the class has no slot for is NOT reported as carried', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    // #5's type-owned pset is repointed, so a rewritten source line for #5 is
    // genuinely in the delta — and that line is the only thing that could carry
    // an attribute edit. `Eastings` is not an IfcWallType attribute, so the
    // rewrite resolves no slot and discards it: the line goes in, this edit
    // does not, and calling it delivered because a line was written would be
    // the same misreport one level further down.
    editor.addPropertySet(WALL_TYPE_ID, 'Pset_TypeOwned', [{ name: 'Foo', value: 'new', type: 'TEXT' }]);
    editor.setAttribute(WALL_TYPE_ID, 'Eastings', '1.0');

    const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain(`#${WALL_TYPE_ID}=IFCWALLTYPE`);
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(result.stats.warnings).toHaveLength(1);
    expect(result.stats.warnings[0]).toContain('attribute edits');
    expect(result.stats.warnings[0]).toContain(`#${WALL_TYPE_ID}`);
  });

  it('control: an attribute edit the rewritten type line DOES carry warns about nothing', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.addPropertySet(WALL_TYPE_ID, 'Pset_TypeOwned', [{ name: 'Foo', value: 'new', type: 'TEXT' }]);
    editor.setAttribute(WALL_TYPE_ID, 'Name', 'RENAMED-TYPE');

    const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });
    const text = new TextDecoder().decode(result.content);

    // Same session shape as the case above; the only difference is that this
    // attribute has a slot. The rename really is in the delta, so nothing is
    // dropped and nothing is claimed to be.
    expect(text).toContain("'RENAMED-TYPE'");
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(result.stats.warnings).toEqual([]);
  });

  it('DELETING a type-owned pset still counts: the cleared type line is the delta', async () => {
    const store = await parseBase();
    const { view } = newSession(store);
    view.deletePropertySet(WALL_TYPE_ID, 'Pset_TypeOwned');

    const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });
    const text = new TextDecoder().decode(result.content);

    // The case above reaches the ledger through the property-set generator too
    // (it produces replacement lines), so it does NOT isolate the type-object
    // rewrite's own emission record. A DELETION does: there is no replacement
    // content, so the rewritten line is the only thing #5 contributes — and it
    // is a real, deliverable modification, since it drops #30 from
    // HasPropertySets. Nothing else in the suite exercised this, which left the
    // rewrite pass's `recordEmitted` free to be deleted with the suite green.
    const lines = dataEntityLines(text);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`#${WALL_TYPE_ID}=IFCWALLTYPE`);
    // HasPropertySets emptied: the deleted pset is genuinely unreferenced.
    expect(lines[0]).not.toContain('#30');
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(headerClaimedModifications(text)).toBe(
      result.stats.newEntityCount + result.stats.modifiedEntityCount,
    );
    // ...so no warning may claim #5's edits went nowhere.
    expect(result.stats.warnings).toEqual([]);
  });
});

describe('full (non-delta) export is unchanged by the delta fix', () => {
  it('an attribute-only session still counts one modification and rewrites the line', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.setAttribute(WALL_ID, 'Name', 'X');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain(`#${WALL_ID}=IFCWALL('0OSuGGYUFyIf0LtE29OSuH',$,'X'`);
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(headerClaimedModifications(text)).toBe(
      result.stats.newEntityCount + result.stats.modifiedEntityCount,
    );
    expect(result.stats.warnings).toEqual([]);
  });

  it('a georeferencing edit to an existing CRS still counts and still lands', async () => {
    const store = await parseBase();
    const { view } = newSession(store);

    // Every field the modify-existing-CRS branch can set, each a distinct
    // non-interchangeable value so a positional swap would be observable.
    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      georefMutations: {
        projectedCRS: {
          name: 'EPSG:2056',
          description: 'LV95 Modified',
          geodeticDatum: 'CH1903+',
          verticalDatum: 'LN02',
          mapProjection: 'Swiss Oblique Mercator 1995',
          mapZone: '32N',
        },
      },
    });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain(
      `#${CRS_ID}=IFCPROJECTEDCRS('EPSG:2056','LV95 Modified','CH1903+','LN02','Swiss Oblique Mercator 1995','32N',$);`,
    );
    expect(result.stats.modifiedEntityCount).toBe(1);
  });

  it('a georeferencing edit to an existing IfcMapConversion still counts and still lands', async () => {
    const store = await parseBase();
    const { view } = newSession(store);

    // Same shape as the CRS case above, for the sibling modify branch: every
    // settable field, each a distinct value so a transposed pair would fail.
    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      georefMutations: {
        mapConversion: {
          eastings: 2650000,
          northings: 1250000,
          orthogonalHeight: 555,
          xAxisAbscissa: 0.1,
          xAxisOrdinate: 0.2,
          scale: 0.9999,
        },
      },
    });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain(
      `#${MAP_CONVERSION_ID}=IFCMAPCONVERSION($,#${CRS_ID},2650000.,1250000.,555.,0.1,0.2,0.9999);`,
    );
    expect(result.stats.modifiedEntityCount).toBe(1);
  });

  it('a retype-only session still counts one modification and rewrites the class', async () => {
    const store = await parseBase();
    const { view } = newSession(store);
    view.setEntityType(WALL_ID, 'IfcColumn');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    // The retype and positional nominations live INSIDE the source-iteration
    // pass, which only a full export runs — so this is where they have to be
    // pinned. Nothing asserted a count for a retype before; the nomination
    // could be deleted with the whole suite green.
    expect(text).toContain(`#${WALL_ID}=IFCCOLUMN`);
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(headerClaimedModifications(text)).toBe(
      result.stats.newEntityCount + result.stats.modifiedEntityCount,
    );
  });

  it('a retype AND an attribute edit on one host still count ONCE', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    view.setEntityType(WALL_ID, 'IfcColumn');
    editor.setAttribute(WALL_ID, 'Name', 'X');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    // Two KINDS, one entity. `modifiedEntityCount` counts entities, and the
    // per-kind keying must not turn the header into a per-edit count.
    expect(text).toContain(`#${WALL_ID}=IFCCOLUMN`);
    expect(text).toContain("'X'");
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(headerClaimedModifications(text)).toBe(
      result.stats.newEntityCount + result.stats.modifiedEntityCount,
    );
    expect(result.stats.warnings).toEqual([]);
  });

  it('a positional edit still counts one modification and rewrites the slot', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.setPositionalAttribute(WALL_ID, WALL_NAME_SLOT, 'Renamed');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    // The bounding control for the no-op case below: without it, reporting
    // `positional: false` unconditionally would pass the whole suite.
    expect(text).toContain("'Renamed'");
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(headerClaimedModifications(text)).toBe(
      result.stats.newEntityCount + result.stats.modifiedEntityCount,
    );
  });

  it('a property-set deletion still counts, and the pset is gone from the file', async () => {
    const store = await parseBase();
    const { view } = newSession(store);
    view.deletePropertySet(WALL_ID, 'Pset_WallCommon');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    expect(text).not.toContain('Pset_WallCommon');
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(headerClaimedModifications(text)).toBe(
      result.stats.newEntityCount + result.stats.modifiedEntityCount,
    );
  });
});

/**
 * A modification is a claim about the FILE. An edit that resolves to the text
 * already there changes nothing, so it cannot be one — whatever the session
 * asked for.
 *
 * `attributed` was already measured this way (`applyAttributeMutations` returns
 * its input when no slot resolved). Its two siblings reported INTENT: `retyped`
 * was `!!typeMutation` and `positional` was "the map is non-empty", so both a
 * retype to the class the entity already is and a positional write of the token
 * the slot already holds counted as a modification, and reached the ledger as a
 * landed edit, over a byte-identical export. Each case below asserts the FILE
 * first and the count second, so the two cannot drift apart again.
 *
 * The bounding controls are the real-edit cases in the block above — a retype
 * and a positional edit that DO change the line must still count 1 — without
 * which reporting `false` unconditionally would be just as green.
 */
describe('an edit that resolves to the text already there is not a modification', () => {
  it('retyping an entity to the class it already is claims nothing', async () => {
    const store = await parseBase();
    const { view } = newSession(store);
    // #8 is already an IFCWALL.
    view.setEntityType(WALL_ID, 'IfcWall');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    // The line the export wrote is the line it read.
    expect(text).toContain(WALL_LINE_VERBATIM);
    expect(result.stats.modifiedEntityCount).toBe(0);
    expect(headerClaimedModifications(text)).toBeNull();
  });

  it('writing a positional slot the value it already holds claims nothing', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.setPositionalAttribute(WALL_ID, WALL_NAME_SLOT, 'Existing Wall');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain(WALL_LINE_VERBATIM);
    expect(result.stats.modifiedEntityCount).toBe(0);
    expect(headerClaimedModifications(text)).toBeNull();
  });

  it('a repoint that resolves to the list already there puts nothing in the delta', async () => {
    const store = await parseBase();
    const { view } = newSession(store);
    // Deleting a pset name #5 does not own. It is still "affected", so the type
    // object goes through the HasPropertySets rewrite — but it matches none of
    // the ids in the list and generates no replacement, so slot 5 comes back
    // byte-identical. The repoint SUCCEEDS and delivers nothing.
    view.deletePropertySet(WALL_TYPE_ID, 'Pset_NotOwnedByThisType');

    const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });
    const text = new TextDecoder().decode(result.content);

    // Repeating an unchanged line contradicts the very warning the delta owes
    // its caller, so the delta carries no line at all...
    expect(dataEntityLines(text)).toEqual([]);
    expect(headerClaimedModifications(text)).toBeNull();
    expect(result.stats.modifiedEntityCount).toBe(0);
    // ...and the pset edit that nominated #5 is reported as undelivered, which
    // it is: nothing in this file carries it.
    expect(result.stats.warnings).toHaveLength(1);
    expect(result.stats.warnings[0]).toContain(`#${WALL_TYPE_ID}`);
    expect(result.stats.warnings[0]).toContain('property-set changes');
  });

  it('...but a FULL export still writes that line: the source pass skipped the entity', async () => {
    const store = await parseBase();
    const { view } = newSession(store);
    view.deletePropertySet(WALL_TYPE_ID, 'Pset_NotOwnedByThisType');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    // `rewrittenEntityIds` made the source-iteration pass skip #5, so this pass
    // owns its only defining line. Withholding an unchanged line here would
    // delete the record from the file — #2469's bug, one branch over. Every
    // source entity must still be present.
    expect(text).toContain(`#${WALL_TYPE_ID}=IFCWALLTYPE`);
    expect(dataEntityLines(text)).toHaveLength(SOURCE_ENTITY_COUNT);
  });
});
