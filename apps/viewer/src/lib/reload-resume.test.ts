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
  noteAutomaticReopen,
  noteStaleDeploymentLoadFailure,
  persistResumeIntent,
  reloadKeepingOpenModels,
  setOpenModelsSource,
  takeResumeIntent,
  beginResumableLoad,
  type OpenModelSnapshot,
  type ResumeIntent,
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
function openLocal(id: string, name: string, loadState = 'complete', body = 'ISO-10303-21;'): File {
  const file = new File([body], name);
  markLocalModelFiles([file]);
  models.set(id, { sourceFile: file, loadState });
  return file;
}

const names = (intent: ResumeIntent | null) => intent?.files.map((f) => f.name);

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
    assert.deepEqual(reloadAndTake(), { files: [{ name: 'tower.ifc', size: 13 }, { name: 'structure.ifc', size: 13 }], reopen: true, trigger: 'automatic' });
    // One-shot: a second boot (another reload) must not reopen again.
    assert.equal(takeResumeIntent(deps()), null);
  });

  it('does not bring back a model the user closed before the reload', () => {
    // The review repro: load a model, add a second, remove the second, stale reload.
    openLocal('a', 'hello-wall.ifc');
    openLocal('b', 'second.ifc');
    models.delete('b'); // removeModel
    assert.deepEqual(names(reloadAndTake()), ['hello-wall.ifc']);
  });

  it('does not bring back a load that failed for its own reasons, but does resume a stale-deployment failure', () => {
    openLocal('a', 'broken.ifc', 'error');
    const stale = openLocal('b', 'stranded.ifc', 'error');
    noteStaleDeploymentLoadFailure(stale);
    assert.deepEqual(names(reloadAndTake()), ['stranded.ifc']);
  });

  it('a fresh federation after clearAllModels carries only the new models', () => {
    openLocal('a', 'old.ifc');
    models.clear(); // clearAllModels() before a multi-file open on an empty viewer
    openLocal('b', 'arch.ifc');
    openLocal('c', 'mep.ifc');
    assert.deepEqual(names(reloadAndTake()), ['arch.ifc', 'mep.ifc']);
  });

  it('never carries a model that did not come from a local file (?model= URL, cloud source)', () => {
    models.set('url', { sourceFile: new File(['x'], 'model.ifc'), loadState: 'complete' });
    models.set('blank', { loadState: 'complete' });
    persistResumeIntent('automatic', deps());
    assert.equal(takeResumeIntent(deps()), null, 'nothing local, nothing stored');
    openLocal('a', 'tower.ifc');
    assert.deepEqual(names(reloadAndTake()), ['tower.ifc']);
  });

  it('carries two federated files that share a name as two entries, told apart by size', () => {
    openLocal('a', 'model.ifc', 'complete', 'ISO-10303-21; site A');
    openLocal('b', 'model.ifc', 'complete', 'ISO-10303-21; site B, longer');
    assert.deepEqual(reloadAndTake()?.files, [{ name: 'model.ifc', size: 20 }, { name: 'model.ifc', size: 28 }]);
  });

  it('carries a federated add still in flight (no model yet), and nothing once it settles', () => {
    openLocal('a', 'arch.ifc');
    const mep = new File(['x'], 'mep.ifc');
    markLocalModelFiles([mep]);
    const settle = beginResumableLoad(mep);
    assert.deepEqual(names(reloadAndTake()), ['arch.ifc', 'mep.ifc']);
    settle();
    assert.deepEqual(names(reloadAndTake('user')), ['arch.ifc'], 'a load that settled without a model leaves nothing');
  });

  it('a federated add killed by the stale deployment is not carried after a fresh federation replaced the set', () => {
    openLocal('a', 'arch.ifc');
    const mep = new File(['x'], 'mep.ifc');
    markLocalModelFiles([mep]);
    const settle = beginResumableLoad(mep);
    noteStaleDeploymentLoadFailure(mep);
    settle();
    // routeLoad's fresh-federation branch: resetViewerState + clearAllModels + loadFilesSequentially.
    models.clear();
    openLocal('x', 'site.ifc');
    openLocal('y', 'roads.ifc');
    assert.deepEqual(names(reloadAndTake('user')), ['site.ifc', 'roads.ifc']);
  });

  it('a stranded add that was retried, loaded and then closed does not come back', () => {
    openLocal('a', 'arch.ifc');
    const mep = new File(['x'], 'mep.ifc');
    markLocalModelFiles([mep]);
    const first = beginResumableLoad(mep);
    noteStaleDeploymentLoadFailure(mep);
    first();
    const retry = beginResumableLoad(mep); // the user retries the same file
    models.set('b', { sourceFile: mep, loadState: 'complete' });
    retry();
    assert.deepEqual(names(reloadAndTake('user')), ['arch.ifc', 'mep.ifc'], 'loaded: carried');
    models.delete('b'); // removeModel
    assert.deepEqual(names(reloadAndTake('user')), ['arch.ifc'], 'closed: gone');
  });

  it('two stale-failed re-picks of one file are not carried twice, nor at all once settled (#6721 review repro 1)', () => {
    openLocal('a', 'tower.ifc');
    const picks = [new File(['x'], 'mep.ifc'), new File(['x'], 'mep.ifc')]; // each pick is a new File
    markLocalModelFiles(picks);
    const settleFirst = beginResumableLoad(picks[0]);
    noteStaleDeploymentLoadFailure(picks[0]);
    const settleSecond = beginResumableLoad(picks[1]); // re-picked while the first is still settling
    assert.deepEqual(names(reloadAndTake('user')), ['tower.ifc', 'mep.ifc'], 'in flight twice, named once');
    settleFirst();
    noteStaleDeploymentLoadFailure(picks[1]);
    settleSecond();
    assert.deepEqual(names(reloadAndTake('user')), ['tower.ifc']);
  });

  it('a stale-failed add that later loads and is removed does not come back (#6721 review repro 2)', () => {
    openLocal('a', 'tower.ifc');
    const first = new File(['x'], 'mep.ifc');
    const second = new File(['x'], 'mep.ifc');
    markLocalModelFiles([first, second]);
    const settleFirst = beginResumableLoad(first);
    noteStaleDeploymentLoadFailure(first);
    settleFirst();
    const settleSecond = beginResumableLoad(second);
    models.set('m', { sourceFile: second, loadState: 'complete' });
    settleSecond();
    openLocal('s', 'struct.ifc');
    models.delete('m'); // removeModel
    assert.deepEqual(names(reloadAndTake('user')), ['tower.ifc', 'struct.ifc']);
  });

  it('two loaded models with the same name and size are both carried', () => {
    openLocal('a', 'model.ifc');
    openLocal('b', 'model.ifc');
    assert.deepEqual(names(reloadAndTake('user')), ['model.ifc', 'model.ifc']);
  });

  it('a successful load leaves no in-flight entry behind', () => {
    const tower = new File(['x'], 'tower.ifc');
    markLocalModelFiles([tower]);
    const settle = beginResumableLoad(tower);
    models.set('t', { sourceFile: tower, loadState: 'complete' });
    settle();
    models.clear(); // clearAllModels
    persistResumeIntent('user', deps());
    assert.equal(takeResumeIntent(deps()), null);
  });

  it('never carries an in-flight load that is not a local file', () => {
    beginResumableLoad(new File(['x'], 'model.ifc'));
    persistResumeIntent('automatic', deps());
    assert.equal(takeResumeIntent(deps()), null);
  });

  it('stores every open local model past the auto-reopen cap (#6721 review)', () => {
    const all = ['a.ifc', 'b.ifc', 'c.ifc', 'd.ifc', 'e.ifc', 'f.ifc', 'g.ifc'];
    all.forEach((name, i) => openLocal(String(i), name));
    assert.deepEqual(names(reloadAndTake()), all);
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
    noteAutomaticReopen(clock); // the boot reopened it from the cache
    // The reopened load fails slowly enough to outlast the reload debounce and
    // reloads automatically again: this time the boot must ask, not reload-loop.
    clock += 90_000;
    assert.deepEqual(reloadAndTake(), { files: [{ name: 'huge.ifc', size: 13 }], reopen: false, trigger: 'automatic' });
  });

  it('a boot that only prompted does not arm the loop guard (CodeRabbit review)', () => {
    openLocal('a', 'tower.ifc');
    assert.equal(reloadAndTake()?.reopen, true); // ...but nothing was cached, so nothing reopened
    clock += 90_000;
    assert.equal(reloadAndTake()?.reopen, true, 'the next automatic reload still reopens');
  });

  it('records which trigger caused the reload', () => {
    openLocal('a', 'tower.ifc');
    assert.equal(reloadAndTake('user')?.trigger, 'user');
    assert.equal(reloadAndTake('automatic')?.trigger, 'automatic');
  });

  it('a later deployment, after the cooldown, reopens automatically again', () => {
    openLocal('a', 'tower.ifc');
    assert.equal(reloadAndTake()?.reopen, true);
    noteAutomaticReopen(clock);
    clock += AUTO_REOPEN_COOLDOWN_MS + 1;
    assert.equal(reloadAndTake()?.reopen, true);
  });

  it('a reload the user clicked always reopens, even right after an automatic reopen', () => {
    openLocal('a', 'tower.ifc');
    reloadAndTake();
    noteAutomaticReopen(clock);
    assert.equal(reloadAndTake('user')?.reopen, true);
  });

  it('reloadKeepingOpenModels reloads even when nothing is open', () => {
    let reloads = 0;
    reloadKeepingOpenModels('user', () => { reloads += 1; });
    assert.equal(reloads, 1);
  });
});
