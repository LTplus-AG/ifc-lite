/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a `deltaOnly` export emits when it has nothing to say.
 *
 * Read the next paragraph before treating this file as a guard on the
 * short-circuit in `export()`, because it is not one.
 *
 * `export()` returns early with a header-only file when a delta export has no
 * modified entities, no overlay-created entities and no new georeferencing
 * lines. Nothing pinned that branch, so before moving it for #2475 I disabled
 * it (`if (false && …)`) to find out what would notice. Nothing did: the suite
 * stayed green at 885/885, and it stayed green at 888/888 with the three tests
 * below added. **The branch is an early-out, not a behaviour** — for a model
 * with no edits the ordinary path arrives at the same bytes and the same
 * stats, which is why disabling it changes nothing observable. It cannot be
 * pinned by a behavioural test, and a test claiming to pin it would be
 * measuring its own fixture.
 *
 * That is worth knowing for the #2475 split specifically: turning this
 * `return` into a value the caller returns is behaviour-preserving by
 * construction, not on trust.
 *
 * What these tests DO pin is the contract itself, which was genuinely
 * untested by either route: a delta export of an unedited model emits a
 * header and an empty DATA section, reports zeroed stats, and reports a
 * `fileSize` matching the bytes it actually produced. That holds whichever
 * path computes it, and it would fail if either path stopped holding it.
 *
 * Note which existing tests do NOT cover this, since their names suggest they
 * might: `delta-modification-count.test.ts`'s empty-delta cases and
 * `step-georeferencing.test.ts`'s deltaOnly block both edit an existing
 * entity, which populates `pass.modifiedEntities` via `step-collection.ts`, so
 * the condition is false and neither reaches this state at all. The
 * counterpart at `step-exporter.test.ts:1250` pins the opposite direction:
 * overlay-created entities must stop the short-circuit firing.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,$,$);
#10=IFCWALL('0wall10000000000000000',$,'W',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function store() {
  return new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer, { disableWorkerScan: true });
}

describe('a deltaOnly export with nothing to say short-circuits', () => {
  it('emits a header and an empty DATA section, not the model', async () => {
    // No edits at all: modifiedEntities, overlay-created entities and new
    // georef lines are all empty, which is the branch's whole condition.
    const out = new StepExporter(await store(), new MutablePropertyView(null, 'm'))
      .export({ schema: 'IFC4', deltaOnly: true, applyMutations: true });
    const text = decode(out.content);

    expect(text).toContain('DATA;');
    expect(text).toContain('END-ISO-10303-21;');
    // The model's own entities must NOT be there. Without the short-circuit
    // the export runs its normal passes and the wall comes back.
    expect(text).not.toContain('IFCWALL');
    expect(text).not.toContain('IFCPROJECT');
  });

  it('reports zeroed stats and a fileSize matching what it actually emitted', async () => {
    const out = new StepExporter(await store(), new MutablePropertyView(null, 'm'))
      .export({ schema: 'IFC4', deltaOnly: true, applyMutations: true });

    expect(out.stats.entityCount).toBe(0);
    expect(out.stats.newEntityCount).toBe(0);
    expect(out.stats.modifiedEntityCount).toBe(0);
    // Not a restatement of the branch: `fileSize` is computed from the encoded
    // bytes, so this catches a rewrite that returns the right stats alongside
    // the wrong content.
    expect(out.stats.fileSize).toBe(out.content.byteLength);
  });

  it('does not short-circuit a full export of the same untouched model', async () => {
    // The counter-example. Everything above must hold BECAUSE of `deltaOnly`,
    // not because an unedited model exports as empty.
    const out = new StepExporter(await store(), new MutablePropertyView(null, 'm'))
      .export({ schema: 'IFC4', applyMutations: true });

    expect(decode(out.content)).toContain('IFCWALL');
    expect(out.stats.entityCount).toBeGreaterThan(0);
  });
});
