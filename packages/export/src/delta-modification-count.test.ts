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

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      georefMutations: { projectedCRS: { name: 'EPSG:2056' } },
    });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain(`#${CRS_ID}=IFCPROJECTEDCRS('EPSG:2056'`);
    expect(result.stats.modifiedEntityCount).toBe(1);
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
