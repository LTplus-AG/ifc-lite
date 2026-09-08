/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Prepass class column across the real WASM boundary (#2088).
 *
 * The sharded pre-pass sends the per-record prepass class byte across the wasm
 * boundary TWICE, in opposite directions:
 *
 *   out  `scanEntityIndexShard`         -> host (`geometry-parallel.ts` stitches
 *                                         the shards, then calls
 *                                         `extractPrepassSpanLists`)
 *   back `buildPrePassStreamingSharded` -> wasm (`index_classes`, consumed by
 *                                         `discover_from_columns`)
 *
 * The byte packs a named code (2..13) in the low bits with FLAG bits on top
 * (0x80 geometry job, 0x40 type candidate), so BOTH consumers must mask before
 * comparing. Until now nothing pulled class data through the real Rust->WASM
 * path at all: the host tests (`packages/geometry/src/prepass-class-spans.test.ts`)
 * use synthetic columns, and the parity test
 * (`rust/processing/tests/issue_2053_shard_scan_parity.rs`) lives entirely on
 * the Rust side.
 *
 * LIMIT, stated so this is not mistaken for more than it is: the PRODUCER still
 * cannot emit a flagged NAMED code, so the flagged cases below INJECT the flag
 * into a real class column rather than observing one. That injection is not a
 * stub: the flagged column crosses the real wasm boundary as the real
 * `index_classes` argument and is read by the real `discover_from_columns`.
 * What stays uncovered is the producer side, and `no host-consumed code arrives
 * flagged yet` is the tripwire for it.
 *
 * That limit rests on TWO facts, not one, and the second is easy to miss:
 *
 *   1. every named arm in `classify_type_name` returns its bare code before any
 *      flag predicate runs; and
 *   2. `scan_shard_classified` does not call `classify_type_name` — it calls
 *      `classify_type_name_with_content`, which ORs `FLAG_GEOMETRY_JOB` onto the
 *      class AFTER that return, for the #1910 instance-level exception (a
 *      spatial container whose own `Representation` is exceptionally non-null).
 *      Fact 1 alone therefore does NOT bound the producer. What does is that
 *      every keyword reaching that OR (`is_representationless_spatial_container_by_name`)
 *      classifies to `PREPASS_CLASS_NONE`, so the flag only ever lands on a
 *      pure-flag byte.
 *
 * Fact 2 lives in three files that do not reference each other, so
 * `the #1910 representation exception never flags a NAMED code` pins it: widen
 * `is_non_geometric_spatial` to a named-arm keyword and that case fails, instead
 * of `EXPECTED_CLASS` silently becoming wrong for representation-bearing input.
 *
 * Split out of `scripts/test-wasm-contract.mjs` (already several times the size
 * guideline); exported as a function taking that file's `test` harness so
 * pass/fail still lands in the one summary.
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { IfcAPI } from '../../packages/wasm/pkg/ifc-lite.js';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..');

// Synthetic-but-real STEP file: one instance of every keyword the classifier
// names, plus an IFCWALL (geometry job -> 0x80) and an IFCWALLTYPE (type
// candidate -> 0x40) so the flag bytes are exercised too. Inline rather than a
// fetched fixture because the assertion is a per-keyword class contract, not a
// property of any particular model, and no shipped fixture carries all 13.
const CLASS_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('prepass-classes','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0p00000000000000000001',$,'P',$,$,$,$,$,$);
#2=IFCSITE('0p00000000000000000002',$,'S',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#3=IFCSTYLEDITEM($,(#4),$);
#4=IFCPRESENTATIONSTYLEASSIGNMENT((#5));
#5=IFCSURFACESTYLE('s',.BOTH.,(#6));
#6=IFCSURFACESTYLERENDERING(#7,0.,$,$,$,$,$,$,.NOTDEFINED.);
#7=IFCCOLOURRGB($,1.,0.,0.);
#8=IFCINDEXEDCOLOURMAP(#9,$,#7,(1));
#9=IFCTRIANGULATEDFACESET($,$,$,((1,2,3)),$);
#10=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#11),#12);
#11=IFCSTYLEDREPRESENTATION($,$,$,(#3));
#12=IFCMATERIAL('M',$,$);
#13=IFCRELASSOCIATESMATERIAL('0p00000000000000000013',$,$,$,(#20),#12);
#14=IFCRELVOIDSELEMENT('0p00000000000000000014',$,$,$,#20,#21);
#15=IFCRELFILLSELEMENT('0p00000000000000000015',$,$,$,#21,#20);
#16=IFCRELAGGREGATES('0p00000000000000000016',$,$,$,#1,(#2));
#17=IFCMAPPEDITEM(#18,$);
#18=IFCREPRESENTATIONMAP($,$);
#19=IFCRELDEFINESBYTYPE('0p00000000000000000019',$,$,$,(#20),#23);
#20=IFCWALL('0p00000000000000000020',$,'W',$,$,$,$,$,$);
#21=IFCOPENINGELEMENT('0p00000000000000000021',$,'O',$,$,$,$,$,$);
#22=IFCMATERIALLAYERSET((#24),'L',$);
#23=IFCWALLTYPE('0p00000000000000000023',$,'WT',$,$,$,$,$,$,.STANDARD.);
#24=IFCMATERIALLAYER(#12,0.1,$,$,$,$,$);
#25=IFCMATERIALLAYERSETUSAGE(#22,.AXIS2.,.POSITIVE.,0.,$);
ENDSEC;
END-ISO-10303-21;
`;
const CLASS_BYTES = new TextEncoder().encode(CLASS_IFC);

/**
 * The #1910 instance-level exception, which the fixture above cannot express:
 * a spatial container whose `Representation` (slot 6) is exceptionally
 * NON-null. `IFCSITE` is the only named arm that is also an `IfcProduct`
 * spatial container, so it is the one keyword where a named code could start
 * arriving flagged; `IFCBUILDING` is the control that shows the exception is
 * live in this fixture rather than simply not firing.
 */
const SPATIAL_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('prepass-spatial','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSITE('0p00000000000000000001',$,'S',$,$,$,#9,$,.ELEMENT.,$,$,$,$,$);
#2=IFCBUILDING('0p00000000000000000002',$,'B',$,$,$,#9,$,.ELEMENT.,$,$,$);
#9=IFCPRODUCTDEFINITIONSHAPE($,$,(#10));
#10=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#11));
#11=IFCTRIANGULATEDFACESET($,$,$,((1,2,3)),$);
ENDSEC;
END-ISO-10303-21;
`;
const SPATIAL_BYTES = new TextEncoder().encode(SPATIAL_IFC);

/** Mirrors `PREPASS_CLASS_*` in `rust/processing/src/shard_classes.rs`. */
const CLASS_CODE_MASK = 0x3f;
const CLASS_FLAG_GEOMETRY_JOB = 0x80;
const CLASS_FLAG_TYPE_CANDIDATE = 0x40;
/** The classes the browser HOST builds span lists for (`HOST_SPAN_CLASSES`). */
const HOST_CONSUMED_CODES = [4, 5, 6, 7, 8, 9, 10];
/** Expected class byte per keyword, as the producer defines it today. */
const EXPECTED_CLASS = {
  IFCPROJECT: 2,
  IFCSITE: 3,
  IFCSTYLEDITEM: 4,
  IFCINDEXEDCOLOURMAP: 5,
  IFCMATERIALDEFINITIONREPRESENTATION: 6,
  IFCRELASSOCIATESMATERIAL: 7,
  IFCRELVOIDSELEMENT: 8,
  IFCRELFILLSELEMENT: 9,
  IFCRELAGGREGATES: 10,
  IFCMAPPEDITEM: 11,
  IFCRELDEFINESBYTYPE: 12,
  IFCMATERIALLAYERSET: 13,
  IFCMATERIALLAYERSETUSAGE: 13,
  IFCWALL: CLASS_FLAG_GEOMETRY_JOB,
  IFCOPENINGELEMENT: CLASS_FLAG_GEOMETRY_JOB,
  IFCWALLTYPE: CLASS_FLAG_TYPE_CANDIDATE,
};

/**
 * Set BOTH flag bits on every record that carries a NAMED code, leaving
 * pure-flag records (masked code 0 — the classifier's `_` arm) untouched.
 *
 * The distinction is the whole point of the mask. On a named code the flags are
 * decoration that both consumers must ignore; on a pure-flag byte they ARE the
 * payload, and ORing 0x80 onto the 0x40 IFCWALLTYPE record legitimately turns
 * it into a geometry job. Flagging indiscriminately made the discovery
 * comparison below fail for that reason alone, which would have read as a
 * masking bug.
 */
const flagNamedCodes = (classes) =>
  Uint8Array.from(classes, (c) =>
    c & CLASS_CODE_MASK ? c | CLASS_FLAG_GEOMETRY_JOB | CLASS_FLAG_TYPE_CANDIDATE : c,
  );

/** `[id, start, length]` triples of a span list, as plain arrays. */
function triples(spans) {
  const out = [];
  for (let i = 0; i < spans.length; i += 3) out.push([spans[i], spans[i + 1], spans[i + 2]]);
  return out;
}

/** The STEP keyword of the record occupying `[start, start + length)` of `bytes`. */
function keywordInBytes(bytes, start, length) {
  const span = new TextDecoder().decode(bytes.subarray(start, start + length));
  const eq = span.indexOf('=');
  return span.slice(eq + 1, span.indexOf('(', eq)).trim();
}

/** The STEP keyword of the record occupying `[start, start + length)`. */
function keywordIn(start, length) {
  return keywordInBytes(CLASS_BYTES, start, length);
}

/**
 * Register the boundary cases on the caller's `test(name, fn)` harness.
 * `api` is the shared, already-initialised `IfcAPI`.
 */
export async function runPrepassClassBoundaryTests(api, test) {
  console.log('\n📋 prepass class column (wasm <-> host)');

  // One real shard scan, reused by every case below.
  const shard = api.scanEntityIndexShard(CLASS_BYTES, 0, CLASS_BYTES.length);
  const keywordAt = (i) => keywordIn(shard.starts[i], shard.lengths[i]);

  test('scanEntityIndexShard delivers a Uint8Array class column aligned to the ids', () => {
    // Not a type tautology: an Int8Array (or a plain number[]) would still read
    // back through `classes[i] & 0x3f`, so nothing downstream would notice,
    // while the unsigned-flag assertion below would silently become false.
    assert.ok(shard.classes instanceof Uint8Array, 'classes must be a Uint8Array');
    assert.equal(shard.classes.length, shard.ids.length, 'one class byte per record');
    assert.equal(shard.classes.length, shard.starts.length);
    assert.equal(shard.handoff, -1, 'a single shard over the whole file ends at EOF');
  });

  test('every named prepass class reaches the host on the right record', () => {
    const seen = new Set();
    for (let i = 0; i < shard.classes.length; i++) {
      const keyword = keywordAt(i);
      if (!(keyword in EXPECTED_CLASS)) {
        assert.equal(
          shard.classes[i],
          0,
          `${keyword} is not a classified keyword but arrived as ${shard.classes[i]}`,
        );
        continue;
      }
      assert.equal(
        shard.classes[i],
        EXPECTED_CLASS[keyword],
        `${keyword} arrived as ${shard.classes[i]}, expected ${EXPECTED_CLASS[keyword]}`,
      );
      seen.add(keyword);
    }
    assert.equal(
      seen.size,
      Object.keys(EXPECTED_CLASS).length,
      `missing: ${Object.keys(EXPECTED_CLASS).filter((k) => !seen.has(k))}`,
    );
  });

  test('a FLAG bit survives the wasm->host hop as an unsigned byte', () => {
    // #2421's lesson in this repo's terms: a value only survives a boundary if
    // the transport preserves it. 0x80 is the one bit a signed view, a
    // `?? 0`-style normaliser or a narrowing copy would eat, and it is the bit
    // the mask exists for. Assert on the raw byte, before any masking.
    const flagged = [...shard.classes].filter((c) => c >= 0x80);
    assert.ok(flagged.length > 0, 'the fixture must produce at least one geometry-job byte');
    for (const c of flagged) assert.equal(c & CLASS_FLAG_GEOMETRY_JOB, CLASS_FLAG_GEOMETRY_JOB);
    const wallIdx = [...shard.classes.keys()].find((i) => keywordAt(i) === 'IFCWALL');
    assert.notEqual(wallIdx, undefined, 'the fixture must contain an IFCWALL record');
    assert.equal(shard.classes[wallIdx], 128, 'IFCWALL must arrive as 0x80, not -128 or 0');
  });

  test('no host-consumed code arrives flagged yet (the #2088 trigger)', () => {
    // Tripwire, not a behaviour lock. #2088 parked the producer-side boundary
    // test because no named code 4..10 can carry a flag bit today. When that
    // stops being true this fails, and the flagged cases below stop being
    // injection-only — extend them to assert on the producer's own output.
    for (let i = 0; i < shard.classes.length; i++) {
      const c = shard.classes[i];
      if (!HOST_CONSUMED_CODES.includes(c & CLASS_CODE_MASK)) continue;
      assert.equal(
        c & ~CLASS_CODE_MASK,
        0,
        `${keywordAt(i)} now arrives flagged (${c}) — #2088's trigger has fired`,
      );
    }
  });

  test('the #1910 representation exception never flags a NAMED code', () => {
    // The second fact the LIMIT note rests on. `scan_shard_classified` calls
    // `classify_type_name_with_content`, which ORs FLAG_GEOMETRY_JOB onto the
    // class AFTER the named arms have returned — so "named arms return early"
    // does not by itself bound the producer. What bounds it is that every
    // keyword reaching that OR classifies to PREPASS_CLASS_NONE.
    //
    // Both records here carry a non-null Representation, which is what arms the
    // exception.
    const spatial = api.scanEntityIndexShard(SPATIAL_BYTES, 0, SPATIAL_BYTES.length);
    const byKeyword = new Map();
    for (let i = 0; i < spatial.classes.length; i++) {
      byKeyword.set(
        keywordInBytes(SPATIAL_BYTES, spatial.starts[i], spatial.lengths[i]),
        spatial.classes[i],
      );
    }

    // Control FIRST: without this the assertion below passes on a fixture where
    // the exception never fired at all, which is the vacuous reading.
    assert.equal(
      byKeyword.get('IFCBUILDING'),
      CLASS_FLAG_GEOMETRY_JOB,
      'IFCBUILDING with a Representation must arrive as a pure-flag byte — '
      + 'if it does not, the #1910 exception did not fire and this case proves nothing',
    );

    // IFCSITE is the only named arm that is also an IfcProduct spatial
    // container. It must still arrive as its BARE code.
    assert.equal(
      byKeyword.get('IFCSITE'),
      EXPECTED_CLASS.IFCSITE,
      'IFCSITE with a Representation must keep its bare named code — a flagged '
      + 'named code breaks EXPECTED_CLASS above and the LIMIT note at the top',
    );

    // The general form, so a newly-flagged named arm fails here whichever
    // keyword it is.
    for (const [keyword, c] of byKeyword) {
      if ((c & CLASS_CODE_MASK) === 0) continue;
      assert.equal(
        c & ~CLASS_CODE_MASK,
        0,
        `${keyword} arrived as a FLAGGED named code (${c}) — the #1910 exception `
        + 'now reaches a named arm, so the producer-side limit no longer holds',
      );
    }
  });

  // The host consumer lives in @ifc-lite/geometry; import the BUILT module by
  // path (its package exports map does not expose the submodule) so this drives
  // the same code the browser runs rather than a restatement of it.
  const hostConsumerPath = join(ROOT_DIR, 'packages/geometry/dist/geometry-parallel.js');
  const host = existsSync(hostConsumerPath)
    ? await import(pathToFileURL(hostConsumerPath).href)
    : null;
  if (!host) {
    console.log('  ⚠️  packages/geometry/dist missing — run `pnpm build`. Host cases skipped.');
  }

  if (host) {
    test('the real host span extractor reads the real class column', () => {
      assert.equal(
        host.PREPASS_CLASS_CODE_MASK,
        CLASS_CODE_MASK,
        'host mask must match the Rust mask',
      );
      const spans = host.extractPrepassSpanLists(
        shard.classes,
        shard.ids,
        shard.starts,
        shard.lengths,
      );
      // Every host span list must hold exactly the records whose keyword the
      // producer classified into it — checked by decoding the span the host is
      // about to hand back to `resolveStyledItemsShard`/`finalizePrepassStyles`,
      // so a column misaligned by the stitch or by the boundary shows up as the
      // wrong keyword rather than as a plausible-looking id.
      const keywordOfCode = Object.fromEntries(
        Object.entries(EXPECTED_CLASS)
          .filter(([, code]) => HOST_CONSUMED_CODES.includes(code))
          .map(([keyword, code]) => [code, keyword]),
      );
      for (const code of HOST_CONSUMED_CODES) {
        const list = triples(spans.get(code));
        assert.equal(list.length, 1, `class ${code} must have exactly one record in the fixture`);
        const [, start, length] = list[0];
        assert.equal(
          keywordIn(start, length),
          keywordOfCode[code],
          `class ${code}'s span points at the wrong entity`,
        );
      }
    });

    test('a flagged class column still lands in the right host span list', () => {
      // Injection (see the LIMIT note at the top): flag every named record in
      // the REAL column, then re-run the REAL extractor. Dropping the mask in
      // `extractPrepassSpanLists` empties every list here.
      const plain = host.extractPrepassSpanLists(
        shard.classes,
        shard.ids,
        shard.starts,
        shard.lengths,
      );
      const flagged = host.extractPrepassSpanLists(
        flagNamedCodes(shard.classes),
        shard.ids,
        shard.starts,
        shard.lengths,
      );
      for (const code of HOST_CONSUMED_CODES) {
        assert.ok(triples(plain.get(code)).length > 0, `class ${code} must not be vacuously empty`);
        assert.deepEqual(
          triples(flagged.get(code)),
          triples(plain.get(code)),
          `flagging class ${code} changed its span list`,
        );
      }
    });
  }

  /**
   * Run the real sharded pre-pass over `classes` and return its event stream
   * with typed arrays flattened, so two runs can be compared structurally.
   */
  function shardedDiscovery(classes) {
    const events = [];
    const shardedApi = new IfcAPI();
    try {
      shardedApi.buildPrePassStreamingSharded(
        CLASS_BYTES,
        (event) => {
          const flat = {};
          for (const [k, v] of Object.entries(event)) {
            flat[k] = ArrayBuffer.isView(v) ? Array.from(v) : v;
          }
          events.push(flat);
        },
        1 << 20,
        undefined,
        false,
        shard.ids,
        shard.starts,
        shard.lengths,
        classes,
      );
    } finally {
      shardedApi.free();
    }
    return events;
  }

  test('a flagged class column crosses back into wasm without changing discovery', () => {
    // The other direction of the boundary, and the one where a flagged
    // host-consumed code is genuinely injectable today: `index_classes` is a
    // wire argument the HOST supplies, so the real `discover_from_columns`
    // reads a flagged byte here even though the producer cannot yet make one.
    // Dropping `& PREPASS_CLASS_CODE_MASK` in that walk turns every named
    // record into a geometry job and a type candidate, which this catches.
    const plain = shardedDiscovery(shard.classes);
    const flagged = shardedDiscovery(flagNamedCodes(shard.classes));

    // Guard against a vacuous comparison: the run must actually have discovered
    // something for "unchanged" to mean anything.
    const jobsEvent = plain.find((e) => e.type === 'jobs');
    const complete = plain.find((e) => e.type === 'complete');
    assert.ok(jobsEvent && jobsEvent.jobs.length > 0, 'the plain run must discover jobs');
    assert.equal(complete.totalJobs, jobsEvent.jobs.length / 3, 'jobs event must cover totalJobs');

    assert.deepEqual(
      flagged,
      plain,
      'flag bits on the class column must not change what the sharded pre-pass discovers',
    );
  });
}
