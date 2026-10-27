/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';

export const emptyLineageSidecar = () => ({ format: 'ifc-lite/lineage', version: 1,
  base: { hash: 'old' }, head: { hash: 'new' }, entries: [], deleted: [] });

// #8042: own every admits this object key in accepted main. The retained
// filter predicate must keep its original Set, including the key's identity.
// No Number/Set/prototype methods are replaced to reach this input.
export function deletedFilterObservation(run, throws, sentinel) {
  const trace = [];
  const deleted = ['gone'];
  const other = ['gone'];
  const base = [deleted];
  const entry = { base, head: ['h'], relation: 'identity', reason: '' };
  const value = { ...emptyLineageSidecar(), entries: [entry], deleted };
  const poison = { [Symbol.toPrimitive]() { throw sentinel; } };
  let captures = 0;
  base.every = function () { trace.push(['base.every', this === base]); return true; };

  function check(callback, phase) {
    const observed = [callback(deleted), callback(other), callback('gone'), callback(poison)];
    assert.deepEqual(observed, [true, false, false, false], `${phase}: Set membership by identity`);
    trace.push([phase, ...observed]);
  }
  function nested(callback, phase, fails = false) {
    const nestedValue = emptyLineageSidecar();
    nestedValue.deleted.filter = function (inner) {
      // Invoke the retained callback while a second validation is active.
      trace.push([phase, callback(deleted), inner(deleted)]);
      assert.equal(callback(deleted), true);
      assert.equal(inner(deleted), false, 'nested validation has a separate empty Set');
      if (fails) throw sentinel;
      return [];
    };
    if (fails) assert.throws(() => run(nestedValue), error => error === sentinel);
    else assert.deepEqual(run(nestedValue), []);
  }
  Object.defineProperty(deleted, 'filter', { configurable: true, get() {
    trace.push(['filter.get', this === deleted]);
    return function (callback) {
      assert.equal(++captures, 1);
      trace.push(['filter.call', this === deleted, arguments.length]);
      this.saved = callback;
      check(callback, 'active');
      nested(callback, 'active.reentry');
      if (throws) throw sentinel;
      return [];
    };
  } });
  if (throws) assert.throws(() => run(value), error => error === sentinel, 'method throw identity');
  else assert.deepEqual(run(value), []);
  assert.equal(captures, 1, 'required custom deleted.filter invocation');
  const retained = deleted.saved;
  assert.equal(typeof retained, 'function');
  check(retained, 'retained');
  // Membership is the Set snapshot, not a later read or structural equality.
  entry.base = [other];
  deleted[0] = 'changed';
  check(deleted.saved, 'mutated');
  nested(retained, 'later.reentry');
  nested(retained, 'later.throw', true);
  check(retained, 'recovered');
  assert.deepEqual(run(emptyLineageSidecar()), [], 'same-module reuse after throw/reentry');
  return { value: [], trace };
}
