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
import { IFC_FUNCTION_POLICY } from '@ifc-lite/a2ui';
import { seedA2uiModels } from '@/test/a2ui-fixture';
import { ifcFunctionImplementations } from './catalog';
import { assertAllowed, entitiesCsv, PolicyRefusal, resolveTarget, runIfcFunction, safeColor } from './functions';
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
    assert.equal(runIfcFunction(host, 'countEntities', bad, { caller: 'renderer', userActivated: false }), null);
    assert.ok(resolveTarget(host, { query: { types: ['IfcWall'] } }).refs.length > 0);
  });

  it('lets a live session auto-apply once per key and a replayed chat record never', async () => {
    const { host } = await seedA2uiModels();
    const live = new A2uiMessageSession(host);
    assert.equal(live.claimAutoApply('legend'), true);
    assert.equal(live.claimAutoApply('legend'), false, 'a remount does not recolour again');
    const replayed = A2uiMessageSession.replay(host, { v: 1, segments: [] }, '');
    assert.equal(replayed.claimAutoApply('legend'), false);
    live.dispose();
    replayed.dispose();
  });

  it('lets the agent call view and read functions, and nothing outside the catalog', () => {
    for (const [name, policy] of Object.entries(IFC_FUNCTION_POLICY)) {
      const call = () => assertAllowed(name, { caller: 'agent', userActivated: false });
      if (policy.agentCallable && !policy.userActivation) assert.doesNotThrow(call, name);
      else assert.throws(call, PolicyRefusal, name);
    }
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
