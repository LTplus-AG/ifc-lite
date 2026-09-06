/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';
const { waitForMetadataRenderReadiness } = await tsImport('../tests/benchmark/metadata-render-readiness.ts', import.meta.url);

function scenario({ metadataAt = 265, rendererAt = 200, canvasAt = 200, failedAt = Infinity } = {}) {
  let now = 0;
  const logs = [];
  const emitted = new Set();
  const events = [
    [194, '[useIfc] Stream complete for fixture.ifc: 194ms'],
    [rendererAt, '[ifc-lite] fixture.ifc (2.4MB) → 10 meshes, 20k verts in 0.2s'],
    [metadataAt, '[useIfc] Data model parsing complete for fixture.ifc: 265ms'],
    [failedAt, '[useIfc] Data model parsing failed for fixture.ifc: 250ms'],
  ];
  return {
    logs: () => logs,
    now: () => now,
    canvasReady: async () => now >= canvasAt,
    pause: async () => {
      now += 5;
      for (const [at, text] of events) if (at <= now && !emitted.has(text)) {
        emitted.add(text); logs.push(text);
      }
    },
    timeoutMs: 1000,
  };
}

test('#3978 early 200ms renderer summary cannot complete before 265ms metadata', async () => {
  assert.equal(await waitForMetadataRenderReadiness(scenario()), 265);
});
test('#3978 delayed metadata moves observed readiness without changing renderer summary', async () => {
  assert.equal(await waitForMetadataRenderReadiness(scenario({ metadataAt: 765 })), 765);
});
test('#3978 metadata alone cannot precede renderer and actual canvas', async () => {
  assert.equal(await waitForMetadataRenderReadiness(scenario({ rendererAt: 350, canvasAt: 450 })), 450);
});
test('#3978 absent metadata fails finitely instead of archiving a successful partial load', async () => {
  await assert.rejects(waitForMetadataRenderReadiness(scenario({ metadataAt: Infinity })), /Timed out/);
});
test('#3978 metadata failure is retained as failure even after geometry and canvas', async () => {
  await assert.rejects(waitForMetadataRenderReadiness(scenario({ failedAt: 250 })), /Metadata failed/);
});
