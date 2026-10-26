/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';

export const retainedCallbackSeams = ['filter', 'every-rekey', 'every-validate', 'every-create'];
const split = shares => ({ base: ['source'], head: ['a', 'b'], relation: 'split', reason: 'split:verified', shares });
const sidecar = entry => ({ format: 'ifc-lite/lineage', version: 1,
  base: { hash: 'old' }, head: { hash: 'new' }, entries: [entry], deleted: [] });
const row = successors => [{ key: 'source', successors, relation: 'split', orphan: successors.length === 0 }];
const rekey = (wasm, entry, policy = 'largest-share') => wasm.diffRekeyByLineage(['source'], [entry], [], policy);

async function gcTurn() {
  // A WeakRef dereference keeps its target alive until this JS job ends.
  // Cross a job boundary before GC, then let both V8 and binding finalizers run.
  await turn();
  globalThis.gc();
  await turn();
}

function tracker() {
  const finalized = new Set();
  const refs = new Map();
  const registry = new FinalizationRegistry(token => finalized.add(token));
  return {
    // Holdings and bookkeeping contain labels/WeakRefs, never the targets or
    // closures over them. Keep the registry alive through the release check.
    watch(label, target) {
      assert.ok(!refs.has(label), `duplicate finalizer label: ${label}`);
      refs.set(label, new WeakRef(target));
      registry.register(target, label);
    },
    assertRetained(prefix, callbackOnly = false) {
      for (const [label, ref] of refs) {
        if (!label.startsWith(`${prefix}/`)) continue;
        if (callbackOnly && label !== `${prefix}/callback`) continue;
        assert.ok(!finalized.has(label), `survival: ${label} must not finalize`);
        assert.ok(ref.deref(), `survival: ${label}`);
      }
    },
    pending() { return [...refs.keys()].filter(token => !finalized.has(token)); },
    assertReleased() {
      assert.equal(finalized.size, refs.size, 'release: every tracked target must finalize');
      for (const [label, ref] of refs) assert.equal(ref.deref(), undefined, `release: ${label}`);
    },
  };
}

async function warmedCount(wasm, tracked) {
  let previous;
  let stable = 0;
  const samples = [];
  for (let attempt = 0; attempt < 64; attempt++) {
    await gcTurn();
    const count = wasm.diffTestExternrefLiveCount();
    samples.push(count);
    stable = tracked.pending().length === 0 ? (count === previous ? stable + 1 : 1) : 0;
    if (stable === 4) return { count, samples };
    previous = count;
  }
  assert.fail(`warm owned-handle count did not settle: ${JSON.stringify(samples)}, `
    + `unfinalized=${JSON.stringify(tracked.pending())}`);
}

async function releasedCount(wasm, baseline, tracked, label) {
  let stable = 0;
  const samples = [];
  for (let attempt = 0; attempt < 64; attempt++) {
    await gcTurn();
    const count = wasm.diffTestExternrefLiveCount();
    samples.push(count);
    // No allowance, growth slope, or newly raised per-round baseline: even one
    // leaked owned handle per invocation must fail the first affected cohort.
    stable = count === baseline && tracked.pending().length === 0 ? stable + 1 : 0;
    if (stable === 4) {
      tracked.assertReleased();
      return samples;
    }
  }
  assert.fail(`${label}: post-release baseline=${baseline}, counts=${JSON.stringify(samples)}, `
    + `unfinalized=${JSON.stringify(tracked.pending())}`);
}

function retainedGraph(wasm, seam, throws, tracked, label) {
  const sentinel = { failure: `${label}: retained method/getter/finite` };
  const shares = [0.4, 0.6];
  const state = { current: shares, fail: false, reenter: false, reentries: 0 };
  const entry = { ...split(shares), get shares() {
    if (state.fail) throw sentinel;
    if (state.reenter) {
      state.reenter = false;
      // Reenter the SAME immutable callback while its outer call is active.
      assert.equal(shares.savedFilter(state.current[1]), true);
      assert.deepEqual(rekey(wasm, split([0, 1])), row(['b']));
      state.reentries++;
    }
    return state.current;
  } };
  const targets = { entry, shares };
  let captures = 0;
  function retain(callback) {
    assert.equal(++captures, 1, 'one retained method invocation per graph');
    const name = seam === 'filter' ? 'savedFilter' : 'savedEvery';
    this[name] = callback;
    targets.callback = callback;
    targets.callbackShares = this;
    // Creation copies shares. Connect that projected array back into the same
    // graph and track it too; leave every link intact when external refs go.
    if (this !== shares) {
      shares.projected = this;
      this.owner = entry;
    }
    assert.equal(callback(0.6), true);
    assert.deepEqual(rekey(wasm, split([0, 1]), 'copy-to-all'), row(['a', 'b']), 'active WASM reentry');
    if (throws) throw sentinel;
    return seam === 'filter' ? Array.prototype.filter.call(this, callback) : true;
  }
  if (seam === 'filter') shares.filter = retain;
  else if (seam !== 'every-create') shares.every = retain;

  function run() {
    if (seam === 'every-validate') {
      assert.deepEqual(wasm.diffValidateSidecarValue(sidecar(entry), true), []);
    } else if (seam === 'every-create') {
      const result = wasm.diffCreateSidecarValue(sidecar(entry), true);
      assert.deepEqual(Array.from(result.entries[0].shares), [0.4, 0.6]);
    } else assert.deepEqual(rekey(wasm, entry), row(['b']));
  }
  const everyDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'every');
  try {
    if (seam === 'every-create') {
      Object.defineProperty(Array.prototype, 'every', { ...everyDescriptor, value(callback, ...args) {
        if (this.length === 2 && this[0] === 0.4 && this[1] === 0.6) return retain.call(this, callback);
        return Reflect.apply(everyDescriptor.value, this, [callback, ...args]);
      } });
    }
    if (throws) assert.throws(run, error => error === sentinel, 'method throw identity');
    else run();
  } finally {
    Object.defineProperty(Array.prototype, 'every', everyDescriptor);
  }
  assert.equal(captures, 1, 'required custom method must actually receive a callback');
  for (const [name, target] of Object.entries(targets)) {
    if (name !== 'callbackShares' || target !== shares) tracked.watch(`${label}/${name}`, target);
  }
  return { callback: targets.callback, later() {
    if (seam === 'filter') {
      state.current = [0.1, 0.9];
      state.reenter = true;
      assert.equal(shares.savedFilter(0.9), true, 'saved alias reads current entry.shares');
      assert.equal(targets.callback(0.6), false, 'direct alias reads current entry.shares');
      assert.equal(state.reentries, 1, 'later callback and WASM reentry occurred');
      state.fail = true;
      assert.throws(() => targets.callback(0.9), error => error === sentinel, 'later getter throw identity');
      state.fail = false;
      assert.equal(targets.callback(0.9), true, 'later callback recovers');
      // CRITICAL: restore entry -> original shares -> saved callback. Leaving
      // the replacement array here would break and conceal the old Rust-root
      // entry -> shares -> callback cycle identified by R134 (unmeasured).
      state.current = shares;
      assert.equal(shares.savedFilter(0.6), true);
    } else {
      assert.equal(targets.callbackShares.savedEvery(0.4), true);
      assert.equal(targets.callback(-1), false);
      assert.equal(targets.callback(NaN), false);
      const finiteDescriptor = Object.getOwnPropertyDescriptor(Number, 'isFinite');
      let nested = false;
      try {
        Object.defineProperty(Number, 'isFinite', { ...finiteDescriptor, value(value) {
          if (nested) return finiteDescriptor.value(value);
          nested = true;
          assert.equal(targets.callback(0.6), true, 'same every callback reentry');
          assert.deepEqual(rekey(wasm, split([0, 1]), 'copy-to-all'), row(['a', 'b']));
          throw sentinel;
        } });
        assert.throws(() => targets.callback(0.4), error => error === sentinel, 'later finite throw identity');
      } finally { Object.defineProperty(Number, 'isFinite', finiteDescriptor); }
      assert.equal(targets.callback(0.4), true, 'retained every recovers after throw');
    }
    assert.deepEqual(rekey(wasm, split([0.4, 0.6])), row(['b']), 'later same-module reuse');
  } };
}

async function retainThenRelease(wasm, seam, throws, tracked, label) {
  let graph = retainedGraph(wasm, seam, throws, tracked, label);
  for (let i = 0; i < 3; i++) await gcTurn();
  tracked.assertRetained(label);
  graph.later();
  let callback = graph.callback;
  // Keep ONLY the callback externally. The filter must keep its JS context
  // alive itself; a weak context bridge would fail this survival phase. Every
  // has no input capture, so its input objects may already reclaim here.
  graph = null;
  for (let i = 0; i < 3; i++) await gcTurn();
  tracked.assertRetained(label, seam !== 'filter');
  assert.equal(callback(0.6), true, 'callback alone survives actual GC turns');
  assert.equal(callback(seam === 'filter' ? 0.4 : -1), false);
  if (seam !== 'filter') {
    const descriptor = Object.getOwnPropertyDescriptor(Number, 'isFinite');
    try {
      Object.defineProperty(Number, 'isFinite', { ...descriptor, value: () => 0 });
      assert.ok(Object.is(callback(0.4), 0), 'retained every preserves the falsy operand');
    } finally { Object.defineProperty(Number, 'isFinite', descriptor); }
  }
  // Drop the final external alias without deleting saved callbacks or breaking
  // internal edges. Return before collection so this activation is gone too.
  callback = null;
}

export async function checkRetainedCallbacks(wasm, seam, diagnostic = () => {}) {
  assert.ok(retainedCallbackSeams.includes(seam));
  for (const name of ['gc', 'WeakRef', 'FinalizationRegistry']) {
    assert.equal(typeof globalThis[name], 'function', `required ${name}; run Node with --expose-gc, never skip`);
  }
  for (const name of ['diffTestExternrefLiveCount', 'diffRekeyByLineage',
    'diffValidateSidecarValue', 'diffCreateSidecarValue']) {
    assert.equal(typeof wasm[name], 'function', `required fresh composed host+sparse feature export: ${name}`);
  }
  // Warm both outcomes and all owned-handle/static caches before fixing the
  // baseline. Warm finalizers must finish too; they cannot pollute later counts.
  const warm = tracker();
  for (const throws of [false, true]) await retainThenRelease(wasm, seam, throws, warm, `warm/${throws}`);
  const initial = await warmedCount(wasm, warm);
  await releasedCount(wasm, initial.count, warm, `${seam}/warm`);
  diagnostic({ seam, phase: 'warm', node: process.version, baseline: initial.count, samples: initial.samples });
  for (let round = 0; round < 6; round++) {
    const tracked = tracker();
    for (const throws of [false, true]) {
      // Each cohort covers successful method return AND throw after retention.
      await retainThenRelease(wasm, seam, throws, tracked, `${round}/${throws}`);
    }
    const samples = await releasedCount(wasm, initial.count, tracked, `${seam}/${round}`);
    diagnostic({ seam, phase: 'released', round, baseline: initial.count, samples, unfinalized: tracked.pending() });
  }
}
