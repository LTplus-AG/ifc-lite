/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7955: the kernel choice is explicit; Settings persists it per browser, `?kernel=` overrides per tab. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseGeometryKernel,
  GEOMETRY_KERNEL_SESSION_KEY,
  GEOMETRY_KERNEL_SETTING_KEY,
  requestedGeometryKernel,
  saveGeometryKernel,
  savedGeometryKernel,
} from './geometryKernel';

/** A Storage stand-in: a fresh one is a new tab (session) or a new browser profile (local). */
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  history.replaceState(null, '', '/');
});

describe('#7955 geometry kernel choice', () => {
  it('defaults to exact; ?kernel= selects and is remembered for the tab', () => {
    const tab = memoryStorage(), browser = memoryStorage();
    assert.equal(requestedGeometryKernel('', tab, browser), 'exact');
    assert.equal(requestedGeometryKernel('?kernel=retained', tab, browser), 'retained');
    assert.equal(requestedGeometryKernel('', tab, browser), 'retained', 'the same tab keeps it for the next load');
    assert.equal(requestedGeometryKernel('', memoryStorage(), browser), 'exact', 'a new tab without a saved choice is exact');
    assert.equal(browser.values.size, 0, '?kernel= never changes the saved setting');
    assert.equal(requestedGeometryKernel('?kernel=exact', tab, browser), 'exact');
  });

  it('ignores unknown values like any unknown parameter', () => {
    const tab = memoryStorage(), browser = memoryStorage();
    assert.equal(requestedGeometryKernel('?kernel=fast', tab, browser), 'exact');
    assert.equal(tab.values.size, 0);
    browser.values.set(GEOMETRY_KERNEL_SETTING_KEY, 'fast');
    assert.equal(requestedGeometryKernel('', tab, browser), 'exact', 'a damaged saved value reads as exact');
  });

  it('the Settings choice persists per browser and applies to every new tab', () => {
    saveGeometryKernel('retained');
    assert.equal(localStorage.getItem(GEOMETRY_KERNEL_SETTING_KEY), 'retained');
    assert.equal(savedGeometryKernel(), 'retained');
    assert.equal(requestedGeometryKernel(), 'retained');
    sessionStorage.clear(); // a new tab of the same browser
    assert.equal(requestedGeometryKernel(), 'retained');
    saveGeometryKernel('exact');
    assert.equal(localStorage.getItem(GEOMETRY_KERNEL_SETTING_KEY), null, 'exact is the default, so nothing stays saved');
    assert.equal(requestedGeometryKernel(), 'exact');
  });

  it('?kernel= overrides the saved choice for the tab, both ways', () => {
    saveGeometryKernel('retained');
    assert.equal(requestedGeometryKernel('?kernel=exact'), 'exact');
    assert.equal(requestedGeometryKernel(''), 'exact', 'the tab override outlives the parameter');
    assert.equal(savedGeometryKernel(), 'retained', 'the saved choice is untouched');
    sessionStorage.clear();
    saveGeometryKernel('exact');
    assert.equal(requestedGeometryKernel('?kernel=retained'), 'retained');
  });

  it('an exact retry switches only this tab; saving replaces a tab override', () => {
    saveGeometryKernel('retained');
    chooseGeometryKernel('exact');
    assert.equal(sessionStorage.getItem(GEOMETRY_KERNEL_SESSION_KEY), 'exact');
    assert.equal(requestedGeometryKernel(''), 'exact');
    assert.equal(savedGeometryKernel(), 'retained');
    saveGeometryKernel('retained');
    assert.equal(sessionStorage.getItem(GEOMETRY_KERNEL_SESSION_KEY), null);
    assert.equal(requestedGeometryKernel(''), 'retained');
  });

  it('a choice rewrites a stale ?kernel= so it cannot override the next load', () => {
    history.replaceState(null, '', '/?kernel=retained&other=keep');
    chooseGeometryKernel('exact');
    assert.equal(location.search, '?kernel=exact&other=keep');
    assert.equal(requestedGeometryKernel(), 'exact');
    saveGeometryKernel('retained');
    assert.equal(location.search, '?kernel=retained&other=keep');
    assert.equal(requestedGeometryKernel(), 'retained');
  });

  it('denied storage reads as exact and never throws', () => {
    const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
    assert.equal(requestedGeometryKernel('', denied, denied), 'exact');
    assert.equal(requestedGeometryKernel('?kernel=retained', denied, denied), 'retained');
    assert.doesNotThrow(() => saveGeometryKernel('retained', denied, denied));
  });
});
