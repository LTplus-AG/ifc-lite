// SPDX-License-Identifier: MPL-2.0
// Observe real transferred frames and real replies; no kernel response is mocked.
export async function openingCutsContract() {
  const { RetainedDriver } = await import('/driver/retained-driver.mjs');
  const { rectangleRecipe } = await import('/smlib/sweep-contract.mjs');
  const { SmlibWorkerTransport } = await import('/smlib/client.mjs');
  const original = SmlibWorkerTransport.prototype.batch;
  const calls = [];
  SmlibWorkerTransport.prototype.batch = function (frames, incarnation) {
    calls.push(...frames.map(frame => new DataView(frame).getUint32(8, true)));
    return original.call(this, frames, incarnation);
  };
  const driver = new RetainedDriver();
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  try {
    const recipe = rectangleRecipe();
    const source = await driver.evaluate(recipe.bytes, 1, recipe.loops, recipe.segments, 0, 0.001, 5, 1 << 20);
    const identity = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const first = await driver.boolean(source.object, source.object, identity, 1, 0.001, 5, 1 << 20);
    const chain = await driver.boolean(first.object, source.object, identity, 1, 0.001, 5, 1 << 20);
    assert(!chain.empty && chain.mesh.indices.length > 0, 'chained Boolean left input must retain a real mesh');
    calls.length = 0;
    const consumed = await driver.boolean(chain.object, source.object, identity, 3, 0.001, 5, 1 << 20);
    assert(consumed.empty === true && consumed.mesh === null, 'Difference must carry certified emptiness');
    assert(calls.includes(19), 'real semantic-empty certificate requested');
    assert(!calls.some(op => [9, 10, 11].includes(op)), 'certified empty result must never tessellate or read a mesh');
    return { chained: true, certifiedEmpty: true, emptyOpcodes: [...calls] };
  } finally {
    driver.retire();
    SmlibWorkerTransport.prototype.batch = original;
  }
}
