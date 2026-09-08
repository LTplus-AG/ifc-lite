/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `onRejected` callback at the THIRD call site of
 * `PropertySetContext.applySourceLineMutations` — the type-owned
 * `HasPropertySets` rewrite in `step-property-sets.ts`
 * (`rewriteTypeOwnedPsetLine`'s caller) — had no test (#2475 step 2b/2c,
 * PR #2751). The other two call sites (the plain source-iteration rewrite in
 * `step-exporter.ts`, and the overlay-created rewrite) are covered by
 * `real-slot-non-numeric.test.ts`. A silently-unwired callback here means a
 * non-numeric REAL attribute on a TYPE OBJECT is quoted into the output
 * instead of rejected — the exact defect #2811/#2741 fixed, reintroduced on
 * this one branch.
 *
 * Reaching this call site (and ONLY this one) requires an entity that:
 *   - is a source (non-overlay-created) `IfcTypeObject` subtype with a
 *     REAL-typed attribute of its own (`IfcMechanicalFastenerType.
 *     NominalDiameter`, an `IfcPositiveLengthMeasure`), edited with a
 *     non-numeric value, AND
 *   - has a property-set edit that touches one of its TYPE-OWNED
 *     `HasPropertySets` entries, which is what makes the collection pass
 *     add it to `pass.rewrittenEntityIds`.
 *
 * `rewrittenEntityIds` is exactly the set the source-iteration pass in
 * `step-exporter.ts` SKIPS (`if (pass.rewrittenEntityIds.has(expressId))
 * continue;`) — its comment says the type-owned rewrite "writes the line
 * this pass would otherwise have written". So for THIS entity, the
 * source-iteration call site never runs at all: the type-owned call site is
 * the only place that can see the attribute mutation and reject it. That
 * structural exclusion is what makes this fixture pin the third site
 * specifically, rather than merely duplicate `real-slot-non-numeric.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

const FASTENER_TYPE_ID = 5;

const BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#5=IFCMECHANICALFASTENERTYPE('0OSuGGYUFyIf0LtE29OSuT',$,'MFT1',$,$,(#30),$,$,$,.BOLT.,$,$);
#30=IFCPROPERTYSET('0OSuGGYUFyIf0LtE29OSuP',$,'Pset_TypeOwned',$,(#31));
#31=IFCPROPERTYSINGLEVALUE('Foo',$,IFCTEXT('old'),$);
ENDSEC;
END-ISO-10303-21;`;

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

async function parseBase(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(BASE_IFC)));
}

/** The single defining line for `expressId`, or null. */
function lineFor(stepText: string, expressId: number): string | null {
  const m = new RegExp(`^#${expressId}\\s*=.*$`, 'm').exec(stepText);
  return m ? m[0] : null;
}

describe('a non-numeric REAL attribute rejected through the type-owned pset rewrite', () => {
  it('is not quoted into HasPropertySets-owning entity line, and says so', async () => {
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    const editor = new StoreEditor(store, view);

    // A REAL-typed attribute owned by the type object itself, given a
    // non-numeric value.
    editor.setAttribute(FASTENER_TYPE_ID, 'NominalDiameter', 'abc');
    // A property-set edit that touches the type-owned Pset_TypeOwned — this
    // is what routes #5 into `pass.rewrittenEntityIds`, which in turn makes
    // the source-iteration pass SKIP #5 entirely (see file header). The only
    // remaining path that can apply/reject the NominalDiameter edit is the
    // type-owned rewrite in `step-property-sets.ts`.
    editor.addPropertySet(FASTENER_TYPE_ID, 'Pset_TypeOwned', [
      { name: 'Foo', value: 'new', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);
    const line = lineFor(text, FASTENER_TYPE_ID) ?? '';
    const warnings = result.stats.warnings.join('\n');

    // Confirms we actually reached the type-owned rewrite and not some other
    // path: `HasPropertySets` (#30) was repointed at the regenerated pset.
    expect(line).not.toContain('(#30)');
    expect(line).toContain('IFCMECHANICALFASTENERTYPE');

    // The violation this pins: a non-numeric value must not be quoted into a
    // REAL slot.
    expect(line, 'a non-numeric value was written into a REAL slot').not.toContain("'abc'");
    // The slot keeps what the source had (optional, unset -> `$`), not the
    // rejected edit.
    expect(line).toMatch(/,\$,\.BOLT\.,\$,\$\);$/);
    // ...and the drop is visible, not inferred from absence.
    expect(warnings).toContain(`#${FASTENER_TYPE_ID}`);
    expect(warnings).toContain('NominalDiameter');
    expect(warnings).toMatch(/not a number/);
  });

  it('control: the same edit alone (no type-owned pset edit) still rejects via the plain source path', async () => {
    // This is the sibling call site's territory (source-iteration pass) —
    // included only to show the pset edit above is what moves the entity
    // onto the type-owned path, not something intrinsic to the entity class.
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    const editor = new StoreEditor(store, view);
    editor.setAttribute(FASTENER_TYPE_ID, 'NominalDiameter', 'abc');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);
    const line = lineFor(text, FASTENER_TYPE_ID) ?? '';
    const warnings = result.stats.warnings.join('\n');

    // Untouched pset list this time: no type-owned rewrite ran.
    expect(line).toContain('(#30)');
    expect(line).not.toContain("'abc'");
    expect(warnings).toContain(`#${FASTENER_TYPE_ID}`);
    expect(warnings).toContain('NominalDiameter');
  });
});
