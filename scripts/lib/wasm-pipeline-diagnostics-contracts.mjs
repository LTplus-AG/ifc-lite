/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** getPipelineDiagnostics on the real WASM boundary, incl. C4-10a #7782 S6a refusal counters and F2 #8341 omitted type records. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

export async function runPipelineDiagnosticsContracts({ IfcAPI, test, root: ROOT_DIR, columnContent }) {
  // ===== Pipeline diagnostics channel (wasm boundary) =====
  // This replaces the orphaned rust/wasm-bindings/tests/pipeline_diagnostics.rs
  // (a #![cfg(target_arch="wasm32")] test no CI lane ran) with an assertion in
  // the lane that DOES gate (node-tests -> the required Build+WASM+Rust+Node
  // check). It pins the versioned wire shape across the real serde-wasm-bindgen
  // boundary, mirroring the Rust serde-key stability test.
  test('getPipelineDiagnostics: undefined before load, accumulates across batches, versioned, persists post-load, resets on the next load', () => {
    const diagApi = new IfcAPI();
    const bytes = new TextEncoder().encode(columnContent);
    try {
      assert.equal(diagApi.getPipelineDiagnostics(), undefined,
        'diagnostics must be undefined before any batch runs');

      // One load = one buildPrePassOnce (which resets the accumulator) followed by
      // N processGeometryBatch calls (the viewer's per-batch loop).
      const pre = diagApi.buildPrePassOnce(bytes);
      assert.ok(pre.totalJobs > 0, 'fixture must produce geometry jobs');
      const runBatch = () => {
        const c = diagApi.processGeometryBatch(
          bytes, pre.jobs, pre.unitScale,
          pre.rtcOffset[0], pre.rtcOffset[1], pre.rtcOffset[2], pre.needsShift,
          pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
        );
        c.free();
      };

      runBatch();
      const one = diagApi.getPipelineDiagnostics();
      assert.ok(one && typeof one === 'object', 'diagnostics must be an object after a batch');
      // Versioned wire shape: the schema-stability contract on the real boundary.
      assert.equal(one.schemaVersion, 1, 'schemaVersion must match the pinned contract (bump = breaking)');
      assert.equal(one.batches, 1, 'exactly one batch recorded');
      assert.equal(one.refusedInputElements, 0);
      assert.equal(one.refusedPrepassRecords, 0);
      // Real VALUES, not just key presence: the column fixture has geometry, so a
      // serde bug emitting zero/wrong counts would be caught.
      assert.ok(one.meshCount > 0, 'meshCount > 0');
      assert.ok(one.triangleCount > 0, 'triangleCount > 0');
      assert.ok(one.elementCount > 0, 'elementCount > 0');
      for (const key of ['backstopCount', 'totalCsgFailures', 'productsWithFailures',
        'hostsWithOpenings', 'silentNoOps', 'rectFast', 'phaseMs']) {
        assert.ok(key in one, `diagnostics must carry ${key}`);
      }
      for (const key of ['entityScanMs', 'lookupMs', 'preprocessMs', 'parseMs', 'geometryMs', 'totalMs']) {
        assert.ok(key in one.phaseMs, `phaseMs must carry ${key}`);
      }

      // A second processGeometryBatch of the SAME load ACCUMULATES: record_batch
      // sums per batch, so batches increments and the counts never decrease.
      runBatch();
      const two = diagApi.getPipelineDiagnostics();
      assert.equal(two.batches, 2, 'batches accumulate across processGeometryBatch calls');
      assert.ok(two.meshCount >= one.meshCount, 'meshCount accumulates (monotonic)');
      assert.ok(two.elementCount >= one.elementCount, 'elementCount accumulates (monotonic)');
      assert.ok(two.triangleCount >= one.triangleCount, 'triangleCount accumulates (monotonic)');

      // Diagnostics survive clearPrePassCache: it runs at end-of-load, and a host
      // reads the per-load diagnostics AFTER it (see IfcAPI::clear_pre_pass_cache,
      // which clears the entity/parts caches but NOT the accumulator).
      diagApi.clearPrePassCache();
      assert.ok(diagApi.getPipelineDiagnostics(), 'diagnostics persist for reading after clearPrePassCache');

      // The next load resets the accumulator (buildPrePassOnce calls
      // reset_pipeline_diagnostics before the new batch runs).
      diagApi.buildPrePassOnce(bytes);
      assert.equal(diagApi.getPipelineDiagnostics(), undefined,
        'a new load (buildPrePassOnce) resets the accumulator until its first batch');
    } finally {
      diagApi.clearPrePassCache();
      diagApi.free();
    }
  });

  test('C4-10a #7782: refused input attempts and distinct refused leaf records exclude syntax failures in real WASM', () => {
    const diagApi = new IfcAPI();
    const source = readFileSync(join(ROOT_DIR, 'rust/processing/tests/fixtures/c4_0_refusal_parity_7782.ifc'), 'utf8')
      .replace('ENDSEC;\nEND-ISO', "#400=IFCWALL('bad',$,$,$,INVALID,#5,#303,$,.NOTDEFINED.);\n#500=IFCBOILERTYPE('bad',$,$,$,INVALID,$,(#501),$,$,.NOTDEFINED.);\n#501=IFCREPRESENTATIONMAP(#4,#302);\nENDSEC;\nEND-ISO");
    const bytes = new TextEncoder().encode(source);
    try {
      const pre = diagApi.buildPrePassOnce(bytes);
      assert.ok(!Array.from(pre.jobs).filter((_, i) => i % 3 === 0).includes(500));
      for (const attempts of [2, 4]) {
        const meshes = diagApi.processGeometryBatch(bytes, pre.jobs, pre.unitScale,
          ...pre.rtcOffset, pre.needsShift, pre.voidKeys, pre.voidCounts, pre.voidValues,
          pre.styleIds, pre.styleColors, pre.planeAngleToRadians);
        meshes.free();
        const diag = diagApi.getPipelineDiagnostics();
        assert.equal(diag.schemaVersion, 1);
        assert.equal(diag.refusedInputElements, attempts);
        assert.equal(diag.refusedPrepassRecords, 1);
        assert.equal(diag.omittedTypeRecords, 1, 'F2: the dropped type #500 is counted separately, once');
      }
    } finally { diagApi.clearPrePassCache(); diagApi.free(); }
  });

  test('F2 #8341: an undecodable type record is omitted visibly, once per load, on the once and streaming prepasses', () => {
    const bytes = new TextEncoder().encode(readFileSync(
      join(ROOT_DIR, 'rust/processing/tests/fixtures/f2_omitted_type_record_8341.ifc'), 'utf8'));
    const diagApi = new IfcAPI();
    try {
      const pre = diagApi.buildPrePassOnce(bytes);
      const ids = Array.from(pre.jobs).filter((_, i) => i % 3 === 0);
      assert.ok(!ids.includes(500), 'the malformed type is not scheduled');
      assert.ok(ids.includes(100), 'the valid orphan neighbour is scheduled');
      const before = diagApi.getPipelineDiagnostics();
      assert.ok(before && typeof before === 'object', 'a prepass-only omission is reportable');
      assert.equal(before.schemaVersion, 1);
      assert.equal(before.batches, 0);
      assert.equal(before.omittedTypeRecords, 1, 'one record although it carries two maps');
      assert.equal(before.refusedInputElements, 0);
      assert.equal(before.refusedPrepassRecords, 0, 'a plain decode failure is not an admission refusal');
      const meshes = diagApi.processGeometryBatch(bytes, pre.jobs, pre.unitScale,
        ...pre.rtcOffset, pre.needsShift, pre.voidKeys, pre.voidCounts, pre.voidValues,
        pre.styleIds, pre.styleColors, pre.planeAngleToRadians);
      meshes.free();
      const after = diagApi.getPipelineDiagnostics();
      assert.equal(after.batches, 1);
      assert.equal(after.omittedTypeRecords, 1, 'batches never recount it');
      diagApi.clearPrePassCache();
      assert.equal(diagApi.getPipelineDiagnostics().omittedTypeRecords, 1, 'cleanup preserves it');
      diagApi.buildPrePassStreaming(bytes, () => {}, 1024, null, false);
      assert.equal(diagApi.getPipelineDiagnostics().omittedTypeRecords, 1, 'streaming: the next load reports it afresh');
      diagApi.buildPrePassStreaming(bytes, () => {}, 1024, null, true);
      assert.equal(diagApi.getPipelineDiagnostics(), undefined, 'skipped type geometry plans, and so omits, nothing');
    } finally { diagApi.clearPrePassCache(); diagApi.free(); }
  });

  test('C4-10a #8316: prepass-only refusal diagnostics are visible before any batch', () => {
    const diagApi = new IfcAPI();
    const source = readFileSync(join(ROOT_DIR, 'rust/processing/tests/fixtures/c4_0_refusal_parity_7782.ifc'), 'utf8')
      .replace('#8=IFCUNITASSIGNMENT((#7));', `#8=IFCUNITASSIGNMENT((#800));
  #800=IFCCONVERSIONBASEDUNIT(#803,.LENGTHUNIT.,'CUSTOM',#801);
  #801=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.E400),#7);
  #803=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);`);
    try {
      diagApi.buildPrePassOnce(new TextEncoder().encode(source));
      const diag = diagApi.getPipelineDiagnostics();
      assert.ok(diag && typeof diag === 'object', 'prepass API must expose its own refusals');
      assert.equal(diag.schemaVersion, 1);
      assert.equal(diag.batches, 0);
      assert.equal(diag.refusedInputElements, 0);
      assert.equal(diag.refusedPrepassRecords, 1, 'only the refused unit record #801');
    } finally { diagApi.clearPrePassCache(); diagApi.free(); }
  });

  // F2 #8341 viewer relay: the BUILT helpers the prepass worker and the
  // main-thread paths run (the package exports map does not expose them).
  const relayPath = join(ROOT_DIR, 'packages/geometry/dist/omitted-type-records.js');
  const relay = existsSync(relayPath) ? await import(pathToFileURL(relayPath).href) : null;
  if (!relay) {
    console.log('  ⚠️  packages/geometry/dist missing — run `pnpm build`. F2 relay case skipped.');
    return;
  }
  test('F2 #8341 relay: the prepass instance count rides the real complete event and is read before a reset', () => {
    const bytes = new TextEncoder().encode(readFileSync(
      join(ROOT_DIR, 'rust/processing/tests/fixtures/f2_omitted_type_record_8341.ifc'), 'utf8'));
    const relayApi = new IfcAPI();
    try {
      const events = [];
      relayApi.buildPrePassStreaming(bytes, (event) => {
        relay.annotatePrepassComplete(relayApi, event);
        events.push(event);
      }, 1024, null, false);
      const complete = events.find((event) => event.type === 'complete');
      assert.equal(complete?.omittedTypeRecords, 1, 'read inside the real callback, from the instance that ran it');
      assert.ok(events.every((event) => event === complete || !('omittedTypeRecords' in event)));
      relayApi.buildPrePassOnce(bytes);
      assert.equal(relay.readOmittedTypeRecords(relayApi), 1, 'one-shot path');
      relayApi.setSourceBytes(bytes);
      assert.equal(relay.readOmittedTypeRecords(relayApi), undefined, 'an install resets it: unknown, not 0');
      const skipped = [];
      relayApi.buildPrePassStreaming(bytes, (event) => {
        relay.annotatePrepassComplete(relayApi, event);
        skipped.push(event);
      }, 1024, null, true);
      assert.ok(!('omittedTypeRecords' in skipped.find((event) => event.type === 'complete')),
        'no type plan, no report: the key stays absent');
    } finally { relayApi.clearPrePassCache(); relayApi.free(); }
  });
}
