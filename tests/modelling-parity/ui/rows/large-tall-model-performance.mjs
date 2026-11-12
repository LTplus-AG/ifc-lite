/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { task } from '../lib/driver.mjs';
import { escape } from '../lib/model-ui.mjs';
import { check, finish } from '../lib/authoring-helpers.mjs';

/** #9296 P2: conventional median and nearest-rank p95; never discard slow frames. */
export function frameStats(values) {
  if (!values.length || values.some(v => !Number.isFinite(v) || v <= 0)) {
    throw new Error('Expected nonempty, finite positive timing samples');
  }
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { count: n, medianMs: (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2,
    p95Ms: sorted[Math.ceil(n * .95) - 1], maxMs: sorted[n - 1] };
}

// Observe real store writes, never substitute a scripted edit for a keyboard gesture.
// A changed mutationVersion alone is too early: wait for this entity's replacement
// AND the renderer to drain it. The following rAF includes synchronous GPU upload.
async function armEdit(s, id) {
  await s.page.evaluate(id => {
    const api = globalThis.__ifc_lite_viewer_store__;
    const before = api.getState();
    const centre = meshes => {
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (const mesh of meshes) for (let i = 0; i < mesh.positions.length; i++) {
        const k = i % 3; min[k] = Math.min(min[k], mesh.positions[i] + (mesh.origin?.[k] ?? 0)); max[k] = Math.max(max[k], mesh.positions[i] + (mesh.origin?.[k] ?? 0));
      }
      return min.map((v, k) => (v + max[k]) / 2);
    };
    const baseline = before.models.values().next().value.geometryResult.meshes.filter(m => m.expressId === id);
    globalThis.__p2_edit__ = { timeOrigin: performance.timeOrigin, started: null, mutationMs: null, replacedMs: null, drainedMs: null, totalMs: null, beforeCentre: centre(baseline), afterCentre: null };
    const result = globalThis.__p2_edit__;
    let replaced = false, done = false;
    const unsub = api.subscribe(st => {
      if (result.started === null || done) return;
      const elapsed = performance.now() - result.started;
      if (st.mutationVersion !== before.mutationVersion && result.mutationMs === null) result.mutationMs = elapsed;
      const meshes = st.models.values().next().value.geometryResult.meshes.filter(m => m.expressId === id);
      if (meshes.length && meshes.some(m => !baseline.includes(m))) {
        replaced = true;
        result.replacedMs ??= elapsed;
        result.afterCentre = centre(meshes);
      }
      if (result.mutationMs !== null && replaced && !st.pendingMeshEdits && !st.pendingMeshRemovals) {
        done = true;
        result.drainedMs = elapsed;
        requestAnimationFrame(() => { result.totalMs = performance.now() - result.started; });
      }
    });
    const start = event => {
      if (event.key === 'Enter' && !event.repeat && result.started === null) result.started = performance.now();
    };
    window.addEventListener('keydown', start, true);
    globalThis.__p2_disarm__ = () => { unsub(); window.removeEventListener('keydown', start, true); };
  }, id);
}

async function commitAndObserve(s, id, key) {
  await armEdit(s, id);
  try {
    // No driver settle delay in the measurement. The page listener timestamps
    // the event, so CDP round trips cannot masquerade as product latency.
    await s.ui.key(key, { settle: 0 });
    await s.page.waitForFunction(() => globalThis.__p2_edit__?.totalMs !== null, null, { timeout: 30000 });
    return await s.page.evaluate(() => globalThis.__p2_edit__);
  } finally {
    await s.page.evaluate(() => globalThis.__p2_disarm__?.());
  }
}

async function move(s, id) {
  await s.ui.key('Shift+M', { settle: 300 });
  await s.page.locator('[data-command-id="element.move"]').waitFor({ timeout: 5000 });
  await s.ui.type('0.5');
  return commitAndObserve(s, id, 'Enter');
}

export default {
  id: 'ui.session-scale', capability: 'large-tall-model-performance',
  title: 'Loaded F5 tower: 120 orbit frames and five single-column edits',
  async run(s) {
    const tasks = [], checks = [], notes = [], metrics = { editSamples: [], undoSamples: [] }, artifacts = {};
    // The launcher supplies these only inside admitted worker commands. Keep
    // the request ID with the external host/queue/GPU samples for independent audit.
    const admitted = process.env.IFC_WORKER_KIND === 'benchmark' && !!process.env.IFC_WORKER_JOB_ID;
    metrics.admission = { kind: process.env.IFC_WORKER_KIND ?? null, jobId: process.env.IFC_WORKER_JOB_ID ?? null,
      diagnostic: !admitted };
    notes.push('Thresholds: orbit median <=33.3 ms, p95 <=50 ms; five-edit median <100 ms. Cold first edit is included.');
    if (!admitted) notes.push('DIAGNOSTIC ONLY: no exclusive benchmark admission; shared-host timings cannot qualify this row.');
    const loaded = await task(s, 'setup: load exported 40-storey F5 through welcome file input', async () => {
      const fixture = resolve(process.env.PARITY_OUT ?? 'tests/modelling-parity/.out/ui', 'fixtures/f5-40.ifc');
      const bytes = await readFile(fixture);
      metrics.fixture = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      // runProbe starts blank for all rows. A navigation discards that blank
      // session so this row exercises the welcome-screen canonical load path.
      await s.page.reload({ waitUntil: 'domcontentloaded' });
      await s.page.getByRole('button', { name: 'Start blank' }).waitFor({ timeout: 30000 });
      await s.page.locator('input[type=file][accept*=".ifc"]').first().setInputFiles({
        name: 'f5-40.ifc', mimeType: 'application/octet-stream', buffer: bytes,
      });
      s.counters.clicks++;
      await s.page.waitForFunction(() => {
        const st = globalThis.__ifc_lite_viewer_store__?.getState();
        const m = st && [...st.models.values()][0];
        return m?.ifcDataStore && m.loadState === 'complete' && !st.loading && !st.geometryStreamingActive;
      }, null, { timeout: 180000 });
      metrics.model = await s.state(() => {
        const st = globalThis.__ifc_lite_viewer_store__.getState(), m = [...st.models.values()][0];
        const counts = {};
        for (const id of m.ifcDataStore.entities.expressId.subarray(0, m.ifcDataStore.entities.count)) {
          const type = m.ifcDataStore.entities.getTypeName(id);
          counts[type] = (counts[type] ?? 0) + 1;
        }
        return { counts, meshes: m.geometryResult?.meshes.length, triangles: m.geometryResult?.totalTriangles };
      });
      // The F5 producer includes a separate Roof level above 40 occupied storeys.
      if (metrics.model.counts.IfcBuildingStorey !== 41 || metrics.model.counts.IfcColumn < 1600
        || !(metrics.model.meshes > 0) || !(metrics.model.triangles > 0)) {
        throw new Error(`Not the full F5 tower: ${JSON.stringify(metrics.model)}`);
      }
      await s.page.waitForFunction(() => typeof globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks?.getViewpoint === 'function');
      await s.harness.aim([90, -100, 130], [18, 18, 65], { pin: false });
      await s.settle(500);
    });
    loaded.setup = true; tasks.push(loaded);
    checks.push(check('full F5 loaded with geometry complete', loaded.ok, loaded.error ?? JSON.stringify(metrics.model)));
    if (loaded.ok) {
      tasks.push(await task(s, 'drag orbit across 120 measured animation frames', async () => {
        const canvas = s.page.locator('canvas').filter({ visible: true }).first();
        const box = await canvas.boundingBox();
        if (!box) throw new Error('No visible viewer canvas');
        metrics.orbitStartedAt = new Date().toISOString();
        const before = await s.state(() => globalThis.__ifc_lite_view_projection__());
        await s.page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
        await s.page.mouse.down();
        try {
          await s.page.evaluate(() => {
            globalThis.__p2_frames__ = [];
            let previous;
            const sample = now => {
              if (previous !== undefined) globalThis.__p2_frames__.push(now - previous);
              previous = now;
              if (globalThis.__p2_frames__.length < 120) requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          });
          let i = 0;
          const deadline = performance.now() + 30000;
          while (await s.state(() => globalThis.__p2_frames__.length < 120)) {
            // Sample continuously: retain long gaps too, including between CDP
            // pointer events. Never cherry-pick one fast delta per gesture.
            await s.page.mouse.move(box.x + box.width * .5 + 100 * Math.sin(i / 15), box.y + box.height * .5 + 30 * Math.cos(i / 15));
            i++;
            if (performance.now() > deadline) throw new Error('Orbit sampling exceeded 30 s budget');
          }
          metrics.frameDeltasMs = await s.state(() => globalThis.__p2_frames__);
          metrics.orbit = frameStats(metrics.frameDeltasMs);
          metrics.orbitEndedAt = new Date().toISOString();
          const after = await s.state(() => globalThis.__ifc_lite_view_projection__());
          metrics.orbit.cameraMoved = before.some((v, i) => Math.abs(v - after[i]) > 1e-4);
        } finally { await s.page.mouse.up(); s.counters.clicks++; }
      }));
      checks.push(check('interactive orbit on F5', metrics.orbit?.cameraMoved && metrics.orbit.count === 120
        && metrics.orbit.medianMs <= 33.3 && metrics.orbit.p95Ms <= 50, JSON.stringify(metrics.orbit) ?? 'Orbit incomplete'));

      tasks.push(await task(s, 'select a loaded column, Move 0.5 m five times, Undo each', async () => {
        if (await s.state(() => globalThis.__ifc_lite_viewer_store__.getState().workspaceMode !== 'model')) {
          await s.ui.click(s.page.locator('[data-workspace-chip]'));
        }
        await escape(s);
        const column = await s.state(() => {
          const st = globalThis.__ifc_lite_viewer_store__.getState(), m = [...st.models.values()][0];
          // The F5 producer's 40 original grid-bound columns cannot Move in
          // today's product; its 1,560 copied columns have ordinary local
          // placements. Pick a copied exterior column above the 6 m lobby.
          const columns = m.geometryResult.meshes.filter(mesh => m.ifcDataStore.entities.getTypeName(mesh.expressId) === 'IfcColumn');
          const bounds = mesh => {
            const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
            for (let i = 0; i < mesh.positions.length; i++) { const k = i % 3; min[k] = Math.min(min[k], mesh.positions[i] + (mesh.origin?.[k] ?? 0)); max[k] = Math.max(max[k], mesh.positions[i] + (mesh.origin?.[k] ?? 0)); }
            return { id: mesh.expressId, centre: min.map((v, k) => (v + max[k]) / 2) };
          };
          return columns.map(bounds).filter(c => c.centre[1] > 6).sort((a, b) => a.centre[1] - b.centre[1] || b.centre[2] - a.centre[2] || a.centre[0] - b.centre[0])[0];
        });
        if (!column) throw new Error('No individually rendered loaded column');
        metrics.column = column;
        notes.push('Edit target is a copied column above the lobby; original grid-parent columns refuse Move. The complete tower remains loaded.');
        const p = [column.centre[0], -column.centre[2], column.centre[1]];
        await s.harness.aim([p[0] + 4, p[1] + 6, p[2] + 1], p);
        await s.ui.clickWorld(p);
        const selected = await s.state(() => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId);
        if (selected !== column.id) throw new Error(`Clicked ${selected}, expected column ${column.id}`);
        for (let i = 0; i < 5; i++) {
          await s.ui.clickWorld(p);
          const startedAt = new Date().toISOString();
          const edit = { ...await move(s, column.id), startedAt, endedAt: new Date().toISOString() };
          metrics.editSamples.push(edit);
          if (Math.abs(Math.hypot(...edit.afterCentre.map((v, k) => v - edit.beforeCentre[k])) - .5) > .005) {
            throw new Error('Column mesh did not move 0.5 m');
          }
          // Undo timing uses the same observation but starts at Ctrl+Z, not Enter.
          await armEdit(s, column.id);
          await s.page.evaluate(() => { globalThis.__p2_edit__.started = performance.now(); });
          try {
            await s.ui.key('Control+z', { settle: 0 });
            await s.page.waitForFunction(() => globalThis.__p2_edit__?.totalMs !== null, null, { timeout: 30000 });
            const undo = await s.page.evaluate(() => globalThis.__p2_edit__);
            metrics.undoSamples.push(undo);
            if (Math.hypot(...undo.afterCentre.map((v, k) => v - edit.beforeCentre[k])) > .005) {
              throw new Error('Undo did not restore the column mesh');
            }
          } finally { await s.page.evaluate(() => globalThis.__p2_disarm__?.()); }
        }
        metrics.edit = frameStats(metrics.editSamples.map(v => v.totalMs));
        // Separate sixth edit for CPU profiling: profiler overhead must never
        // enter the acceptance samples. Save raw profile for bottleneck analysis.
        const cdp = await s.context.newCDPSession(s.page);
        try {
          await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
          await move(s, column.id);
          const { profile } = await cdp.send('Profiler.stop');
          artifacts.profile = { name: 'loaded-column-move.cpuprofile', bytes: Buffer.from(JSON.stringify(profile)) };
          await s.ui.key('Control+z', { settle: 1000 });
        } finally { await cdp.detach(); }
      }));
      if (!tasks.at(-1).ok) metrics.incompleteEdit = await s.page.evaluate(() => globalThis.__p2_edit__ ?? null);
      checks.push(check('five loaded-column edits and undos complete', metrics.editSamples.length === 5 && metrics.undoSamples.length === 5,
        `${metrics.editSamples.length} edits, ${metrics.undoSamples.length} undos`));
      checks.push(check('single-edit median below 100 ms including remesh', metrics.edit?.medianMs < 100,
        JSON.stringify(metrics.edit) ?? 'Edit measurement incomplete'));
    }
    checks.push(check('exclusive benchmark admission', admitted,
      admitted ? `worker request ${metrics.admission.jobId}; audit host samples alongside this result`
        : 'DIAGNOSTIC: PC benchmark admission is disabled; no timing qualification under the shared GPU helper'));
    return { ...await finish(s, tasks, checks, notes), metrics, artifacts };
  },
};
