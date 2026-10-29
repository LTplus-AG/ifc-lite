// SPDX-License-Identifier: MPL-2.0
// #7955 M2-A: real controller + actual qualified SMLib Worker, never a kernel fake.
import { instancingContract } from './m11-instancing-contract.mjs';
export async function runSessionContract(wasm, fixture, manifest, RetainedDriver) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const sameIds = (actual, expected) => [...actual].sort((a, b) => a - b).join(',') === [...expected].sort((a, b) => a - b).join(',');
  const rows = manifest.split('\n').map(line => line.split('\t'))
    .filter(row => row[0] === 'rust/geometry/tests/fixtures/mapped_instances_synthetic.ifc');
  assert(rows.length > 0 && rows.every(row => row[2] === 'published'), 'mapped manifest is fully published');
  const ids = rows.map(row => Number(row[1]));
  const bytes = new TextEncoder().encode(fixture);
  const api = new wasm.IfcAPI();
  const session = new wasm.RetainedModelSession();
  const prepass = api.buildPrePassOnce(bytes);
  const summaries = [];
  const instances = instancingContract();
  let qualifications = 0;
  const qualify = RetainedDriver.prototype.qualify;
  // Pass through to the real SDK witnesses; observe calls without substituting results.
  RetainedDriver.prototype.qualify = function (...args) {
    qualifications++;
    return qualify.apply(this, args);
  };
  try {
    for (const detail of ['view', 'shape']) {
      let start;
      const published = [];
      const summary = await session.run(bytes, { detail }, event => {
        if (event.kind === 'start') {
          assert(!start && published.length === 0, 'start precedes every outcome exactly once');
          start = event;
          assert(sameIds(event.candidateIds, ids), 'candidateIds equals manifest ids');
          assert(event.frame.needsShift === prepass.needsShift, 'needsShift equals buildPrePassOnce');
          assert(event.frame.rtcOffset.length === 3 && [...event.frame.rtcOffset].every((v, i) => Object.is(v, prepass.rtcOffset[i])), 'frame equals buildPrePassOnce bit for bit');
          return;
        }
        try {
          assert(start && event.kind === 'published', `every mapped product publishes: ${JSON.stringify(event)}`);
          assert(event.expressId === start.candidateIds[published.length], 'sink follows canonical job order');
          assert(event.marker === 'PresentationObligationsUnmet' && event.obligationsUnmet.length > 0, 'shape-only marker retained');
          assert(!event.obligationsUnmet.includes('SurfaceNormals'), 'M11-N discharges surface normals');
          instances.collect(event);
          published.push(event.expressId);
          if (detail === 'view') {
            assert(event.cuts === 0 && event.consumedParts === 0, 'view event carries the M3 cut diagnostics (no openings here)');
            const collection = event.meshes;
            assert(collection.length > 0, 'view publishes a real mesh collection');
            assert(Array.isArray(event.faces) && event.faces.length > 0 && event.faces.every(f => f.table.length > 0 && f.triangles instanceof Uint32Array), 'M11-F view event carries each part face table');
            assert([collection.rtcOffsetX, collection.rtcOffsetY, collection.rtcOffsetZ].every((v, i) => Object.is(v, start.frame.rtcOffset[i])), 'collection uses start frame');
            for (let i = 0; i < collection.length; i++) {
              const mesh = collection.get(i);
              try {
                assert(mesh.expressId === event.expressId && mesh.triangleCount > 0, 'mesh belongs to atomic product');
                assert(mesh.vertexCount === mesh.triangleCount * 3, 'flat triangles are unwelded');
              } finally { mesh.free(); }
            }
          } else {
            assert(event.parts.length > 0 && event.parts.every(part => part.positions instanceof Float64Array), 'shape detail preserves M1 f64 parts');
            assert(event.parts.every(part => part.revisionLocalFaces.length === part.indices.length / 3 && part.normals instanceof Float64Array && part.normals.length === part.indices.length * 3 && part.color === undefined && part.faces?.triangles.length === part.indices.length / 3 && part.instanceKey === event.instanceKey), 'M11-F keys every triangle; M11-N supplies every corner normal; M11-I preserves the instance key');
          }
        } finally { event.meshes?.free(); }
      });
      assert(start && sameIds(published, ids), 'every candidate published once');
      assert(summary.candidates === ids.length && summary.published === ids.length && summary.refused === 0, 'summary agrees with outcomes');
      assert(summary.workersAcquired === (detail === 'view' ? 1 : 0) && summary.restarts === 0, 'warm run reuses the qualified worker');
      assert(qualifications === 1, 'only the cold run qualifies; warm reuse never requalifies');
      summaries.push({ ...summary, qualifications: detail === 'view' ? qualifications : 0 });
    }
    const events = [];
    const empty = await session.run(bytes, { detail: 'shape', ids: new Uint32Array() }, event => events.push(event));
    assert(empty.candidates === 0 && events.length === 1 && events[0].candidateIds.length === 0, 'empty ids selects nothing');
    return { passed: true, summaries, instancing: await instances.finish(wasm, prepass.rtcOffset) };
  } finally {
    RetainedDriver.prototype.qualify = qualify;
    api.clearPrePassCache();
    session.free();
    api.free();
  }
}
