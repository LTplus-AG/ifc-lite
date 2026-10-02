/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A stale-deployment reload (a tab older than its build's Skew Protection
 * window loses its geometry worker script, "worker script failed to load
 * (possibly a stale deployment)") used to drop the model the user had just
 * opened. These pin WHAT is carried (the local models the viewer holds at
 * reload time, #6721 review) and the loop guard.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_REOPEN_COOLDOWN_MS,
  __resetReloadResumeForTests,
  markLocalModelFiles,
  noteStaleDeploymentLoadFailure,
  persistResumeIntent,
  reloadKeepingOpenModels,
  setOpenModelsSource,
  takeResumeIntent,
  type OpenModelSnapshot,
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
/** Stand-in for `useViewerStore.getState().models`, keyed by model id. */
let models: Map<string, OpenModelSnapshot>;
const deps = (): PersistDeps => ({ now: () => clock, storage });

/** A file the user opened from disk, loaded into the viewer as `id`. */
function openLocal(id: string, name: string, loadState = 'complete'): File {
  const file = new File(['ISO-10303-21;'], name);
  markLocalModelFiles([file]);
  models.set(id, { sourceFile: file, loadState });
  return file;
}

function reloadAndTake(trigger: 'automatic' | 'user' = 'automatic') {
  persistResumeIntent(trigger, deps());
  clock += 1_500;
  return takeResumeIntent(deps());
}

beforeEach(() => {
  __resetReloadResumeForTests();
  clock = 1_000_000;
  storage = new MemoryStorage();
  models = new Map();
  setOpenModelsSource(() => models.values());
});

describe('reload resume', () => {
  it('carries the open local models across one reload, then forgets them', () => {
    openLocal('a', 'tower.ifc');
    openLocal('b', 'structure.ifc', 'streaming-geometry'); // mid-load is the main case
    assert.deepEqual(reloadAndTake(), { files: ['tower.ifc', 'structure.ifc'], reopen: true });
    // One-shot: a second boot (another reload) must not reopen again.
    assert.equal(takeResumeIntent(deps()), null);
  });

  it('does not bring back a model the user closed before the reload', () => {
    // The review repro: load a model, add a second, remove the second, stale reload.
    openLocal('a', 'hello-wall.ifc');
    openLocal('b', 'second.ifc');
    models.delete('b'); // removeModel
    assert.deepEqual(reloadAndTake()?.files, ['hello-wall.ifc']);
  });

  it('does not bring back a load that failed for its own reasons, but does resume a stale-deployment failure', () => {
    openLocal('a', 'broken.ifc', 'error');
    const stale = openLocal('b', 'stranded.ifc', 'error');
    noteStaleDeploymentLoadFailure(stale);
    assert.deepEqual(reloadAndTake()?.files, ['stranded.ifc']);
  });

  it('a fresh federation after clearAllModels carries only the new models', () => {
    openLocal('a', 'old.ifc');
    models.clear(); // clearAllModels() before a multi-file open on an empty viewer
    openLocal('b', 'arch.ifc');
    openLocal('c', 'mep.ifc');
    assert.deepEqual(reloadAndTake()?.files, ['arch.ifc', 'mep.ifc']);
  });

  it('never carries a model that did not come from a local file (?model= URL, cloud source)', () => {
    models.set('url', { sourceFile: new File(['x'], 'model.ifc'), loadState: 'complete' });
    models.set('blank', { loadState: 'complete' });
    persistResumeIntent('automatic', deps());
    assert.equal(takeResumeIntent(deps()), null, 'nothing local, nothing stored');
    openLocal('a', 'tower.ifc');
    assert.deepEqual(reloadAndTake()?.files, ['tower.ifc']);
  });

  it('ignores an intent older than two minutes or stamped in the future', () => {
    openLocal('a', 'tower.ifc');
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

  it('loop guard: an automatic reload soon after an automatic reopen only prompts', () => {
    openLocal('a', 'huge.ifc');
    assert.equal(reloadAndTake()?.reopen, true);
    // The reopened load fails slowly enough to outlast the reload debounce and
    // reloads automatically again: this time the boot must ask, not reload-loop.
    clock += 90_000;
    assert.deepEqual(reloadAndTake(), { files: ['huge.ifc'], reopen: false });
  });

  it('a later deployment, after the cooldown, reopens automatically again', () => {
    openLocal('a', 'tower.ifc');
    assert.equal(reloadAndTake()?.reopen, true);
    clock += AUTO_REOPEN_COOLDOWN_MS + 1;
    assert.equal(reloadAndTake()?.reopen, true);
  });

  it('a reload the user clicked always reopens, even right after an automatic reopen', () => {
    openLocal('a', 'tower.ifc');
    reloadAndTake();
    assert.equal(reloadAndTake('user')?.reopen, true);
  });

  it('reloadKeepingOpenModels reloads even when nothing is open', () => {
    let reloads = 0;
    reloadKeepingOpenModels('user', () => { reloads += 1; });
    assert.equal(reloads, 1);
  });
});
