/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { resetFeaturesForTest } from '@/lib/features';
import { BACK_WALL, BACK_WALL_NAME, SAMPLE_MODEL, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { deferred } from '@/test/race';
import type { DeliveryClaim } from '../delivery';
import { createMainViewerToolHost } from '../main-viewer-host';
import { resolveModel, usableModel } from '../main-viewer-dispatch';
import { executeOperation } from './executor';
import { viewerOperation } from './registry';

const initial = useViewerStore.getState();
beforeEach(async () => { resetFeaturesForTest(); await seedAuthoringSample(); });
afterEach(() => { useViewerStore.setState(initial); resetFeaturesForTest(); });

const cases = [
  { callers: ['initiator'], drops: [['initiator']], signals: [[], ['initiator']] },
  { callers: ['initiator', 'joiner'], drops: [['initiator'], ['joiner'], ['initiator', 'joiner']],
    signals: [[], ['initiator'], ['joiner'], ['initiator', 'joiner']] },
] as const;
const phases = ['before native work', 'during native work', 'before delivery', 'after delivery'] as const;
const request = {
  operation_id: 'properties.prepare', model_id: SAMPLE_MODEL, idempotency_key: 'prepare',
  input: { proposal_json: JSON.stringify({ version: 1, kind: 'model.changes', title: 'Exact name', changes: [{
    op: 'attribute.set', target: { globalId: BACK_WALL, modelId: SAMPLE_MODEL, ifcClass: 'IfcWall', name: BACK_WALL_NAME },
    name: 'Name', expected: BACK_WALL_NAME, value: 'Prepared name',
  }] }) },
};
const tokenOf = (result: unknown) => (result as { result: { token: string } }).result.token;

for (const keyed of [false, true]) {
  test(`#11029: direct ${keyed ? 'keyed' : 'unkeyed'} cancellation settles before native work returns`, async t => {
    const host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
    const model = usableModel(resolveModel(host, request), 'store', request.operation_id);
    const entry = viewerOperation(request.operation_id);
    const execute = entry.execute.bind(entry);
    const entered = deferred<AbortSignal>(), resume = deferred();
    const undone = deferred();
    t.after(() => resume.resolve());
    t.mock.method(entry, 'execute', async (input: unknown, context: Parameters<typeof execute>[1]) => {
      const result = await execute(input, { ...context, retain: undo => context.retain(() => { undo(); undone.resolve(); }) });
      assert.ok(context.signal);
      entered.resolve(context.signal);
      await resume.promise;
      return result;
    });
    const controller = new AbortController();
    const result = executeOperation(host, model, { ...request, idempotency_key: keyed ? request.idempotency_key : undefined },
      { signal: controller.signal }, true);
    const nativeSignal = await Promise.race([entered.promise, result.then(() => { throw new Error('Prepare ended before its gate'); })]);
    const rejected = assert.rejects(result, { code: 'CANCELLED' });
    controller.abort();
    assert.equal(nativeSignal.aborted, true);
    // One turn is sufficient to observe the cancellation without releasing the handler.
    const pending = Symbol('pending');
    assert.notEqual(await Promise.race([rejected, new Promise(resolve => setImmediate(() => resolve(pending)))]), pending);
    resume.resolve();
    await undone.promise;
  });
}

for (const { callers, drops, signals } of cases) {
  for (const abandoned of drops) for (const signalled of signals) for (const phase of phases) {
    test(`#11029: ${callers.length} claims, drop ${abandoned.join('+')}, signals ${signalled.join('+') || 'none'}, ${phase}`, async t => {
      const host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
      const model = usableModel(resolveModel(host, request), 'store', request.operation_id);
      const entry = viewerOperation(request.operation_id);
      const execute = entry.execute.bind(entry);
      const entered = deferred<{ token: string; signal: AbortSignal }>();
      const resume = deferred();
      let runs = 0, undos = 0, deliveries = 0;
      t.mock.method(entry, 'execute', async (input: unknown, context: Parameters<typeof execute>[1]) => {
        const first = ++runs === 1;
        const result = await execute(input, { ...context, retain: (undo, deliver) => context.retain(
          () => { undos++; undo(); },
          () => { deliveries++; deliver?.(); },
        ) });
        if (first) {
          assert.ok(context.signal, 'keyed native work has an execution-owned signal');
          entered.resolve({ token: (result as { token: string }).token, signal: context.signal });
          await resume.promise;
        }
        return result;
      });
      t.after(() => resume.resolve());
      const claims = callers.map(name => {
        const controller = signalled.some(caller => caller === name) ? new AbortController() : undefined;
        let claim: DeliveryClaim | undefined;
        const result = executeOperation(host, model, request, {
          signal: controller?.signal, claimDelivery: next => { claim = next; },
        }, true);
        const settled = result.then(value => ({ value }), error => ({ error: error as unknown }));
        assert.ok(claim);
        return { name, controller, claim, settled };
      });
      const [first] = claims;
      const dropsAll = abandoned.length === claims.length;
      const allDroppedBeforeDelivery = dropsAll && phase !== 'after delivery';
      let native: Awaited<typeof entered.promise> | undefined;
      if (phase !== 'before native work') {
        native = await Promise.race([
          entered.promise,
          first.settled.then(result => { throw new Error('Native prepare ended before its gate', { cause: result }); }),
        ]);
      }
      if (phase === 'before delivery' || phase === 'after delivery') {
        resume.resolve();
        const result = await first.settled;
        assert.ok('value' in result, JSON.stringify(result));
        assert.equal(tokenOf(result.value), native?.token);
      }
      if (phase === 'after delivery') first.claim.deliver();
      for (const caller of claims.filter(({ name }) => abandoned.some(drop => drop === name))) {
        caller.controller?.abort();
        caller.claim.drop();
        caller.claim.drop();
        caller.claim.deliver();
      }
      if (native) assert.equal(native.signal.aborted, dropsAll && phase === 'during native work');
      resume.resolve();
      const results = await Promise.all(claims.map(({ settled }) => settled));
      const cancelled = dropsAll && (phase === 'before native work' || phase === 'during native work');
      for (const result of results) {
        if (cancelled) assert.ok('error' in result && (result.error as { code?: string }).code === 'CANCELLED');
        else assert.ok('value' in result, JSON.stringify(result));
      }
      if (!dropsAll && phase !== 'after delivery') {
        for (const caller of claims.filter(({ name }) => !abandoned.some(drop => drop === name))) caller.claim.deliver();
      }
      assert.equal(undos, allDroppedBeforeDelivery && phase !== 'before native work' ? 1 : 0);
      assert.equal(deliveries, allDroppedBeforeDelivery ? 0 : 1);
      const original = results.find(result => 'value' in result);
      const oldToken = original ? tokenOf(original.value) : native?.token;
      const retry = tokenOf(await executeOperation(host, model, request, {}, true));
      if (allDroppedBeforeDelivery) {
        assert.notEqual(retry, oldToken);
        assert.equal(runs, phase === 'before native work' ? 1 : 2);
      } else {
        assert.equal(retry, oldToken);
        assert.equal(runs, 1);
      }
      assert.equal(undos, allDroppedBeforeDelivery && phase !== 'before native work' ? 1 : 0);
      assert.equal(deliveries, 1);
    });
  }
}
