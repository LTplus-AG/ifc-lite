/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The function policy is enforced, not advisory: exportCsv refuses without a
 * user gesture and refuses agent calls, through every entry point (the gate,
 * and the A2UI catalog function an action or binding invokes). Only the
 * download itself is observed, through the shared download seam.
 */

import '@/test/setup-dom.js';
import { clearDownloads, downloadedNames } from '@/test/download-capture.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { encodeRef, IFC_FUNCTION_POLICY } from '@ifc-lite/a2ui';
import { seedA2uiModels } from '@/test/a2ui-fixture';
import { ifcFunctionImplementations } from './catalog';
import { assertAllowed, entitiesCsv, isColouringActive, markColouringActive, onViewReset, PolicyRefusal, resolveTarget, runIfcFunction, safeColor } from './functions';
import { A2uiMessageSession } from './session';

describe('IFC function policy', () => {
  beforeEach(() => clearDownloads());

  it('refuses exportCsv without a user gesture and from the agent', async () => {
    const { host } = await seedA2uiModels();
    const args = { query: { types: ['IfcWall'] } };
    assert.throws(() => runIfcFunction(host, 'exportCsv', args, { caller: 'renderer', userActivated: false }), PolicyRefusal);
    assert.throws(() => runIfcFunction(host, 'exportCsv', args, { caller: 'agent', userActivated: true }), PolicyRefusal);
    assert.deepEqual(downloadedNames(), [], 'nothing was written');
    runIfcFunction(host, 'exportCsv', args, { caller: 'renderer', userActivated: true });
    assert.deepEqual(downloadedNames(), ['ifc-entities.csv']);
  });

  it('refuses through the catalog function when the evaluation is passive or not user-activated', async () => {
    const { host } = await seedA2uiModels();
    const exportCsv = ifcFunctionImplementations(host).find((f) => f.name === 'exportCsv');
    assert.ok(exportCsv);
    assert.equal(exportCsv.allowedCallers, 'rendererOnly');
    assert.equal(exportCsv.requiresUserActivation, true);
    const passive = { isUserActivated: true, isPassiveEvaluation: true } as Parameters<typeof exportCsv.execute>[1];
    const idle = { isUserActivated: false, isPassiveEvaluation: false } as Parameters<typeof exportCsv.execute>[1];
    assert.throws(() => exportCsv.execute({ query: { types: ['IfcWall'] } }, passive), PolicyRefusal);
    assert.throws(() => exportCsv.execute({ query: { types: ['IfcWall'] } }, idle), PolicyRefusal);
    assert.deepEqual(downloadedNames(), []);
  });

  it('selects and counts nothing when the query has a problem, instead of running broader than written', async () => {
    const { host } = await seedA2uiModels();
    const bad = { query: { types: ['Wall'] } };
    const target = resolveTarget(host, bad);
    assert.deepEqual(target.refs, [], 'an invalid type is not dropped into an all-products query');
    assert.ok(target.problems.length > 0);
    assert.throws(() => runIfcFunction(host, 'countEntities', bad, { caller: 'renderer', userActivated: false }), /types/);
    const wall = encodeRef(host.candidates(['IfcWall'], undefined)[0].ref);
    assert.throws(() => runIfcFunction(host, 'select', { ...bad, refs: [wall] }, { caller: 'agent', userActivated: false }), /query has problems/);
    assert.deepEqual(host.getSelection(), [], 'nothing was selected');
    assert.ok(resolveTarget(host, { query: { types: ['IfcWall'] } }).refs.length > 0);
    const walls = { query: { types: ['IfcWall'] } };
    assert.throws(() => runIfcFunction(host, 'sumQuantity', { ...walls, path: 'Qto_WallBaseQuantities.NetVolumee' }, { caller: 'renderer', userActivated: false }), /no matched entity has a number/);
    assert.equal(runIfcFunction(host, 'sumQuantity', { query: { types: ['IfcDoor'] }, path: 'Qto_DoorBaseQuantities.Area' }, { caller: 'renderer', userActivated: false }), 0, 'an empty match set sums to a true 0');
  });

  it('says when an action target hits the 5,000 query ceiling (#11344)', async () => {
    const { host } = await seedA2uiModels();
    const [wall] = host.candidates(['IfcWall'], undefined);
    const many = Array.from({ length: 5001 }, (_, i) => ({ ...wall, key: `${wall.ref.modelId}:${i + 1}`, ref: { modelId: wall.ref.modelId, expressId: i + 1 } }));
    const target = resolveTarget({ ...host, candidates: () => many }, { query: { types: ['IfcWall'] } });
    assert.equal(target.refs.length, 5000);
    assert.equal(target.cappedFrom, 5001);
    assert.equal(resolveTarget(host, { query: { types: ['IfcWall'] } }).cappedFrom, undefined);
    // An explicit ref covering the one match past the ceiling: nothing was left out.
    const covered = resolveTarget({ ...host, candidates: () => many }, { query: { types: ['IfcWall'] }, refs: [`${wall.ref.modelId}:5001`] });
    assert.equal(covered.refs.length, 5001);
    assert.equal(covered.cappedFrom, undefined);
  });

  it('tells every listener when the view resets, whoever reset it (#11344)', async () => {
    const { host } = await seedA2uiModels();
    let heard = 0;
    const stop = onViewReset(host, () => { heard++; });
    runIfcFunction(host, 'resetView', {}, { caller: 'agent', userActivated: false });
    runIfcFunction(host, 'resetView', {}, { caller: 'renderer', userActivated: true });
    stop();
    runIfcFunction(host, 'resetView', {}, { caller: 'renderer', userActivated: true });
    assert.equal(heard, 2);
    // A reset also ends every active colouring, so a remounted legend no longer claims it.
    markColouringActive(host, 'legend|4');
    assert.equal(isColouringActive(host, 'legend|4'), true);
    runIfcFunction(host, 'resetView', {}, { caller: 'renderer', userActivated: true });
    assert.equal(isColouringActive(host, 'legend|4'), false);
    // So does any other colouring painting over it.
    markColouringActive(host, 'legend|4');
    runIfcFunction(host, 'colorize', { query: { types: ['IfcWall'] } }, { caller: 'renderer', userActivated: true });
    assert.equal(isColouringActive(host, 'legend|4'), false);
  });

  it('lets a live session auto-apply once per key and a replayed chat record never', async () => {
    const { host } = await seedA2uiModels();
    const shared = new Set<string>();
    const live = new A2uiMessageSession(host, true, shared);
    let runs = 0;
    const ok = () => { runs++; return true; };
    assert.equal(live.autoApply('failing', () => false), 'off', 'a failed apply is not recorded');
    assert.equal(live.autoApply('failing', ok), 'applied', 'so the next mount tries again');
    assert.equal(live.autoApply('legend', ok), 'applied');
    assert.equal(live.autoApply('legend', ok), 'applied', 'a remount shows it applied and does not recolour again');
    assert.equal(runs, 2);
    const remounted = A2uiMessageSession.replay(host, { v: 1, segments: [] }, '', true, shared);
    assert.equal(remounted.autoApply('legend', ok), 'applied', 'a new session for the same payload shares the claim');
    const replayed = A2uiMessageSession.replay(host, { v: 1, segments: [] }, '');
    assert.equal(replayed.autoApply('legend', ok), 'off');
    assert.equal(runs, 2, 'neither a remount nor a replay recolours');
    for (const s of [live, remounted, replayed]) s.dispose();
  });

  it('lets the agent call view and read functions, and nothing outside the catalog', () => {
    const agentCallable = ['select', 'isolate', 'hide', 'show', 'colorize', 'flyTo', 'resetView', 'getSelection', 'countEntities', 'sumQuantity'];
    for (const name of Object.keys(IFC_FUNCTION_POLICY)) {
      const call = () => assertAllowed(name, { caller: 'agent', userActivated: false });
      if (agentCallable.includes(name)) assert.doesNotThrow(call, name);
      else assert.throws(call, PolicyRefusal, name);
    }
    assert.deepEqual(Object.keys(IFC_FUNCTION_POLICY).filter((n) => !agentCallable.includes(n)), ['exportCsv']);
    assert.throws(() => assertAllowed('eval', { caller: 'renderer', userActivated: true }), PolicyRefusal);
  });

  it('guards CSV cells against formula injection and colours against arbitrary CSS', async () => {
    const { host } = await seedA2uiModels();
    const walls = host.candidates(['IfcWall'], undefined).map((e) => e.ref);
    const csv = entitiesCsv(host, walls, [{ path: 'name', label: '=HYPERLINK("x")' }]);
    assert.ok(csv.startsWith(`"'=HYPERLINK(""x"")"`) || csv.startsWith(`'=HYPERLINK`), csv.split('\n')[0]);
    assert.equal(csv.trim().split('\n').length, 5);
    assert.equal(safeColor('#12ab34'), '#12ab34');
    assert.equal(safeColor('url(javascript:alert(1))'), '#e5484d');
  });
});
