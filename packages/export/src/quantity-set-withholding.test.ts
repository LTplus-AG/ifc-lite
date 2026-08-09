/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * github.com/LTplus-AG/ifc-lite/issues/2487: a full STEP export deleted a
 * SOURCE `IfcElementQuantity` — its container, its quantity atoms and the
 * `IfcRelDefinesByProperties` that attached it — and wrote nothing in its place.
 *
 * Two independent halves produced that, and each is pinned separately here so
 * neither can regress behind the other:
 *
 * 1. **Nothing under the quantity overlay.** `MutablePropertyView` resolves base
 *    PROPERTIES from the `baseTable` it was constructed with or from
 *    `setOnDemandExtractor`; base QUANTITIES have only `setQuantityExtractor`,
 *    which is opt-in and defaults to null. A view without one answers
 *    `getQuantitiesForEntity` from the overlay ALONE, so editing one quantity of
 *    a source set regenerates that set holding only the edited quantity, and the
 *    skip loop withholds the source lines that held its siblings. The exporter
 *    now supplies the base itself — it was handed the store the view overlays —
 *    so this cannot depend on a caller remembering.
 *
 * 2. **Withholding on the strength of a NAME.** The skip loop keyed off the
 *    session's append-only mutation history, which keeps naming a quantity set
 *    after an undo has taken it back out of the overlay. It now withholds only
 *    what the generator actually replaced. There is no quantity-set REMOVAL to
 *    preserve: `deletedQsets` has no public populator, so withholding without a
 *    replacement is always the bug and never the intent.
 *
 * Every case reads the emitted FILE. A count is not evidence here — the drop
 * reported `modifiedEntityCount: 1` and no warning, which reads like a normal
 * successful edit.
 */

import { describe, expect, it } from 'vitest';
import { QuantityType } from '@ifc-lite/data';
import {
  IfcParser,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const WALL_ID = 8;
const QSET_NAME = 'Qto_WallBaseQuantities';

/** `#8` owns a two-quantity source `Qto_WallBaseQuantities` (#60/#61/#63) and
 *  the relationship #62 that attaches it. */
const BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-08-08T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#8=IFCWALL('0OSuGGYUFyIf0LtE29OSuH',$,'Existing Wall',$,$,$,$,$,$);
#60=IFCELEMENTQUANTITY('0OSuGGYUFyIf0LtE29OSuV',$,'Qto_WallBaseQuantities',$,$,(#61,#63));
#61=IFCQUANTITYVOLUME('NetVolume',$,$,1.5,$);
#63=IFCQUANTITYAREA('NetSideArea',$,$,7.25,$);
#62=IFCRELDEFINESBYPROPERTIES('0OSuGGYUFyIf0LtE29OSuW',$,$,$,(#8),#60);
ENDSEC;
END-ISO-10303-21;`;

async function parseBase(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(BASE_IFC)));
}

/** Every `#id=CLASS(...)` defining line in the DATA section. */
function dataEntityLines(stepText: string): string[] {
  const start = stepText.indexOf('DATA;') + 'DATA;'.length;
  const data = stepText.slice(start, stepText.indexOf('ENDSEC;', start));
  return data.split('\n').map((l) => l.trim()).filter((l) => /^#\d+\s*=/.test(l));
}

/**
 * The shape the issue reports: a source-backed store, the PROPERTY extractor
 * wired as every in-tree site wires it, and no quantity extractor. This is
 * `packages/cli/src/commands/mutate.ts` before this change, and it is what an
 * external embedder of the published `StepExporter` / `MutablePropertyView`
 * gets by default.
 */
function viewWithNoQuantityBase(store: IfcDataStore): MutablePropertyView {
  const view = new MutablePropertyView(null, 'test-model');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  return view;
}

function exportText(store: IfcDataStore, view: MutablePropertyView): string {
  return new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4' }).content);
}

/** The quantities of `qsetName` as the emitted file states them, in file order. */
function emittedQuantities(stepText: string): Array<[string, string]> {
  const atoms: Array<[string, string]> = [];
  for (const line of dataEntityLines(stepText)) {
    const m = /^#\d+=(IFCQUANTITY[A-Z]+)\('([^']*)'/.exec(line);
    if (m) atoms.push([m[2], m[1]]);
  }
  return atoms;
}

describe('a quantity edit never loses the source set’s other quantities', () => {
  it('editing ONE quantity keeps its siblings, with no quantity extractor wired', async () => {
    // Reproduction 2 from #2487: no undo at all, one ordinary edit.
    const store = await parseBase();
    const view = viewWithNoQuantityBase(store);
    view.setQuantity(WALL_ID, QSET_NAME, 'GrossArea', 12.0, QuantityType.Area);

    const text = exportText(store, view);

    // All three quantities are in the file: the two the SOURCE declared and the
    // one this session added. Before, the replacement held `GrossArea` alone
    // and #60/#61/#63/#62 were withheld — `NetVolume` and `NetSideArea` were
    // simply gone from the user's saved file.
    expect(emittedQuantities(text)).toEqual([
      ['NetVolume', 'IFCQUANTITYVOLUME'],
      ['NetSideArea', 'IFCQUANTITYAREA'],
      ['GrossArea', 'IFCQUANTITYAREA'],
    ]);
    expect(text).toContain("IFCQUANTITYVOLUME('NetVolume',$,$,1.5,$)");
    expect(text).toContain("IFCQUANTITYAREA('NetSideArea',$,$,7.25,$)");
    expect(text).toContain("IFCQUANTITYAREA('GrossArea',$,$,12.,$)");

    // ...and they are in ONE container, not two: the source set was genuinely
    // replaced, not left standing beside a partial duplicate of itself.
    const containers = dataEntityLines(text).filter((l) => l.includes('IFCELEMENTQUANTITY'));
    expect(containers).toHaveLength(1);
    expect(containers[0]).toContain(`'${QSET_NAME}'`);
  });

  it('an UNDONE quantity creation leaves the source set intact', async () => {
    // Reproduction 1: `setQuantity` then `removeQuantityMutation`, which is
    // verbatim what the viewer's undo runs on Ctrl+Z of a quantity creation.
    // The append-only history still names the qset afterwards, which is what
    // used to keep the skip loop matching it.
    const store = await parseBase();
    const view = viewWithNoQuantityBase(store);
    view.setQuantity(WALL_ID, QSET_NAME, 'GrossArea', 12.0, QuantityType.Area);
    view.removeQuantityMutation(WALL_ID, QSET_NAME, 'GrossArea');

    const text = exportText(store, view);

    // The undone quantity is not in the file, and the two the file came with
    // are. Before, ALL of it was gone: exporting the file WITH the quantity set
    // produced exactly the file WITHOUT it.
    expect(emittedQuantities(text)).toEqual([
      ['NetVolume', 'IFCQUANTITYVOLUME'],
      ['NetSideArea', 'IFCQUANTITYAREA'],
    ]);
    expect(text).not.toContain('GrossArea');
    expect(text).toContain(`'${QSET_NAME}'`);
    // The wall still has a route to its quantities — dropping the relationship
    // and keeping the container would lose them just as thoroughly.
    expect(text).toMatch(/IFCRELDEFINESBYPROPERTIES\('[^']*',\$,\$,\$,\(#8\),#\d+\)/);
  });

  it('the SOURCE LINES survive verbatim when the generator writes no replacement', async () => {
    // The withhold gate on its own, with the exporter's base fallback OUT of
    // the picture: this view HAS a quantity extractor, so nothing is installed
    // over it — the extractor simply reports no quantities for this entity, as
    // one over a partial or foreign base would. The generator therefore
    // produces nothing for a name the history still mentions, and the source
    // lines must be left exactly as the file wrote them.
    const store = await parseBase();
    const view = viewWithNoQuantityBase(store);
    view.setQuantityExtractor(() => []);
    view.setQuantity(WALL_ID, QSET_NAME, 'GrossArea', 12.0, QuantityType.Area);
    view.removeQuantityMutation(WALL_ID, QSET_NAME, 'GrossArea');

    const text = exportText(store, view);

    // Said the strongest way available: byte-identical source lines, original
    // express ids and original GlobalIds, because nothing replaced them.
    expect(text).toContain(
      "#60=IFCELEMENTQUANTITY('0OSuGGYUFyIf0LtE29OSuV',$,'Qto_WallBaseQuantities',$,$,(#61,#63));",
    );
    expect(text).toContain("#61=IFCQUANTITYVOLUME('NetVolume',$,$,1.5,$);");
    expect(text).toContain("#63=IFCQUANTITYAREA('NetSideArea',$,$,7.25,$);");
    expect(text).toContain(
      "#62=IFCRELDEFINESBYPROPERTIES('0OSuGGYUFyIf0LtE29OSuW',$,$,$,(#8),#60);",
    );
  });

  it('a caller’s own quantity base is never overwritten', async () => {
    // The exporter installs a base only when there is none. A view that
    // resolves its own quantities — the viewer, MCP, the CLI headless backend —
    // must keep answering from ITS extractor, or the exporter would silently
    // overrule a caller who is deliberately exporting against a different base.
    const store = await parseBase();
    const view = viewWithNoQuantityBase(store);
    view.setQuantityExtractor(() => [
      { name: QSET_NAME, quantities: [{ name: 'FromCaller', type: QuantityType.Length, value: 9 }] },
    ]);
    view.setQuantity(WALL_ID, QSET_NAME, 'GrossArea', 12.0, QuantityType.Area);

    const text = exportText(store, view);

    expect(emittedQuantities(text)).toEqual([
      ['FromCaller', 'IFCQUANTITYLENGTH'],
      ['GrossArea', 'IFCQUANTITYAREA'],
    ]);
    // The caller's base said the set holds `FromCaller`, so the source atoms it
    // did NOT mention are genuinely replaced, not resurrected.
    expect(text).not.toContain('NetVolume');
    expect(text).not.toContain('#60=IFCELEMENTQUANTITY');
  });

  it('a view exported against a SECOND store reads the second store’s quantities', async () => {
    // The exporter's base closes over one store and the view outlives the
    // export, so "install only when absent" on its own would have let a second
    // export answer from the first file. A session held across a re-parse — the
    // gym loop's shape — is the reachable version of that.
    const first = await parseBase();
    const view = viewWithNoQuantityBase(first);
    view.setQuantity(WALL_ID, QSET_NAME, 'GrossArea', 12.0, QuantityType.Area);
    expect(exportText(first, view)).toContain("IFCQUANTITYVOLUME('NetVolume',$,$,1.5,$)");

    const second = await new IfcParser().parseColumnar(
      toArrayBuffer(new TextEncoder().encode(BASE_IFC.replace('1.5,$', '9.75,$'))),
    );
    const text = exportText(second, view);

    // The second file's value, not the first's — and the caller's own extractor
    // would still have won, since it is only the exporter's own base that is
    // ever replaced.
    expect(text).toContain("IFCQUANTITYVOLUME('NetVolume',$,$,9.75,$)");
    expect(text).not.toContain('1.5');
  });

  it('control: a replaced quantity set really does withhold its source lines', async () => {
    // The bounding case for the gate. A set the generator DOES replace must
    // still have its source container, atoms and relationship left out —
    // otherwise the fix trades a deletion for a duplicated, contradictory
    // quantity set and a stale value that survives the edit.
    const store = await parseBase();
    const view = viewWithNoQuantityBase(store);
    view.setQuantityExtractor((id: number) => extractQuantitiesOnDemand(store, id));
    view.setQuantity(WALL_ID, QSET_NAME, 'NetVolume', 2.5, QuantityType.Volume);

    const text = exportText(store, view);

    expect(text).not.toContain('#60=IFCELEMENTQUANTITY');
    expect(text).not.toContain('#61=IFCQUANTITYVOLUME');
    expect(text).not.toContain("'0OSuGGYUFyIf0LtE29OSuW'");
    expect(text).toContain("IFCQUANTITYVOLUME('NetVolume',$,$,2.5,$)");
    expect(text).not.toContain('1.5');
    expect(dataEntityLines(text).filter((l) => l.includes('IFCELEMENTQUANTITY'))).toHaveLength(1);
  });

  it('a session with no quantity edits at all is untouched', async () => {
    // The base fallback is installed only when a quantity edit exists, so a
    // geometry- or property-only session (`demesh-session.ts` builds a bare view
    // for exactly that) pays nothing and emits the source quantity lines through
    // the ordinary source-iteration pass.
    const store = await parseBase();
    const view = viewWithNoQuantityBase(store);

    const before = new TextDecoder().decode(new StepExporter(store).export({ schema: 'IFC4' }).content);
    const after = exportText(store, view);

    expect(dataEntityLines(after)).toEqual(dataEntityLines(before));
    expect(view.hasQuantityBase()).toBe(false);
  });
});
