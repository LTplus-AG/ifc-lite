/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7955 M2-C: the kernel choice is explicit and session-only. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chooseGeometryKernel, GEOMETRY_KERNEL_SESSION_KEY, requestedGeometryKernel } from './geometryKernel';

/** A tab's sessionStorage: a fresh one is a new tab. */
function tabStorage(): Pick<Storage, 'getItem' | 'setItem'> & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  history.replaceState(null, '', '/');
});

describe('#7955 M2-C geometry kernel choice', () => {
  it('defaults to exact; ?kernel= selects and is remembered for the tab only', () => {
    const tab = tabStorage();
    assert.equal(requestedGeometryKernel('', tab), 'exact');
    assert.equal(requestedGeometryKernel('?kernel=retained', tab), 'retained');
    assert.equal(requestedGeometryKernel('', tab), 'retained', 'the same tab keeps it for the next load');
    assert.equal(requestedGeometryKernel('', tabStorage()), 'exact', 'a new tab is exact again');
    assert.equal(requestedGeometryKernel('?kernel=exact', tab), 'exact');
  });

  it('ignores unknown values like any unknown parameter', () => {
    const tab = tabStorage();
    assert.equal(requestedGeometryKernel('?kernel=fast', tab), 'exact');
    assert.equal(tab.values.size, 0);
  });

  it('never persists beyond the session', () => {
    history.replaceState(null, '', '/?kernel=retained');
    assert.equal(requestedGeometryKernel(), 'retained');
    assert.equal(sessionStorage.getItem(GEOMETRY_KERNEL_SESSION_KEY), 'retained');
    assert.equal(localStorage.length, 0);
  });

  it('a choice rewrites a stale ?kernel= so it cannot override the next load', () => {
    history.replaceState(null, '', '/?kernel=retained&other=keep');
    chooseGeometryKernel('exact');
    assert.equal(location.search, '?kernel=exact&other=keep');
    assert.equal(requestedGeometryKernel(), 'exact');
  });
});
