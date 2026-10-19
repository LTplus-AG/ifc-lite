// SPDX-License-Identifier: MPL-2.0
// Actual browser/WASM/source witness. Call with the freshly generated wasm
// module and committed mapped_instances_synthetic.ifc text; no mocked transport.
export async function runRetainedBrowserContract(wasm, fixture) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const rejects = async (run, message) => {
    let rejected = false;
    try { await run(); } catch (error) { rejected = true; assert(error !== undefined, "explicit refusal"); }
    assert(rejected, message);
  };
  const text = fixture
    .replace('#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);', '#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);')
    .replace('#8=IFCRECTANGLEPROFILEDEF(.AREA.,$,#7,1.0,1.0);', '#8=IFCRECTANGLEPROFILEDEF(.AREA.,$,#7,2000.,4000.);')
    .replace('#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,1.0);', '#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,3000.);')
    .replace('#28=IFCCARTESIANPOINT((0.0,0.0,0.));', '#28=IFCCARTESIANPOINT((5000000000.,0.,0.));')
    .replace('#6=IFCCARTESIANPOINT((0.,0.));', '#6=IFCCARTESIANPOINT((250.,-500.));')
    .replace('#10=IFCCARTESIANPOINT((0.,0.,0.));', '#10=IFCCARTESIANPOINT((1000.,2000.,3000.));');
  assert(text !== fixture && text.includes('5000000000.'), 'known millimetre/survey source fixture');
  const api = new wasm.IfcAPI();
  let source, executor;
  try {
    await rejects(() => api.retainedSourceKeys(), 'unbound installed source must refuse');
    api.setSourceBytes(new TextEncoder().encode(text));
    api.bindSourceModel();
    const keys = api.retainedSourceKeys();
    const key = keys.find(candidate => candidate.solid_id === 12);
    assert(key, 'committed source solid12 was reached');
    await rejects(() => api.admitRetainedSource({ ...key, model_sha256: 'foreign' }), 'foreign model key must refuse');
    source = api.admitRetainedSource(key);
    executor = new wasm.RetainedBrowserExecutor();
    const cancellation = executor.cancellation();
    try {
      const pending = source.execute(executor, 0, 0.001, 5, 16 * 1024 * 1024);
      // This remains callable while wasm-bindgen holds execute's async mutable
      // executor borrow. It also covers cancellation before JS startup settles.
      cancellation.retire();
      await rejects(() => pending, 'captured cancellation rejects pending execution');
      await rejects(() => source.display(), 'cancelled source cannot publish a display');
      source.free(); source = api.admitRetainedSource(key);
      executor.free(); executor = new wasm.RetainedBrowserExecutor();
      cancellation.retire(); // An old cancellation cannot retire this replacement.
    } finally { cancellation.free(); }
    const display = await source.execute(executor, 0, 0.001, 5, 16 * 1024 * 1024);
    assert(display.contract === 'unstyled_flat_source_only', 'explicit source-only display contract');
    const p = display.positions, indices = display.indices;
    assert(indices.length > 0 && indices.length % 3 === 0, 'actual Worker triangles');
    let sixVolume = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const at = corner => Array.from(p.slice(indices[i + corner] * 3, indices[i + corner] * 3 + 3));
      const [a, b, c] = [at(0), at(1), at(2)];
      sixVolume += a[0] * (b[1]*c[2]-b[2]*c[1]) + a[1] * (b[2]*c[0]-b[0]*c[2]) + a[2] * (b[0]*c[1]-b[1]*c[0]);
    }
    assert(Math.abs(Math.abs(sixVolume / 6) - 24) < 1e-6, 'source millimetres converted once: independent volume24m3');
    // The source test's survey origin stays outside f32 vertex buffers. Find
    // the known mapped product31, rather than choosing an arbitrary occurrence.
    const occurrence = display.occurrences.find(([id]) => id === 31);
    assert(occurrence && Math.abs(occurrence[1][3] - 5000000.25) < 1e-8 &&
      Math.abs(occurrence[1][7] + 0.5) < 1e-10 && Math.abs(occurrence[1][11] - 3) < 1e-10,
      'common assembly preserves source/profile/solid/survey placement in f64');
    executor.retire();
    await rejects(() => source.display(), 'retired captured Worker invalidates object lease');
    source.free(); source = api.admitRetainedSource(key);
    executor.free(); executor = new wasm.RetainedBrowserExecutor();
    await source.execute(executor, 0, 0.001, 5, 16 * 1024 * 1024);
    api.clearPrePassCache();
    await rejects(() => source.display(), 'canonical source invalidation expires publication');
    return { passed: true, source: 'mapped_instances_synthetic.ifc, modified units/frames', volume: Math.abs(sixVolume / 6),
      triangles: indices.length / 3, sourceOnly: true, fullProductQualification: false };
  } finally { source?.free(); executor?.free(); api.free(); }
}
