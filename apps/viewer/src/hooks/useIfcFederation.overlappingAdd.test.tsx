/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `addModel`'s outcome under overlap. Every call bumps the hook's load
 * session, and `addModel` used to return `null` whenever a newer add had
 * started, even though its own model had registered. Callers trusted that
 * null: a blank Scan-to-BIM model reported "failed", a reload lost its tags,
 * a federation-setup slot counted as failed with ANOTHER load's error as the
 * reason. The result now reports what happened to THIS load: the id when the
 * model is in the store, null with this load's own failure reason otherwise.
 *
 * `loadFile` is stubbed with deferred promises so the test fixes the
 * interleaving: A starts, B starts, then each settles on cue.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture.js';
import { useIfcFederation } from './useIfcFederation.js';
import type { LoadTarget } from './useIfcLoader.js';
import type { ModelLoadOptions } from './modelLoadOptions.js';

interface PendingLoad {
  readonly modelId: string;
  readonly options: ModelLoadOptions | undefined;
  /** Settle the load the way `loadFile` does: register, or report and return. */
  register(): void;
  fail(message: string): void;
}

let pending: PendingLoad[] = [];

const loadFileStub = (_file: File, target?: LoadTarget, options?: ModelLoadOptions): Promise<void> =>
  new Promise<void>((resolve) => {
    const modelId = target?.kind === 'federated' ? target.modelId : assert.fail('addModel loads a federated target');
    const idOffset = pending.length * 1_000_000;
    pending.push({
      modelId,
      options,
      // loadFile's contract (useIfcLoader.onLoadError.test.tsx covers the real side):
      // register, then report the registration; or report the failure and return.
      register: () => {
        useViewerStore.getState().addModel(fixtureModel(modelId, { idOffset }));
        options?.onModelRegistered?.();
        resolve();
      },
      fail: (message) => {
        options?.onLoadError?.(message);
        resolve();
      },
    });
  });

let hookApi: ReturnType<typeof useIfcFederation> | null = null;
function Probe(): null {
  hookApi = useIfcFederation(loadFileStub);
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(async () => {
  pending = [];
  hookApi = null;
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Probe />));
  assert.ok(hookApi);
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
});

const ifc = (name: string) => new File(['ISO-10303-21;'], name);

async function loadsStarted(count: number): Promise<void> {
  for (let i = 0; i < 50 && pending.length < count; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(pending.length, count, `${count} loads reached loadFile`);
}

describe('addModel under overlapping federated adds (federation-addmodel-race)', () => {
  it('returns the id of a model that registered after a newer add started', async () => {
    const a = hookApi!.addModel(ifc('a.ifc'), { modelId: 'a' });
    const b = hookApi!.addModel(ifc('b.ifc'), { modelId: 'b' });
    await loadsStarted(2);

    pending[0].register();
    assert.equal(await a, 'a', 'A registered, so A succeeded even though B started later');
    pending[1].register();
    assert.equal(await b, 'b');
    assert.deepEqual([...useViewerStore.getState().models.keys()].sort(), ['a', 'b']);
  });

  it('returns null when the model it registered was cleared before it returned (a primary load)', async () => {
    const a = hookApi!.addModel(ifc('a.ifc'), { modelId: 'a' });
    await loadsStarted(1);
    pending[0].register();
    useViewerStore.getState().clearAllModels();
    assert.equal(await a, null);
  });

  it('a replacement transaction (failIfSuperseded, #8566) still reports a newer add as cancelling it', async () => {
    const replacement = hookApi!.addModel(ifc('a.ifc'), { modelId: 'replacement', failIfSuperseded: true });
    await loadsStarted(1);
    const other = hookApi!.addModel(ifc('b.ifc'), { modelId: 'other' });
    await loadsStarted(2);

    pending[0].register();
    assert.equal(await replacement, null, 'superseded: the caller cleans its registered model up');
    assert.equal(useViewerStore.getState().models.has('replacement'), true);
    pending[1].register();
    assert.equal(await other, 'other');
  });

  it('does not claim a model another overlapping add registered under the same explicit id', async () => {
    const first = hookApi!.addModel(ifc('a.ifc'), { modelId: 'same' });
    const second = hookApi!.addModel(ifc('a.ifc'), { modelId: 'same' });
    await loadsStarted(2);

    pending[1].register();
    assert.equal(await second, 'same');
    pending[0].fail('a.ifc: IFC parsing failed');
    assert.equal(await first, null, 'the first add failed; the registered model is the second add\'s');
  });

  it("reports this add's own failure reason, not the global error a later load wrote", async () => {
    const reasons: string[] = [];
    const a = hookApi!.addModel(ifc('a.ifc'), { modelId: 'a', onError: (message) => reasons.push(message) });
    const b = hookApi!.addModel(ifc('b.ifc'), { modelId: 'b', onError: () => assert.fail('B did not fail') });
    await loadsStarted(2);

    pending[0].fail('a.ifc: IFC parsing failed');
    useViewerStore.getState().setError('b.ifc: unrelated later error');
    assert.equal(await a, null);
    assert.deepEqual(reasons, ['a.ifc: IFC parsing failed']);

    pending[1].register();
    assert.equal(await b, 'b');
  });
});
