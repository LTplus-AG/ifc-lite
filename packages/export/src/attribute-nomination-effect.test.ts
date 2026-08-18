/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * github.com/LTplus-AG/ifc-lite/issues/2483: the attribute nomination site was
 * the last one in the family that counted INTENT.
 *
 * Two reachable no-ops on the FULL export path claimed a modification over a
 * file byte-identical to its input:
 *
 *   - `setAttribute(id, 'Name', v)` where `v` is the value already in the slot;
 *   - `setAttribute(id, name, v)` where the class declares no slot by `name`,
 *     which `applyAttributeMutations` discards.
 *
 * Both are measured the way the rest of the family is: against the emitted
 * FILE. Each case asserts the DATA section first and the count second, so a
 * count that went to zero by dropping the edit rather than by declining to
 * claim it fails here.
 *
 * `deltaOnly` keeps nominating at intent, deliberately — its per-kind warning
 * exists to NAME an edit the delta format could not carry, and an edit that is
 * undeliverable is exactly the one that must still be nominated. The last block
 * is the bounding control for that.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** The "N modification(s)" the HEADER claims, or null when it makes no claim. */
function headerClaimedModifications(stepText: string): number | null {
  const m = /Re-exported by ifc-lite, (\d+) modification/.exec(stepText);
  return m ? Number(m[1]) : null;
}

const WALL_ID = 8;
const WALL_TYPE_ID = 5;
const CRS_ID = 40;
const MAP_CONVERSION_ID = 41;
const WALL_NAME = 'Existing Wall';
/** The `Name` an IfcProjectedCRS is already carrying in {@link BASE_IFC}. */
const CRS_NAME = 'EPSG:1000';
/** The `Eastings` an IfcMapConversion is already carrying in {@link BASE_IFC}. */
const MAP_CONVERSION_EASTINGS = 1000;

const BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-08-08T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#5=IFCWALLTYPE('0OSuGGYUFyIf0LtE29OSuT',$,'WT1',$,$,(#30),$,$,$,.STANDARD.);
#8=IFCWALL('0OSuGGYUFyIf0LtE29OSuH',$,'${WALL_NAME}',$,$,$,$,$,$);
#30=IFCPROPERTYSET('0OSuGGYUFyIf0LtE29OSuP',$,'Pset_TypeOwned',$,(#31));
#31=IFCPROPERTYSINGLEVALUE('Foo',$,IFCTEXT('old'),$);
#40=IFCPROJECTEDCRS('${CRS_NAME}',$,$,$,$,$,$);
#41=IFCMAPCONVERSION($,#40,${MAP_CONVERSION_EASTINGS}.,2000.,0.,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function parseBase(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(BASE_IFC)));
}

/** The `#8=IFCWALL(...)` line the export wrote, or undefined. */
function wallLine(stepText: string): string | undefined {
  return stepText.split('\n').map((l) => l.trim()).find((l) => l.startsWith(`#${WALL_ID}=`));
}

const SOURCE_WALL_LINE =
  `#${WALL_ID}=IFCWALL('0OSuGGYUFyIf0LtE29OSuH',$,'${WALL_NAME}',$,$,$,$,$,$);`;

describe('a full export counts an attribute edit only when the line changed', () => {
  it('setAttribute to the value already in the slot claims nothing', async () => {
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    view.setAttribute(WALL_ID, 'Name', WALL_NAME);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    // The FILE first: the wall's line is byte-identical to its source, which
    // is what makes the claim false.
    expect(wallLine(text)).toBe(SOURCE_WALL_LINE);
    expect(result.stats.modifiedEntityCount).toBe(0);
    expect(headerClaimedModifications(text)).toBeNull();
  });

  it('setAttribute naming a slot the class does not declare claims nothing', async () => {
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    // IfcWall has no `NotASlot`. `applyAttributeMutations` resolves no index
    // for it and returns the line untouched — the `attributed` flag has always
    // reported this correctly for the DELIVERY question under deltaOnly.
    view.setAttribute(WALL_ID, 'NotASlot', 'whatever');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    expect(wallLine(text)).toBe(SOURCE_WALL_LINE);
    expect(result.stats.modifiedEntityCount).toBe(0);
    expect(headerClaimedModifications(text)).toBeNull();
  });

  it('a real rename still counts once', async () => {
    // The bounding control: settling from effect and then never recording the
    // effect would zero the count for every real edit just as quietly.
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    view.setAttribute(WALL_ID, 'Name', 'Renamed Wall');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    expect(wallLine(text)).toContain("'Renamed Wall'");
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(headerClaimedModifications(text)).toBe(1);
  });

  it('a real rename plus a no-op edit on the SAME host still counts once', async () => {
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    view.setAttribute(WALL_ID, 'Name', 'Renamed Wall');
    view.setAttribute(WALL_ID, 'NotASlot', 'whatever');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });

    expect(result.stats.modifiedEntityCount).toBe(1);
  });
});

describe('a georeferencing edit is the same site with the same signal', () => {
  it('writing the Name the IfcProjectedCRS already has claims nothing', async () => {
    // The georef branch queues its fields into the very same
    // `modifiedAttributes` map and its `changed` flag is INTENT — a field was
    // supplied, not a field that differs. Found in the same sweep as #2483's
    // two cases and fixed with them, since it is the same mechanism one site
    // over.
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      georefMutations: { projectedCRS: { name: CRS_NAME } },
    });
    const text = new TextDecoder().decode(result.content);

    const crsLine = text.split('\n').map((l) => l.trim()).find((l) => l.startsWith(`#${CRS_ID}=`));
    expect(crsLine).toBe(`#${CRS_ID}=IFCPROJECTEDCRS('${CRS_NAME}',$,$,$,$,$,$);`);
    expect(result.stats.modifiedEntityCount).toBe(0);
    expect(headerClaimedModifications(text)).toBeNull();
  });

  it('writing a DIFFERENT Name still counts and still lands', async () => {
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      georefMutations: { projectedCRS: { name: 'EPSG:2056' } },
    });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain(`#${CRS_ID}=IFCPROJECTEDCRS('EPSG:2056'`);
    expect(result.stats.modifiedEntityCount).toBe(1);
  });

  it('writing a DIFFERENT Eastings on IfcMapConversion still counts and still lands', async () => {
    // The MapConversion branch queues into the same `modifiedAttributes` map
    // as the CRS branch above and gates its nomination the same way
    // (`hasEmittableHostBytes`) — this is that branch's own sibling case,
    // parallel to the CRS one directly above it.
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      georefMutations: { mapConversion: { eastings: MAP_CONVERSION_EASTINGS + 500 } },
    });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain(`#${MAP_CONVERSION_ID}=IFCMAPCONVERSION($,#${CRS_ID},1500.`);
    expect(result.stats.modifiedEntityCount).toBe(1);
  });
});

describe('the type-object rewrite path is a second site for the same nomination', () => {
  it('a type object whose line the pset REWRITE writes still counts its rename', async () => {
    // `rewrittenEntityIds` makes the source-iteration pass skip this host, so
    // the `HasPropertySets` rewrite is the only place a full export sees the
    // rename land. On this branch the property-set nomination alone already
    // makes #5 count, so this asserts the count does not MOVE; it is the site
    // that has to be wired, per site rather than per feature, because #2481
    // settles the property-set kind from effect too and then the rename is the
    // only thing left holding the count up.
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    view.setAttribute(WALL_TYPE_ID, 'Name', 'WT2');
    view.setProperty(WALL_TYPE_ID, 'Pset_TypeOwned', 'Foo', 'new');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    const typeLine = text.split('\n').map((l) => l.trim())
      .find((l) => l.startsWith(`#${WALL_TYPE_ID}=`));
    expect(typeLine).toContain("'WT2'");
    expect(result.stats.modifiedEntityCount).toBe(1);
  });
});

describe('deltaOnly still nominates an attribute edit at INTENT', () => {
  it('a no-op rename is still NAMED by the per-kind warning', async () => {
    // The point of the deltaOnly warning is to name an edit the delta could not
    // carry. Converting the full path to effect must not take the nomination
    // away from the mode whose whole job is reporting the undeliverable.
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    view.setAttribute(WALL_ID, 'Name', WALL_NAME);

    const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });

    expect(result.stats.modifiedEntityCount).toBe(0);
    expect(result.stats.warnings?.some((w) => w.includes('attribute edits'))).toBe(true);
  });

  it('a real rename is named too - a delta carries no source lines', async () => {
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    view.setAttribute(WALL_ID, 'Name', 'Renamed Wall');

    const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });

    expect(result.stats.modifiedEntityCount).toBe(0);
    expect(result.stats.warnings?.some((w) => w.includes('attribute edits'))).toBe(true);
  });
});
