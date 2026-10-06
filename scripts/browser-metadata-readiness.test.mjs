/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';
const { waitForMetadataRenderReadiness } = await tsImport('../tests/benchmark/metadata-render-readiness.ts', import.meta.url);

/**
 * #6979: readiness comes from the load-trace spans. Each event lands at `at`
 * ms as a finished span (the probe the page returns), and, for the legacy
 * scenarios only, as the console line older viewer builds printed instead.
 */
function scenario({ metadataAt = 265, rendererAt = 200, canvasAt = 200, failedAt = Infinity, finalizeError = false, legacy = false } = {}) {
  let now = 0;
  const done = new Set();
  const logs = [];
  const events = [
    [194, 'geometry.streamComplete', '[useIfc] Stream complete for fixture.ifc: 194ms'],
    [200, null, '[ifc-lite] fixture.ifc (2.4MB) → 10 meshes, 20k verts in 0.2s'],
    [rendererAt, 'scene.finalize', '[GeomStream] finalizeStreamingAsync complete: 10ms → 2 consolidated batches'],
    [metadataAt, 'parser.complete', '[useIfc] Data model parsing complete for fixture.ifc: 265ms'],
    [failedAt, 'parser.failed', '[useIfc] Data model parsing failed for fixture.ifc: 250ms'],
  ];
  return {
    trace: async () => legacy ? null : {
      ended: now >= 200,
      done: [...done],
      failed: finalizeError && done.has('scene.finalize') ? ['scene.finalize'] : [],
    },
    logs: () => logs,
    now: () => now,
    canvasReady: async () => now >= canvasAt,
    pause: async () => {
      now += 5;
      for (const [at, span, line] of events) {
        if (at > now) continue;
        if (span) done.add(span);
        if (legacy && !logs.includes(line)) logs.push(line);
      }
    },
    timeoutMs: 1000,
  };
}

test('#3978 early 200ms renderer finalize cannot complete before 265ms metadata', async () => {
  assert.equal(await waitForMetadataRenderReadiness(scenario()), 265);
});
test('#3978 delayed metadata moves observed readiness without changing renderer finalize', async () => {
  assert.equal(await waitForMetadataRenderReadiness(scenario({ metadataAt: 765 })), 765);
});
test('#3978 metadata alone cannot precede renderer finalization and allocated canvas', async () => {
  assert.equal(await waitForMetadataRenderReadiness(scenario({ rendererAt: 350, canvasAt: 450 })), 450);
});
test('#3978 absent metadata fails finitely instead of archiving a successful partial load', async () => {
  await assert.rejects(waitForMetadataRenderReadiness(scenario({ metadataAt: Infinity })), /Timed out/);
});
test('#3978 metadata failure is retained as failure even after geometry and canvas', async () => {
  await assert.rejects(waitForMetadataRenderReadiness(scenario({ failedAt: 250 })), /Metadata failed/);
});
test('#3978 an ended load root and allocated canvas cannot substitute for renderer finalization', async () => {
  await assert.rejects(waitForMetadataRenderReadiness(scenario({ rendererAt: Infinity })), /Timed out/);
});
test('#3978 renderer initialization failure rejects an otherwise ready model', async () => {
  const input = scenario();
  input.logs = () => ['[Viewport] Renderer init failed: Failed to get GPU adapter'];
  await assert.rejects(waitForMetadataRenderReadiness(input), /Renderer failed/);
});

test('#6979 readiness reads the spans: console completion lines alone do not complete a traced load', async () => {
  const input = scenario({ metadataAt: Infinity });
  // The console claims the whole load finished; the span tree, which the page exposes, has no metadata.
  input.logs = () => [
    '[useIfc] Stream complete for fixture.ifc: 194ms',
    '[GeomStream] finalizeStreamingAsync complete: 10ms → 2 consolidated batches',
    '[useIfc] Data model parsing complete for fixture.ifc: 265ms',
  ];
  await assert.rejects(waitForMetadataRenderReadiness(input), /Timed out/);
});
test('#6979 a scene.finalize span that ended in error fails readiness', async () => {
  await assert.rejects(waitForMetadataRenderReadiness(scenario({ finalizeError: true })), /Renderer failed/);
});

// TODO(remove-by: first release after 2026-10-06, #7005): builds without a load trace.
test('#6979 legacy fallback: a page without a load trace still completes from console lines', async () => {
  assert.equal(await waitForMetadataRenderReadiness(scenario({ legacy: true })), 265);
});
test('#6979 legacy fallback: console metadata failure still fails a page without a load trace', async () => {
  await assert.rejects(waitForMetadataRenderReadiness(scenario({ legacy: true, failedAt: 250 })), /Metadata failed/);
});
