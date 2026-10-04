// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
'use strict';
const fs = require('node:fs'), path = require('node:path');
const root = fs.realpathSync(process.env.IFC_SOURCE_ROOT || process.cwd());
const { runSuite, assert } = require(path.join(root, 'docs/architecture/evidence/6232-final-integrated/producers/common.cjs'));
async function run(command) {
  await runSuite(`registered-${command}-preview`, async ({ page, modelId, count, capture, sameGraphGeometry }) => {
    const before = await capture('before-preview', [1222, 1262, 1407]);
    const started = await page.evaluate(async ({ modelId, command }) => {
      const url = file => '/' + file;
      const [runtime, ids, align, planner] = await Promise.all([
        import(url('src/lib/commands/modeling/runtime.ts')),
        import(url('src/store/globalId.ts')),
        import(url('src/lib/commands/modeling/align-gesture.ts')),
        import(url('src/lib/element-transform/commit.ts')),
      ]);
      globalThis.registeredPreviewRuntime = runtime;
      const store = globalThis.__ifc_lite_viewer_store__, s = store.getState();
      const loadedView = s.mutationViews.get(modelId);
      if (s.storeEditors.has(modelId) || loadedView?.hasPendingChanges() || loadedView?.hasChanges() || loadedView?.getMutations().length || loadedView?.getNewEntities().length) throw new Error('Requires first authoring edit with an unchanged loaded overlay; do not clear active overlays.');
      const loadedViewBefore = Boolean(loadedView), editorPresentBefore = s.storeEditors.has(modelId);
      globalThis.registeredPreviewLoadedView = loadedView;
      const selected = command === 'align' ? [1222, 1407, 1262] : [1407, 1222];
      s.setSelectedEntityIds(selected.map(id => ids.toGlobalIdFromModels(s.models, modelId, id)));
      store.getState().startCommand(`element.${command}`);
      let state = runtime.getCommandRuntime();
      if (state.command?.id !== `element.${command}` || !state.ctx?.workplane) throw new Error('Registered command did not start');
      const snap = local => ({ local, render: state.ctx.workplane.localToRender([...local, 0]), winner: null, guides: [], locked: false });
      if (command === 'move') { runtime.commandPointerDown(snap([0, 0])); runtime.commandPointerMove(snap([2, 3])); }
      if (command === 'rotate') {
        const pivot = state.gesture.pivot;
        if (!pivot) throw new Error('Registered Rotate has no selection pivot');
        runtime.commandPointerDown(snap([pivot[0] + 1, pivot[1]]));
        runtime.commandPointerMove(snap([pivot[0], pivot[1] + 1]));
      }
      state = runtime.getCommandRuntime();
      const g = state.gesture, current = store.getState(), view = current.mutationViews.get(modelId);
      if (!view) throw new Error('Canonical command planner did not initialize its edit view');
      const plan = planner.planSelectionTransform(current, modelId, command === 'align' ? g.targets : g.selection.ids);
      const ghosts = state.command.ghost(g, state.ctx);
      const ghostBounds = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
      for (const mesh of ghosts) for (let i = 0; i < mesh.positions.length; i += 3) {
        const point = state.ctx.workplane.renderToLocal(Array.from(mesh.positions.slice(i, i + 3)));
        for (let axis = 0; axis < 2; axis++) { ghostBounds.min[axis] = Math.min(ghostBounds.min[axis], point[axis]); ghostBounds.max[axis] = Math.max(ghostBounds.max[axis], point[axis]); }
      }
      return { command, selected, ghostBounds, pivot: g.pivot ?? null, loadedViewBefore, editorPresentBefore, loadedViewRetained: !loadedView || view === loadedView, effectiveOverlayEmpty: !view.hasPendingChanges() && !view.hasChanges(), roots: plan.roots.map(r => r.expressId), carried: plan.carried,
        alignMoveIds: command === 'align' ? align.alignMoves(g).map(m => m.id) : null,
        meshSourceIds: command === 'align' ? [1222] : [...new Set(current.models.get(modelId).geometryResult.meshes.filter(mesh => g.selection.movedGlobalIds.includes(mesh.expressId)).map(mesh => current.resolveGlobalIdFromModels(mesh.expressId).expressId))],
        movedLocalIds: command === 'align' ? null : g.selection.movedGlobalIds.map(id => current.resolveGlobalIdFromModels(id).expressId),
        ghostCount: ghosts.length, ghostsFinite: ghosts.every(m => Array.from(m.positions).every(Number.isFinite)),
        journal: view.getMutations(), records: view.getNewEntities(), allocator: view.peekNextExpressId() };
    }, { modelId, command });
    assert.equal(started.editorPresentBefore, false);
    assert.equal(started.loadedViewRetained, true); assert.equal(started.effectiveOverlayEmpty, true);
    assert.deepEqual(started.roots, [1222]);
    assert.ok(started.carried.includes(1407), 'real loaded filling is governed by its selected host');
    assert.ok(started.ghostCount > 0 && started.ghostsFinite, 'registered command emits actual finite previews');
    assert.deepEqual(started.journal, []); assert.deepEqual(started.records, []);
    if (command === 'align') {
      assert.deepEqual(started.alignMoveIds, [1222]); assert.equal(started.ghostCount, 1, 'carried child has no independent Align ghost');
    } else {
      assert.ok(started.movedLocalIds.includes(1222) && started.movedLocalIds.includes(1407));
      assert.equal(new Set(started.movedLocalIds).size, started.movedLocalIds.length, 'each real host/child previews once');
    }
    const nativePreviewSource = command === 'align' ? before : await capture('preview-native-source', started.meshSourceIds);
    sameGraphGeometry(nativePreviewSource, before);
    const sourceBounds = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
    for (const box of nativePreviewSource.planBounds) for (let axis = 0; axis < 2; axis++) {
      sourceBounds.min[axis] = Math.min(sourceBounds.min[axis], box.min[axis]);
      sourceBounds.max[axis] = Math.max(sourceBounds.max[axis], box.max[axis]);
    }
    let expected;
    if (command === 'align') {
      const host = before.planBounds.find(b => b.id === 1222), ref = before.planBounds.find(b => b.id === 1262);
      const delta = ref.min[0] - host.min[0];
      expected = { min: [host.min[0] + delta, host.min[1]], max: [host.max[0] + delta, host.max[1]] };
    } else if (command === 'move') expected = { min: [sourceBounds.min[0] + 2, sourceBounds.min[1] + 3], max: [sourceBounds.max[0] + 2, sourceBounds.max[1] + 3] };
    else {
      const [x, y] = started.pivot;
      expected = { min: [x - (sourceBounds.max[1] - y), y + (sourceBounds.min[0] - x)], max: [x - (sourceBounds.min[1] - y), y + (sourceBounds.max[0] - x)] };
    }
    for (const edge of ['min', 'max']) for (let axis = 0; axis < 2; axis++)
      assert.ok(Math.abs(started.ghostBounds[edge][axis] - expected[edge][axis]) < 1e-4, `actual ${command} preview bounds ${edge}/${axis} vs native fixture oracle`);
    sameGraphGeometry(await capture('registered-preview', [1222, 1262, 1407]), before);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!(await page.evaluate(() => globalThis.registeredPreviewRuntime.getCommandRuntime().command !== null))) break;
      await page.keyboard.press('Escape');
    }
    assert.equal(await page.evaluate(() => globalThis.registeredPreviewRuntime.getCommandRuntime().command), null);
    const cancelled = await capture('cancelled-preview', [1222, 1262, 1407]);
    sameGraphGeometry(cancelled, before);
    assert.deepEqual(cancelled.journal, before.journal); assert.deepEqual(cancelled.records, before.records);
    assert.equal(cancelled.allocator, started.allocator, 'preview cancellation allocates no IFC entities');
    assert.equal(await page.evaluate(modelId => {
      const view = globalThis.__ifc_lite_viewer_store__.getState().mutationViews.get(modelId);
      return (!globalThis.registeredPreviewLoadedView || view === globalThis.registeredPreviewLoadedView) && !view.hasPendingChanges() && !view.hasChanges();
    }, modelId), true, 'preview and Escape retain the real loaded view without effective overlay writes');
    const dir = path.join(process.env.IFC_EVIDENCE_DIR, `registered-${command}-preview`);
    fs.writeFileSync(path.join(dir, `${count}-runtime.json`), JSON.stringify({ modelId, count, started,
      scope: 'Registered command first-authoring preview and real Escape cancellation only. The real viewer initializes an empty mutation view at load; missing-view cold behavior is qualified separately by native regression controls. Same-host Align reference intentionally does not claim commit agreement; independent-reference native controls qualify commit.' }, null, 2));
  });
}
(async () => { for (const command of ['align', 'move', 'rotate']) await run(command); })().catch(error => { console.error(error); process.exitCode = 1; });
