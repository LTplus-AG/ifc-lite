/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from 'vitest';
import { craft, translation, type Craft } from '../../test-support/craft.js';

/**
 * rhino3dm 8.35.0 exports no heap getter, so this file catches the wasm memory
 * as the module is instantiated. It must run before anything loads the
 * runtime, which is why the leak check has a file of its own.
 */
let memory: WebAssembly.Memory | undefined;
// Typed by hand: `Parameters` of the overloaded original sees only its last signature.
const instantiate = WebAssembly.instantiate as (...args: unknown[]) => Promise<WebAssembly.Instance | WebAssembly.WebAssemblyInstantiatedSource>;
WebAssembly.instantiate = (async (...args: unknown[]) => {
  const result = await instantiate(...args);
  const instance = result instanceof WebAssembly.Instance ? result : result.instance;
  for (const value of Object.values(instance.exports)) if (value instanceof WebAssembly.Memory) memory = value;
  return result;
}) as typeof WebAssembly.instantiate;

/** Every kind of wrapper the reader takes: meshes, Breps, extrusions, curves, clouds, dots, nested blocks, layers. */
function everything(c: Craft) {
  const layer = c.layer('Layer', { userStrings: [['key', 'value']] });
  c.material('Material', [1, 2, 3, 255], 0.5);
  const leaf = c.block('Leaf', [c.box([0, 0, 0], [1, 1, 1]), new c.rhino.PolylineCurve([[0, 0, 0], [1, 0, 0]])]);
  const tree = c.block('Tree', [c.reference(leaf), c.reference(leaf, translation(2, 0, 0))]);
  for (let i = 0; i < 200; i++) {
    c.addMesh(c.box([i, 0, 0], [i + 1, 1, 1]), { layer, userStrings: [['IFC::Class', 'IfcWall']] });
    c.addBrep(6); c.addExtrusion(true); c.addInstance(tree, translation(i, 5, 0));
    c.addPolyline([[0, 0, 0], [1, 1, 1]]); c.addPointCloud([[0, 0, 0], [1, 1, 1]]); c.addTextDot('dot', [i, 0, 0]);
    c.addCurve(c.rhino.NurbsCurve.create(false, 3, [[0, 0, 0], [1, 2, 0], [2, 0, 0], [3, 2, 0]]));
  }
}

test('repeated imports stop growing the wasm heap after warmup', async () => {
  const { readRhino3dm } = await import('../index.js');
  const bytes = await craft(everything);
  expect(memory).toBeInstanceOf(WebAssembly.Memory);
  // Rhino and the reader have lazy one-time allocations. Establish a stable working
  // size before measuring subsequent imports; the first parse is not a reliable baseline.
  const first = await readRhino3dm(bytes);
  expect(first.entities).toHaveLength(1600);
  let settledReads = 0;
  let settled = memory!.buffer.byteLength;
  for (let i = 0; i < 8 && settledReads < 2; i++) {
    await readRhino3dm(bytes, { bakeInstances: i % 2 === 1 });
    const current = memory!.buffer.byteLength;
    settledReads = current === settled ? settledReads + 1 : 0;
    settled = current;
  }
  expect(settledReads).toBe(2);

  // Keep measuring after warmup: a leak can still consume the heap even if startup
  // allocations needed several reads to settle.
  for (let i = 0; i < 8; i++) {
    await readRhino3dm(bytes, { bakeInstances: i % 2 === 1 });
    expect(memory!.buffer.byteLength).toBe(settled);
  }
  // A failed import releases the file too.
  for (let i = 0; i < 3; i++) await expect(readRhino3dm(bytes, { onProgress: done => { if (done === 800) throw new Error('stop'); } })).rejects.toThrow('stop');
  expect(memory!.buffer.byteLength).toBe(settled);
});
