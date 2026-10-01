/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { WorkerParser } from '@ifc-lite/parser/browser';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { advance, waitFor } from '@/test/render.js';
import { launchModelCommand } from '@/lib/commands/modeling/keys-workspace.js';
import '@/lib/commands/modeling/builtin.js';
import { startWorkflowRun } from '@/lib/flow/run-session.js';
import { hook, secondHook, skip, blankFile, load } from '@/test/blank-ifc-loader-harness.js';

/** Hold delivery of one genuinely decoded store, not a parser's result. */
function holdFirstMetadata(count = 1) {
  const parse = IfcParser.prototype.parseColumnar;
  const entries = Array.from({ length: count }, () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    return { release, gate, decoded: false };
  });
  let calls = 0;
  mock.method(IfcParser.prototype, 'parseColumnar', async function (
    this: IfcParser, ...args: Parameters<typeof parse>
  ) {
    const entry = entries[calls++];
    const store = await parse.apply(this, args);
    if (entry) {
      entry.decoded = true;
      await entry.gate;
    }
    return store;
  });
  return {
    release: (index = 0) => entries[index].release(),
    decoded: (index = 0) => entries[index].decoded,
  };
}

describe('owned primary completion and launcher (#6232)', () => {
  it('preserves a registered workflow owner through held primary registration and refuses an unowned replacement', { skip }, async () => {
    assert.ok(hook && secondHook);
    const run = startWorkflowRun();
    const held = holdFirstMetadata();
    const modelId = crypto.randomUUID();
    let settled = false;
    const pending = hook.loadFile(blankFile('METRE'), { kind: 'primary', modelId }, { workflowOwner: run.id })
      .then(() => { settled = true; });
    try {
      await waitFor(() => held.decoded() && !useViewerStore.getState().geometryStreamingActive,
        'real producer finished geometry while its workflow-owned metadata is held');
      assert.equal(settled, false, 'workflow caller waits for its own registration');
      const ownedCancel = useViewerStore.getState().activeLoadCanceller;
      assert.ok(ownedCancel);
      await assert.rejects(secondHook.loadFile(blankFile('METRE')), /A workflow is running/);
      assert.equal(useViewerStore.getState().activeModelId, modelId);
      assert.equal(useViewerStore.getState().activeLoadCanceller, ownedCancel, 'refused caller never steals cancellation ownership');
      assert.equal(useViewerStore.getState().loading, true);
      held.release();
      await act(async () => pending);
      assert.equal(useViewerStore.getState().models.get(modelId)?.loadState, 'complete');
      assert.equal(useViewerStore.getState().activeLoadCanceller, null);
      run.release();
      useViewerStore.getState().enterModelWorkspace({ modelId });
      assert.equal(launchModelCommand('Wall'), true);
      assert.equal(useViewerStore.getState().session?.modelId, modelId, 'launcher retains the completed owner after workflow release');
    } finally {
      held.release();
      run.release();
      await pending;
      await advance(20); // Drain the released real callback on the reverted early-return path too.
    }
  });

  it('cancels a real WorkerParser request before any metadata callback and releases its producer', { skip }, async () => {
    assert.ok(hook);
    // Replace only Worker allocation: the real WorkerParser owns its pending
    // request, signal, handler teardown and promise settlement. This transport
    // deliberately delivers no metadata, as with a terminated browser worker.
    class SilentParserWorker {
      terminated = false;
      onmessage: Worker['onmessage'] = null;
      onerror: Worker['onerror'] = null;
      onmessageerror: Worker['onmessageerror'] = null;
      postMessage() {}
      terminate() { this.terminated = true; }
    }
    const transport: { worker?: SilentParserWorker; parser?: WorkerParser } = {};
    let disposed = 0;
    let fallbackParses = 0;
    const dispose = GeometryProcessor.prototype.dispose;
    mock.method(GeometryProcessor.prototype, 'dispose', function (this: GeometryProcessor) {
      disposed++;
      return dispose.call(this);
    });
    const mainThreadParse = IfcParser.prototype.parseColumnar;
    mock.method(IfcParser.prototype, 'parseColumnar', function (
      this: IfcParser, ...args: Parameters<typeof mainThreadParse>
    ) { fallbackParses++; return mainThreadParse.apply(this, args); });
    const parse = WorkerParser.prototype.parseColumnar;
    mock.method(WorkerParser, 'isSupported', () => true);
    mock.method(WorkerParser.prototype, 'parseColumnar', function (
      this: WorkerParser, ...args: Parameters<typeof parse>
    ) {
      transport.parser = this;
      const previous = globalThis.Worker;
      // No geometry worker or result is substituted. Restore the global
      // immediately after this synchronous parser-transport allocation.
      globalThis.Worker = class extends SilentParserWorker {
        constructor() { super(); transport.worker = this; }
      } as unknown as typeof Worker;
      try { return parse.apply(this, args); }
      finally { globalThis.Worker = previous; }
    });
    let settled = false;
    const pending = hook.loadFile(blankFile('METRE')).then(() => { settled = true; });
    try {
      await waitFor(() => !!transport.worker && !!useViewerStore.getState().geometryResult
        && !useViewerStore.getState().geometryStreamingActive, 'real engine finishes while parser worker has emitted nothing');
      assert.ok(transport.worker);
      assert.equal(transport.worker.terminated, false);
      const cancel = useViewerStore.getState().activeLoadCanceller;
      assert.ok(cancel, 'worker metadata completion must retain the owned Cancel control');
      await act(async () => cancel());
      await waitFor(() => settled && transport.worker?.terminated === true, 'cancel settles the caller and terminates the real pending WorkerParser');
      assert.equal(useViewerStore.getState().models.size, 0);
      assert.equal(useViewerStore.getState().ifcDataStore, null);
      assert.equal(useViewerStore.getState().loading, false);
      assert.equal(useViewerStore.getState().error, null, 'owned worker cancellation is not a failed parse');
      await waitFor(() => disposed > 0, 'cancelled parser and geometry release their shared producer');
      assert.equal(disposed, 1, 'the real producer is disposed exactly once');
      assert.equal(fallbackParses, 0, 'a cancelled parser cannot start an obsolete fallback decode');
    } finally {
      transport.parser?.terminate();
      await act(async () => pending);
      await advance(20);
    }
  });

  it('failed metadata delivery settles completion, frees the real producer and marks the primary incomplete', { skip }, async () => {
    assert.ok(hook);
    const parse = IfcParser.prototype.parseColumnar;
    const failure = new Error('metadata delivery failed after real decode (#6232)');
    mock.method(IfcParser.prototype, 'parseColumnar', async function (
      this: IfcParser, ...args: Parameters<typeof parse>
    ) { await parse.apply(this, args); throw failure; });
    let disposed = 0;
    const dispose = GeometryProcessor.prototype.dispose;
    mock.method(GeometryProcessor.prototype, 'dispose', function (this: GeometryProcessor) {
      disposed++;
      return dispose.call(this);
    });
    await act(async () => hook?.loadFile(blankFile('METRE')));
    await waitFor(() => disposed > 0, 'a failed metadata transport settles the shared producer ownership');
    assert.equal(disposed, 1);
    const state = useViewerStore.getState();
    assert.equal(state.models.size, 1, 'retain the canonical primary error record');
    const primary = state.models.get(state.activeModelId ?? '');
    assert.equal(primary?.loadState, 'error', 'failed metadata cannot become a completed model');
    assert.ok(primary?.loadError?.includes('metadata delivery failed'));
    assert.equal(state.loading, false);
    assert.equal(state.activeLoadCanceller, null);
    assert.equal(useViewerStore.getState().session, null);
  });

  it('resolves only after real metadata registers the exact requested primary, then launches Wall', { skip }, async () => {
    assert.ok(hook);
    const held = holdFirstMetadata();
    const target = { kind: 'primary' as const, modelId: 'blank-launch-owner' };
    let settled = false;
    const pending = hook.loadFile(blankFile('METRE'), target).then(() => { settled = true; });
    try {
      await waitFor(() => held.decoded() && !!useViewerStore.getState().geometryResult
        && !useViewerStore.getState().geometryStreamingActive, 'real geometry finishes while decoded metadata is held');
      await advance(100);
      assert.equal(settled, false, 'loadFile must not release its launcher before metadata/model registration');
      assert.ok(useViewerStore.getState().activeLoadCanceller, 'metadata completion remains cancellable');
      held.release();
      await act(async () => pending);
      const state = useViewerStore.getState();
      assert.equal(state.activeModelId, target.modelId);
      assert.equal(state.models.get(target.modelId)?.loadState, 'complete');
      assert.equal(launchModelCommand('wall.place'), true, 'the actual workspace command accepts this completed blank model');
      assert.equal(useViewerStore.getState().session?.activeCommandId, 'wall.place');
    } finally { held.release(); await act(async () => pending); }
  });

  it('cancel after geometry settles without waiting for a missing metadata callback', { skip }, async () => {
    assert.ok(hook);
    const held = holdFirstMetadata();
    let settled = false;
    const pending = hook.loadFile(blankFile('METRE')).then(() => { settled = true; });
    try {
      await waitFor(() => held.decoded() && !!useViewerStore.getState().geometryResult
        && !useViewerStore.getState().geometryStreamingActive, 'real geometry completes before held metadata');
      const cancel = useViewerStore.getState().activeLoadCanceller;
      assert.ok(cancel, 'the active load owns cancellation until metadata settles');
      await act(async () => cancel());
      await waitFor(() => settled, 'owned cancellation settles loadFile without onFullDataStore');
      const state = useViewerStore.getState();
      assert.equal(state.models.size, 0);
      assert.equal(state.ifcDataStore, null);
      assert.equal(state.loading, false);
      assert.equal(state.activeLoadCanceller, null);
      assert.equal(state.session, null, 'a cancelled blank cannot launch a modeling session');
      held.release();
      await advance(20);
      assert.equal(useViewerStore.getState().models.size, 0, 'a later decoded callback cannot republish the cancelled model');
    } finally { held.release(); await act(async () => pending); }
  });

  for (const oldKind of ['primary', 'federated'] as const) {
    for (const sameHook of [false, true]) {
      it(`a new primary in ${sameHook ? 'the same' : 'another'} hook abandons an older ${oldKind} finalizer without late publication`, { skip }, async () => {
        assert.ok(hook && secondHook);
        if (oldKind === 'federated') await load(blankFile('METRE'));
        const held = holdFirstMetadata();
        let oldSettled = false;
        const oldTarget = oldKind === 'primary'
          ? { kind: 'primary' as const, modelId: 'obsolete-primary' }
          : { kind: 'federated' as const, modelId: 'obsolete-peer' };
        const oldLoad = hook.loadFile(blankFile('METRE'), oldTarget).then(() => { oldSettled = true; });
        try {
          await waitFor(held.decoded, 'old real parser has decoded its store before supersession');
          const nextHook = sameHook ? hook : secondHook;
          await act(async () => nextHook.loadFile(blankFile('MILLIMETRE')));
          const current = useViewerStore.getState();
          const currentId = current.activeModelId;
          const currentStore = current.ifcDataStore;
          assert.ok(currentId && currentStore);
          const currentModel = current.models.get(currentId);
          assert.equal(currentModel?.loadState, 'complete');
          await waitFor(() => oldSettled, 'new primary abandons the other hook finalizer without old metadata');
          held.release();
          await advance(100);
          const after = useViewerStore.getState();
          assert.equal(after.activeModelId, currentId);
          assert.equal(after.ifcDataStore, currentStore, 'obsolete metadata cannot overwrite the new primary');
          assert.equal(after.models.size, 1, 'obsolete federated metadata cannot append a ghost model');
          assert.equal(after.models.get(currentId), currentModel);
          assert.equal(after.loading, false);
          assert.equal(after.error, null);
        } finally {
          held.release();
          if (oldSettled) await act(async () => oldLoad);
          else await advance(20); // Release the decoded callback even when the baseline finalizer never settles.
        }
      });
    }
  }

  it('obsolete federated completion cannot clear the newer primary loading UI or its cancellation owner', { skip }, async () => {
    assert.ok(hook && secondHook);
    await load(blankFile('METRE'));
    const held = holdFirstMetadata(2);
    const oldLoad = hook.loadFile(blankFile('METRE'), { kind: 'federated', modelId: 'obsolete-ui-owner' });
    let newLoad: Promise<void> | undefined;
    try {
      await waitFor(() => held.decoded(0), 'real old peer metadata is decoded');
      newLoad = secondHook.loadFile(blankFile('MILLIMETRE'));
      await waitFor(() => held.decoded(1) && !!useViewerStore.getState().geometryResult
        && !useViewerStore.getState().geometryStreamingActive, 'new primary geometry finishes with its own metadata still held');
      const currentCancel = useViewerStore.getState().activeLoadCanceller;
      assert.ok(currentCancel);
      assert.equal(useViewerStore.getState().loading, true, 'new metadata completion still owns the loading UI');
      held.release(0);
      await act(async () => oldLoad);
      const state = useViewerStore.getState();
      assert.equal(state.loading, true, 'obsolete post-finalize flags cannot dismiss the new load');
      assert.equal(state.activeLoadCanceller, currentCancel);
      assert.equal(state.models.size, 1, 'only the new primary placeholder owns the replacement session');
      assert.equal(state.models.has('obsolete-ui-owner'), false, 'old peer cannot publish into the replacement session');
      held.release(1);
      await act(async () => newLoad);
      assert.equal(useViewerStore.getState().models.size, 1);
    } finally { held.release(0); held.release(1); await act(async () => { await oldLoad; await newLoad; }); }
  });

  it('concurrent federated hooks retain both genuine decoded models until independently completed', { skip }, async () => {
    assert.ok(hook && secondHook);
    const primary = await load(blankFile('METRE'));
    const held = holdFirstMetadata();
    const first = hook.loadFile(blankFile('METRE'), { kind: 'federated', modelId: 'first-peer' });
    try {
      await waitFor(held.decoded, 'first peer metadata is actually decoded');
      await act(async () => secondHook?.loadFile(blankFile('MILLIMETRE'), { kind: 'federated', modelId: 'second-peer' }));
      assert.equal(useViewerStore.getState().models.get(primary.id)?.ifcDataStore, primary.ifcDataStore);
      assert.equal(useViewerStore.getState().models.get(primary.id)?.geometryResult, primary.geometryResult);
      assert.ok(useViewerStore.getState().models.get('second-peer'));
      held.release();
      await act(async () => first);
      const models = useViewerStore.getState().models;
      assert.equal(models.size, 3);
      assert.equal(models.get(primary.id)?.ifcDataStore, primary.ifcDataStore);
      assert.equal(models.get(primary.id)?.geometryResult, primary.geometryResult);
      assert.equal(models.get(primary.id)?.idOffset, primary.idOffset);
      assert.equal(models.get('first-peer')?.geometryResult?.coordinateInfo?.lengthUnitScale, 1);
      assert.equal(models.get('second-peer')?.geometryResult?.coordinateInfo?.lengthUnitScale, 0.001);
      assert.equal(useViewerStore.getState().activeLoadCanceller, null);
    } finally { held.release(); await act(async () => first); }
  });
  it('failed federated metadata is owned while real geometry completion is still in flight', { skip }, async () => {
    assert.ok(hook);
    const primary = await load(blankFile('METRE'));
    const adaptive = GeometryProcessor.prototype.processAdaptive;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let geometryHeld = false;
    mock.method(GeometryProcessor.prototype, 'processAdaptive', async function* (
      this: GeometryProcessor, ...args: Parameters<typeof adaptive>
    ) {
      for await (const event of adaptive.apply(this, args)) {
        if (event.type === 'complete') { geometryHeld = true; await gate; }
        yield event;
      }
    });
    const parse = IfcParser.prototype.parseColumnar;
    let failed = false;
    mock.method(IfcParser.prototype, 'parseColumnar', async function (
      this: IfcParser, ...args: Parameters<typeof parse>
    ) {
      await parse.apply(this, args);
      failed = true;
      throw new Error('early peer metadata delivery failure (#6232)');
    });
    const pending = hook.loadFile(blankFile('METRE'), { kind: 'federated', modelId: 'failed-peer' });
    try {
      await waitFor(() => failed && geometryHeld, 'real peer decoding fails before held geometry completion');
      // No finalizer exists yet. The metadata promise must already have its
      // failure owner, rather than emit an unhandled rejection until geometry
      // completes. node:test treats such an unhandled rejection as a failure.
      await advance(100);
      assert.equal(useViewerStore.getState().models.get(primary.id)?.ifcDataStore, primary.ifcDataStore);
      release();
      await act(async () => pending);
      const state = useViewerStore.getState();
      assert.equal(state.models.has('failed-peer'), false);
      assert.equal(state.models.get(primary.id)?.ifcDataStore, primary.ifcDataStore);
      assert.equal(state.loading, false);
      assert.equal(state.activeLoadCanceller, null);
      assert.ok(state.error?.includes('early peer metadata delivery failure'));
    } finally { release(); await act(async () => pending); }
  });

});
