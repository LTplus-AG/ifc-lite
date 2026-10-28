/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';

const empty = () => ({ format: 'ifc-lite/lineage', version: 1,
  base: { hash: 'old' }, head: { hash: 'new' }, entries: [], deleted: [] });

// #8042/R141: accepted-main own every permits this object key. The former
// Rust Set capture can root Set -> deleted -> saved callback -> Rust closure.
// This input needs no Number, Set or prototype replacement.
function retainedDeletedFilterGraph(wasm, throws, tracked, label) {
  const sentinel = { failure: `${label}: deleted.filter` };
  const deleted = ['gone'];
  const other = ['gone'];
  const base = [deleted];
  base.every = () => true;
  const entry = { base, head: ['h'], relation: 'identity', reason: '' };
  const value = { ...empty(), entries: [entry], deleted };
  const run = input => wasm.diffValidateSidecarValue(input, true);
  const poison = { [Symbol.toPrimitive]() { throw sentinel; } };
  let captures = 0;
  function check(callback) {
    assert.equal(callback(deleted), true, 'same array key remains in captured Set');
    assert.equal(callback(other), false, 'structurally equal array is a distinct key');
    assert.equal(callback('gone'), false, 'array contents are not the Set key');
    assert.equal(callback(poison), false, 'Set.has must not coerce the key');
  }
  function nested(callback, fails = false) {
    const input = empty();
    input.deleted.filter = inner => {
      assert.equal(callback(deleted), true, 'retained callback during raw WASM reentry');
      assert.equal(inner(deleted), false, 'nested validation has its own empty Set');
      if (fails) throw sentinel;
      return [];
    };
    if (fails) assert.throws(() => run(input), error => error === sentinel, 'reentry throw identity');
    else assert.deepEqual(run(input), []);
  }
  deleted.filter = function (callback) {
    assert.equal(this, deleted, 'custom method receiver');
    assert.equal(arguments.length, 1);
    assert.equal(++captures, 1, 'one required deleted.filter capture per graph');
    this.saved = callback;
    check(callback);
    nested(callback);
    if (throws) throw sentinel;
    return [];
  };
  if (throws) assert.throws(() => run(value), error => error === sentinel, 'method throw identity');
  else assert.deepEqual(run(value), []);
  assert.equal(captures, 1, 'custom deleted.filter must actually run, never skip');
  const callback = deleted.saved;
  assert.equal(typeof callback, 'function');
  for (const [name, target] of Object.entries({ entry, base, value, deleted, callback })) {
    tracked.watch(`${label}/${name}`, target);
  }
  return { callback, keyRef: new WeakRef(deleted), later() {
    check(deleted.saved);
    value.entries[0].base = [other];
    deleted[0] = 'changed';
    check(callback); // The callback retains the original membership snapshot.
    nested(callback);
    nested(callback, true);
    check(callback);
    assert.deepEqual(run(empty()), [], 'immediate same-module recovery');
    // Preserve the original graph, including its saved callback, for release.
    // Never break the cycle to manufacture finalization or baseline return.
    entry.base = base;
    deleted[0] = 'gone';
    check(deleted.saved);
  } };
}

function callbackOnly(callback, keyRef) {
  const key = keyRef.deref();
  assert.ok(Array.isArray(key), 'callback alone keeps its JS Set/key context alive');
  assert.equal(callback(key), true, 'identity membership survives callback-only real GC');
  assert.equal(callback(['gone']), false);
  assert.equal(callback('gone'), false);
}

export async function retainDeletedFilterThenRelease(wasm, throws, tracked, label, gcTurn) {
  let graph = retainedDeletedFilterGraph(wasm, throws, tracked, label);
  for (let i = 0; i < 3; i++) await gcTurn();
  tracked.assertRetained(label);
  graph.later();
  let callback = graph.callback;
  let keyRef = graph.keyRef; // Weak bookkeeping cannot supply strong context.
  graph = null;
  for (let i = 0; i < 3; i++) await gcTurn();
  tracked.assertRetained(label, true);
  callbackOnly(callback, keyRef);
  // All strong external aliases leave before the shared warmed/exact-baseline
  // release loop. It requires every target finalized and no owned-handle gain.
  callback = null;
  keyRef = null;
}
