/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';

// #7782 C4-11a: executable traces, recorded before changing reset semantics.
// These are call-order fixtures, not mocks of the API or source-text assertions.
export const INSTALL_ORDERS = [
  // geometry.worker.ts ensureInit (500), processBatch (1154), re-init (1256).
  ['worker init/reinit', ['index', 'columns', 'source', 'finishes', 'batchSource']],
  // A shard scan can prepare the source before set-entity-index arrives.
  ['worker prepared source', ['source', 'index', 'columns', 'finishes', 'batchSource']],
  // index.ts parseBytesSync/streaming; style-finishes.ts buildPrePassWithFinishes.
  ['one-shot', ['once', 'finishes', 'batch']],
  // cli/commands/diff-geometry.ts 195: bytes precede prepass, cleanup in finally.
  ['CLI diff', ['source', 'once', 'finishes', 'batchSource']],
  // remesh/remesh-core.ts remeshOnApi; create/export/viewer test-side oracles.
  ['remesh/create/oracle', ['once', 'batch']],
  // geometry.worker.ts prepass-streaming[-sharded], including SAB retry.
  ['streaming', ['stream', 'finishes', 'batch']],
  ['sharded prepass', ['sharded', 'finishes', 'batch']],
  // finalize-styles (1462): index already installed; stash before EACH attempt.
  ['sharded finalize/retry', ['source', 'index', 'stash', 'finalizeSource', 'stash', 'finalize']],
  // Legacy batch-only clients install finishes before the lazy index is built.
  ['lazy batch', ['finishes', 'batch']],
];

export function installFixture(width = 1, styled = true) {
  return new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Content lifetime witness'),'2;1');
FILE_NAME('lifetime.ifc','2026-10-29T00:00:00',('Test'),('Test'),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);
#5=IFCLOCALPLACEMENT($,#4);
#6=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,0.00001,#4,$);
#7=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#8=IFCUNITASSIGNMENT((#7));
#9=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,(#6),#8);
#12=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(${width}.,0.,0.),(0.,1.,0.)));
#13=IFCTRIANGULATEDFACESET(#12,$,.F.,((1,2,3)),$);
#14=IFCSHAPEREPRESENTATION(#6,'Body','Tessellation',(#13));
#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));
#100=IFCWALL('0000000000000000000100',$,'Wall',$,$,#5,#15,$,.NOTDEFINED.);
${styled ? `#20=IFCCOLOURRGB($,${width === 1 ? "0.8,0.1,0.2" : "0.1,0.2,0.8"});
#21=IFCSURFACESTYLERENDERING(#20,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.9),$,.METAL.);
#22=IFCSURFACESTYLE('Steel',.BOTH.,(#21));
#23=IFCSTYLEDITEM(#13,(#22),$);` : ''}
ENDSEC;
END-ISO-10303-21;`);
}

function installColumns(api) {
  api.setReferencedRepmaps(new Uint32Array());
  api.setInstantiatedTypeIds(new Uint32Array());
  api.setMappedInstancePlan(new Uint32Array());
  api.setMaterialLayerIndex(new Uint32Array(), new Uint32Array(), new Uint32Array(),
    new Float64Array(), new Float64Array(), new Uint32Array(), new Float64Array());
}

export function executeInstallOrder(api, steps, bytes) {
  const index = api.scanEntityIndexShard(bytes, 0, bytes.length);
  // A fresh prepass supplies the wire a different worker/host would forward.
  const host = new api.constructor();
  let pre;
  try { pre = host.buildPrePassOnce(bytes); } finally { host.free(); }
  const empty = new Uint32Array();
  const finalizeArgs = [empty, new Float32Array(), pre.styleIds,
    Float32Array.from(pre.styleColors, v => v / 255), empty, empty, empty, empty, empty, empty, 1];
  let meshes;
  for (const step of steps) {
    switch (step) {
      case 'source': api.setSourceBytes(bytes); break;
      case 'index': api.setEntityIndex(index.ids, index.starts, index.lengths); break;
      case 'columns': installColumns(api); break;
      case 'once': pre = api.buildPrePassOnce(bytes); break;
      case 'stream': api.buildPrePassStreaming(bytes, () => {}, 1024, null, false); break;
      case 'sharded': api.buildPrePassStreamingSharded(bytes, () => {}, 1024, null, false,
        index.ids, index.starts, index.lengths, index.classes); break;
      case 'finishes': api.setStyleFinishes(pre.styleIds, pre.styleFinishes); break;
      case 'stash': api.setPrepassGeometryFinishes(pre.styleIds, pre.styleFinishes); break;
      case 'finalizeSource':
      case 'finalize': {
        const payload = step === 'finalizeSource' ? api.finalizePrepassStylesFromSource(...finalizeArgs)
          : api.finalizePrepassStyles(bytes, ...finalizeArgs);
        assert.deepEqual(payload.styleFinishes, pre.styleFinishes, 'stash consumed by each finalize attempt');
        break;
      }
      case 'batch':
      case 'batchSource': {
        const args = [pre.jobs, pre.unitScale, ...pre.rtcOffset, pre.needsShift,
          pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors];
        const collection = step === 'batchSource' ? api.processGeometryBatchFromSource(...args)
          : api.processGeometryBatch(bytes, ...args);
        try {
          meshes = Array.from({ length: collection.length }, (_, i) => {
            const mesh = collection.get(i);
            try { return { positions: mesh.positions, color: mesh.color, metallic: mesh.metallic, roughness: mesh.roughness }; }
            finally { mesh.free(); }
          });
        } finally { collection.free(); }
        assert.equal(meshes.length, 1, 'non-vacuous production');
        break;
      }
      default: throw new Error(`unknown trace step ${step}`);
    }
  }
  return meshes;
}

export function runContentInstallContracts(IfcAPI, test) {
  for (const [name, steps] of INSTALL_ORDERS) {
    test(`C4-11a install trace: ${name} (#7782)`, () => {
      const api = new IfcAPI();
      try {
        executeInstallOrder(api, steps, installFixture());
        const diagnostics = api.getPipelineDiagnostics();
        api.clearPrePassCache();
        assert.deepEqual(api.getPipelineDiagnostics(), diagnostics, 'cleanup preserves diagnostics');
        assert.equal(api.scanEntityIndexShardFromSource(0, 10000).ids.length, 0, 'cleanup releases source');
      } finally { api.free(); }
    });
  }
}

export function runContentReplacementContracts(IfcAPI, test) {
  for (const boundary of [['once'], ['stream'], ['sharded'], ['source', 'index', 'columns']]) {
    test(`C4-11a same API replaces colliding styles and finishes: ${boundary} (#7782)`, () => {
      const api = new IfcAPI(), fresh = new IfcAPI();
      try {
        const first = executeInstallOrder(api, ['once', 'finishes', 'batch'], installFixture());
        assert.equal(first[0].metallic, 1, 'seed must actually carry an authored finish');
        // Different shape/colour, same entity ids AND style-wire signature.
        const second = installFixture(2);
        const steps = [...boundary, boundary[0] === 'source' ? 'batchSource' : 'batch'];
        const actual = executeInstallOrder(api, steps, second);
        const expected = executeInstallOrder(fresh, steps, second);
        assert.deepEqual(actual, expected, 'a reused API must behave exactly like a fresh API');
        assert.equal(actual[0].metallic, undefined, 'new content did not install a finish');
        assert.notDeepEqual(actual[0].color, first[0].color, 'style cache must rebuild despite signature collision');
      } finally { api.clearPrePassCache(); fresh.clearPrePassCache(); api.free(); fresh.free(); }
    });
  }
  test('C4-11a streaming failure and SAB/materialized retry (#7782)', () => {
    const api = new IfcAPI();
    const bytes = installFixture(2);
    const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
    shared.set(bytes);
    try {
      executeInstallOrder(api, ['once', 'finishes', 'batch'], installFixture());
      assert.throws(() => api.buildPrePassStreaming(shared, () => { throw new Error('callback abort'); }, 1024, null, false), /callback abort/);
      // The real ABI accepted the SAB on this runtime; the callback abort
      // exercises an already-entered attempt before the owned-buffer retry.
      const retried = executeInstallOrder(api, ['stream', 'batch'], shared.slice());
      assert.equal(retried[0].metallic, undefined);
      assert.ok(api.getPipelineDiagnostics().batches > 0);
    } finally { api.clearPrePassCache(); api.free(); }
  });
}
