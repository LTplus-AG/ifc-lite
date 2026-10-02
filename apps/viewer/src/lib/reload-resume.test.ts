/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A stale-deployment reload (a tab older than its build's Skew Protection
 * window loses its geometry worker script, "worker script failed to load
 * (possibly a stale deployment)") used to drop the model the user had just
 * opened. These pin the carry-over and its loop guard.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetReloadResumeForTests,
  noteModelLoadIntent,
  persistResumeIntent,
  reloadKeepingOpenModels,
  setOpenModelsProbe,
  takeResumeIntent,
  type PersistDeps,
} from './reload-resume.js';

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string): string | null { return this.items.get(key) ?? null; }
  setItem(key: string, value: string): void { this.items.set(key, value); }
  removeItem(key: string): void { this.items.delete(key); }
}

let clock = 1_000_000;
let storage: MemoryStorage;
const deps = (): PersistDeps => ({ now: () => clock, storage });

beforeEach(() => {
  __resetReloadResumeForTests();
  clock = 1_000_000;
  storage = new MemoryStorage();
});

describe('reload resume', () => {
  it('carries the open models across one reload, then forgets them', () => {
    noteModelLoadIntent('tower.ifc', 'primary');
    noteModelLoadIntent('structure.ifc', 'federated');
    persistResumeIntent('automatic', deps());
    clock += 1_500;
    assert.deepEqual(takeResumeIntent(deps()), { files: ['tower.ifc', 'structure.ifc'], reopen: true });
    // One-shot: a second boot (another reload) must not reopen again.
    assert.equal(takeResumeIntent(deps()), null);
  });

  it('a primary load replaces the set; a repeated federated add is not duplicated', () => {
    noteModelLoadIntent('old.ifc', 'primary');
    noteModelLoadIntent('new.ifc', 'primary');
    noteModelLoadIntent('mep.ifc', 'federated');
    noteModelLoadIntent('mep.ifc', 'federated');
    persistResumeIntent('user', deps());
    assert.deepEqual(takeResumeIntent(deps())?.files, ['new.ifc', 'mep.ifc']);
  });

  it('persists nothing when no model was opened, or every model was closed since', () => {
    persistResumeIntent('automatic', deps());
    assert.equal(takeResumeIntent(deps()), null);

    noteModelLoadIntent('tower.ifc', 'primary');
    setOpenModelsProbe(() => false);
    persistResumeIntent('automatic', deps());
    assert.equal(takeResumeIntent(deps()), null);
  });

  it('ignores an intent older than two minutes or stamped in the future', () => {
    noteModelLoadIntent('tower.ifc', 'primary');
    persistResumeIntent('automatic', deps());
    clock += 2 * 60_000 + 1;
    assert.equal(takeResumeIntent(deps()), null);

    persistResumeIntent('automatic', deps());
    clock -= 10_000;
    assert.equal(takeResumeIntent(deps()), null);
  });

  it('rejects a corrupt stored value instead of throwing during boot', () => {
    storage.setItem('ifclite:reload-resume', '{"files":"tower.ifc","at":1000000,"reopen":true}');
    assert.equal(takeResumeIntent(deps()), null);
    storage.setItem('ifclite:reload-resume', 'not json');
    assert.equal(takeResumeIntent(deps()), null);
  });

  it('loop guard: an automatic reload from an automatically reopened page only prompts', () => {
    // Boot 1: the reopen happened automatically.
    noteModelLoadIntent('huge.ifc', 'primary');
    persistResumeIntent('automatic', deps());
    assert.equal(takeResumeIntent(deps())?.reopen, true);
    // The reopened load fails slowly enough to outlast the reload debounce and
    // reloads automatically again: this time the boot must ask, not reload-loop.
    noteModelLoadIntent('huge.ifc', 'primary');
    persistResumeIntent('automatic', deps());
    assert.deepEqual(takeResumeIntent(deps()), { files: ['huge.ifc'], reopen: false });
  });

  it('a reload the user clicked always reopens, even after an automatic reopen', () => {
    noteModelLoadIntent('tower.ifc', 'primary');
    persistResumeIntent('automatic', deps());
    takeResumeIntent(deps());
    persistResumeIntent('user', deps());
    assert.equal(takeResumeIntent(deps())?.reopen, true);
  });

  it('reloadKeepingOpenModels reloads even when nothing is open', () => {
    let reloads = 0;
    reloadKeepingOpenModels('user', () => { reloads += 1; });
    assert.equal(reloads, 1);
  });
});
