// SPDX-License-Identifier: MPL-2.0
// Actual canonical package + actual module Worker + staged /smlib SDK bundle.
// Run by scripts/retained-browser-contract.mjs in Chromium; nothing is mocked.
export async function runRetainedBrowserContract(wasm, fixture) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const rejects = async (run, pattern, message) => {
    let error;
    try { await run(); } catch (caught) { error = caught; }
    assert(error !== undefined && pattern.test(String(error)), `${message}: ${error}`);
  };
  // Millimetre units, a 2 x 4 x 3 m extrusion and a survey-scale placement.
  const text = fixture
    .replace('#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);', '#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);')
    .replace('#8=IFCRECTANGLEPROFILEDEF(.AREA.,$,#7,1.0,1.0);', '#8=IFCRECTANGLEPROFILEDEF(.AREA.,$,#7,2000.,4000.);')
    .replace('#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,1.0);', '#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,3000.);')
    .replace('#28=IFCCARTESIANPOINT((0.0,0.0,0.));', '#28=IFCCARTESIANPOINT((5000000000.,0.,0.));')
    .replace('#6=IFCCARTESIANPOINT((0.,0.));', '#6=IFCCARTESIANPOINT((250.,-500.));')
    .replace('#10=IFCCARTESIANPOINT((0.,0.,0.));', '#10=IFCCARTESIANPOINT((1000.,2000.,3000.));');
  assert(text.includes('5000000000.') && text.includes('3000.);'), 'known millimetre/survey source fixture');
  const bytes = new TextEncoder().encode(text);
  const api = new wasm.IfcAPI();
  const owned = [];
  const keep = (value) => { owned.push(value); return value; };
  try {
    const sources = keep(api.retainedSources(bytes));
    const listed = sources.sources();
    const entry = listed.find((source) => source.solid_id === 12);
    assert(entry && entry.family === 'rectangle' && entry.product_ids.includes(31), 'solid 12 admitted as a rectangle');
    const executor = keep(new wasm.RetainedBrowserExecutor());
    // Cancellation stays callable while execute holds the executor; it also
    // covers cancellation before the module Worker finished starting.
    const cancellation = keep(executor.cancellation());
    const pending = sources.execute(entry.index, executor, 0.001, 5, 16 << 20);
    cancellation.retire();
    await rejects(() => pending, /retired|cancelled|unavailable|WrongWorker|foreign/i, 'cancelled execution rejects');
    await rejects(() => executor.capabilities(), /retired|foreign/i, 'a retired executor selects nothing');

    const fresh = keep(new wasm.RetainedBrowserExecutor());
    cancellation.retire(); // a stale cancellation cannot reach the replacement
    const capabilities = await fresh.capabilities();
    assert(capabilities.live && capabilities.rectangle, 'actual Worker reports the region format');
    assert(!capabilities.ordered_region && !capabilities.rational_disk, 'bits alone never qualify curved families');
    const display = await sources.execute(entry.index, fresh, 0.001, 5, 16 << 20);
    assert(display.contract === 'unstyled_flat_source_only', 'explicit source-only display contract');
    const p = display.positions, indices = display.indices;
    assert(indices.length > 0 && indices.length % 3 === 0, 'actual Worker triangles');
    let six = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => Array.from(p.slice(indices[i + k] * 3, indices[i + k] * 3 + 3)));
      six += a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
    assert(Math.abs(Math.abs(six / 6) - 24) < 1e-4, `millimetres converted once: volume ${six / 6}`);
    // Survey placement stays in the f64 occurrence, never in f32 vertices.
    const [, m] = display.occurrences.find(([id]) => id === 31) ?? [];
    assert(m, 'product 31 placed');
    const world = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) for (let r = 0; r < 3; r++) {
      const v = m[r * 4] * p[i] + m[r * 4 + 1] * p[i + 1] + m[r * 4 + 2] * p[i + 2] + m[r * 4 + 3];
      world[r] = Math.min(world[r], v); world[r + 3] = Math.max(world[r + 3], v);
    }
    const expected = [5e6 - 0.75 + 1, -2.5 + 2, 3, 5e6 + 1.25 + 1, 1.5 + 2, 6];
    assert(world.every((v, i) => Math.abs(v - expected[i]) < 1e-4), `world bounds ${world} vs ${expected}`);
    const after = await fresh.capabilities();
    assert(after.live, 'publishing released the object and kept the Worker');
    fresh.retire();
    await rejects(() => sources.execute(entry.index, fresh, 0.001, 5, 16 << 20), /retired|foreign/i, 'retired Worker runs nothing');
    return { passed: true, volume: Math.abs(six / 6), triangles: indices.length / 3, world, capabilities,
      sourceOnly: true, fullProductQualification: false };
  } finally {
    for (const value of owned.reverse()) { try { value.free(); } catch { /* already consumed */ } }
    api.free();
  }
}
