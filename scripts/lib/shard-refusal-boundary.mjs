/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * The #3395 refusal count across the real WASM boundary.
 *
 * A record whose instance name does not fit `u32` is DROPPED by the Rust
 * scanner, so it is absent from the entity-index columns by construction and
 * nothing on the host side can recount it. Two wasm outputs are therefore the
 * only evidence that reaches the host at all:
 *
 *   `scanEntityIndexShard(...).oversizedIdStarts`  Uint32Array of global start
 *                                                  bytes, one per refused
 *                                                  record, for the host stitch
 *                                                  (`shard-stitch.ts`) to
 *                                                  attribute.
 *   `buildPrePassStreaming` `entity-index` event   `oversizedIdCount`, the
 *                                                  serial pre-pass's count.
 *
 * Both are read on the host through a silent fallback — `?? new Uint32Array(0)`
 * in `geometry-parallel.ts`, `?? 0` in `entity-scanner.ts` — so a boundary
 * regression (a renamed field, a dropped export, the wrong array type)
 * degrades to "this file refused nothing", which is exactly what a clean file
 * looks like. That is the absence-reads-as-success failure #3395 exists to
 * close, and the earlier rounds of it were silent on precisely this SAB
 * pre-scanned path. The host-side tests
 * (`packages/geometry/src/entity-index-oversized-count.test.ts`,
 * `shard-stitch.test.ts`) all build the columns by hand, so nothing but this
 * file pulls the numbers through the real Rust->WASM path.
 *
 * Both directions are asserted: a file that declares an oversized id must
 * report it, and a file that declares none must report nothing — including one
 * whose quoted value CONTAINS oversized-shaped text, which is the false alarm
 * the shard offsets exist to let the stitch filter out (#3430).
 *
 * Exported as a function taking `test-wasm-contract.mjs`'s `test` harness, per
 * the sibling `prepass-class-boundary.mjs`, so pass/fail lands in one summary.
 */

import assert from 'node:assert/strict';
import { IfcAPI } from '../../packages/wasm/pkg/ifc-lite.js';

const ABOVE_U32 = '4294967297'; // u32::MAX + 2
const encode = (text) => new TextEncoder().encode(text);

const HEADER = 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n';

/** One real oversized declaration between two ordinary records. */
const REFUSING_BYTES = encode(
  `${HEADER}` +
    "#1=IFCPROJECT('g',$,$,$,$,$,$,$,$);\n" +
    `#${ABOVE_U32}=IFCWALL('over',$,$,$,$,$,$,$);\n` +
    "#2=IFCDOOR('g2',$,$,$,$,$,$,$);\n" +
    'ENDSEC;\n',
);

/**
 * No oversized declaration anywhere — but a quoted value containing text
 * shaped like one. `EntityScanner` has no quote context, so a shard that
 * STARTS inside that value reads the text as records and refuses them; a shard
 * that starts at 0 walks the record from its `#` to the terminating `;` and
 * never looks inside. Both facts are asserted below.
 */
const IN_STRING_TEXT = Array.from(
  { length: 40 },
  (_, k) => `#${ABOVE_U32}=IFCWALL(fake ${k} ; still in string `,
).join('');
const CLEAN_TEXT = `${HEADER}#1=IFCWALL('${IN_STRING_TEXT}',$,$,$,$,$,$,$);\n#2=IFCDOOR('g',$,$,$,$,$,$,$);\nENDSEC;\n`;
const CLEAN_BYTES = encode(CLEAN_TEXT);
/** A byte well inside the quoted value, so a shard from here starts mid-string. */
const INSIDE_THE_VALUE = CLEAN_TEXT.indexOf('fake 0');

/** Where the oversized declaration starts in `REFUSING_BYTES`. */
const REFUSED_AT = new TextDecoder()
  .decode(REFUSING_BYTES)
  .indexOf(`#${ABOVE_U32}=`);

/**
 * Register the boundary cases on the caller's `test(name, fn)` harness.
 * `api` is the shared, already-initialised `IfcAPI`.
 */
export function runShardRefusalBoundaryTests(api, test) {
  console.log('\n📋 #3395 refusal count (wasm <-> host)');

  test('scanEntityIndexShard hands back refusal OFFSETS, not a count', () => {
    // Called INSIDE the test rather than at module scope. `test` in
    // scripts/test-wasm-contract.mjs wraps only its `fn()` in try/catch, so a
    // throw out here — a renamed export, a changed Rust signature, a shard-scan
    // trap — escapes the top-level await and aborts the whole contract run.
    // Every later section is then skipped and the pass/fail summary is lost,
    // which is the opposite of what a gate should do when it breaks.
    const whole = api.scanEntityIndexShard(REFUSING_BYTES, 0, REFUSING_BYTES.length);
    // The type is load-bearing, not a tautology: the host stitch compares each
    // entry against a byte boundary (`refusals[k] >= expectedStart`). A count,
    // or a signed/float array, would still index and compare — and would
    // silently attribute the wrong refusals — so pin the shape here where the
    // producer is.
    assert.ok(
      whole.oversizedIdStarts instanceof Uint32Array,
      'oversizedIdStarts must be a Uint32Array of global byte offsets',
    );
    assert.equal(whole.oversizedIdStarts.length, 1, 'one refused record in the fixture');
    assert.equal(
      whole.oversizedIdStarts[0],
      REFUSED_AT,
      'the offset must be the refused record’s global start byte',
    );
    // And the record really is gone from the columns, which is why the offset
    // has to travel: nothing downstream can recount it.
    assert.deepEqual(Array.from(whole.ids), [1, 2], 'the refused id is absent from ids');
  });

  test('a file declaring nothing oversized yields no offsets from a shard at 0', () => {
    // The other direction. A shard starting at 0 is header-aware and walks each
    // record from its `#` to the terminating `;`, so the oversized-shaped text
    // inside the quoted value is never parsed — the serial answer, and zero.
    const clean = api.scanEntityIndexShard(CLEAN_BYTES, 0, CLEAN_BYTES.length);
    assert.equal(clean.oversizedIdStarts.length, 0, 'a clean file refuses nothing');
    assert.deepEqual(Array.from(clean.ids), [1, 2]);
  });

  test('a shard starting inside a quoted value refuses text the file never declared', () => {
    // The reason the boundary carries OFFSETS. This shard's refusals are an
    // artefact of where it started; the host stitch drops the ones below the
    // boundary it validated. If this ever came back empty, the host filter
    // would be untested and a per-shard SUM would look correct — which is the
    // reasoning #3430 retracted.
    const start = INSIDE_THE_VALUE;
    assert.ok(start > 0, 'fixture must contain the in-string text');
    const speculative = api.scanEntityIndexShard(CLEAN_BYTES, start, CLEAN_BYTES.length);
    assert.ok(
      speculative.oversizedIdStarts.length > 0,
      'a mid-string shard must refuse the in-string text, or the host stitch’s ' +
        'attribution filter is never exercised against the real producer',
    );
    for (const offset of speculative.oversizedIdStarts) {
      assert.ok(
        offset >= start,
        'a shard only reports offsets inside the range it scanned',
      );
    }
  });

  test('the serial pre-pass entity-index event carries oversizedIdCount', () => {
    // The non-sharded viewer path. `scanIfcEntities` builds the whole model
    // from these columns without scanning, so this number is the only thing
    // that tells the user the load came back short. `geometry-parallel.ts`
    // reads it as `evt.oversizedIdCount ?? 0`, so a missing field is a silent 0.
    const seen = [];
    // A fresh instance so the shared `api`'s pre-pass cache is left alone.
    const streamingApi = new IfcAPI();
    try {
      streamingApi.buildPrePassStreaming(
        REFUSING_BYTES,
        (event) => {
          if (event.type === 'entity-index') seen.push(event);
        },
        1 << 20,
        undefined,
        false,
      );
    } finally {
      streamingApi.free();
    }

    assert.equal(seen.length, 1, 'the pre-pass must emit exactly one entity-index event');
    const [event] = seen;
    assert.equal(
      typeof event.oversizedIdCount,
      'number',
      'entity-index must carry oversizedIdCount — `?? 0` makes an absent field ' +
        'indistinguishable from a clean file',
    );
    assert.equal(event.oversizedIdCount, 1, 'the one refused record, counted');
    assert.deepEqual(Array.from(event.ids), [1, 2], 'and absent from the columns');
  });
}
