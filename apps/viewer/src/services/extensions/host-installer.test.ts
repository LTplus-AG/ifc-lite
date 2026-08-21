/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `installFromBytes` rollback: a loader rejection must leave the previously
 * installed extension exactly as it was. The bundle bytes are keyed by
 * `id + version`, so a reinstall of the *same* version overwrites them —
 * which is precisely the case where the rollback needs a snapshot taken
 * before the write.
 */

// fake-indexeddb backs the real IdbExtensionStorage the installer writes to.
import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  buildBundleFromFiles,
  packBundle,
  type Bundle,
  type BundleFile,
  type ExtensionLoader,
  type InstalledExtensionRecord,
  type LoadedExtensionStatus,
} from '@ifc-lite/extensions';
import { IdbExtensionStorage } from './idb-storage.js';
import { installFromBytes, uninstall, type InstallerDeps } from './host-installer.js';

const EXT_ID = 'com.example.rollback';

function file(path: string, text: string): BundleFile {
  return { path, bytes: new TextEncoder().encode(text), text };
}

/** A minimal but valid bundle whose activate source carries `marker`. */
function bundleBytes(version: string, marker: string): Uint8Array {
  const manifest = {
    manifestVersion: 1,
    id: EXT_ID,
    name: 'Rollback Fixture',
    description: 'Bundle used by the installer rollback tests.',
    version,
    engines: { ifcLiteSdk: '>=2.0.0' },
    capabilities: ['model.read'],
    activation: ['onStartup'],
    contributes: {},
    entry: { activate: 'src/activate.js' },
  };
  const manifestFile = file('manifest.json', JSON.stringify(manifest));
  const activate = file(
    'src/activate.js',
    `export function activate() { return ${JSON.stringify(marker)}; }`,
  );
  const files = new Map<string, BundleFile>([
    ['manifest.json', manifestFile],
    ['src/activate.js', activate],
  ]);
  const built = buildBundleFromFiles(files, manifestFile, { kind: 'memory' });
  if (!built.ok) {
    throw new Error(`fixture bundle did not build: ${built.errors[0]?.message ?? 'unknown'}`);
  }
  return packBundle(built.value as Bundle);
}

interface Recorder {
  deps: InstallerDeps;
  storage: IdbExtensionStorage;
  loadResults: (LoadedExtensionStatus | undefined)[];
  /** Teardowns of the running extension, counted at `loader.unload`. */
  teardowns: { count: number };
}

/**
 * Installer deps over the real IDB-backed storage, with the loader's verdict
 * scripted per call and the runtime / dispatcher reduced to no-ops.
 */
function makeDeps(loadResults: (LoadedExtensionStatus | undefined)[]): Recorder {
  const storage = new IdbExtensionStorage();
  const teardowns = { count: 0 };
  const loader = {
    load: () => Promise.resolve(loadResults.shift()),
    unload: () => {
      teardowns.count += 1;
      return Promise.resolve();
    },
    getBundle: () => undefined,
  } as unknown as ExtensionLoader;
  const deps = {
    storage,
    loader,
    runtime: {
      deactivate: () => Promise.resolve(),
      deactivateWithBundle: () => Promise.resolve(),
    },
    dispatcher: { fire: () => Promise.resolve(), resetActivation: () => {} },
    audit: { append: () => {} },
    emitAction: () => {},
    emit: () => {},
  } as unknown as InstallerDeps;
  return { deps, storage, loadResults, teardowns };
}

function okStatus(): LoadedExtensionStatus {
  return { id: EXT_ID, ok: true, errors: [] } as unknown as LoadedExtensionStatus;
}

function failStatus(): LoadedExtensionStatus {
  return { id: EXT_ID, ok: false, errors: [] } as unknown as LoadedExtensionStatus;
}

async function installedState(
  storage: IdbExtensionStorage,
  version: string,
): Promise<{ record: InstalledExtensionRecord | undefined; bytes: Uint8Array | undefined }> {
  return {
    record: await storage.getExtension(EXT_ID),
    bytes: await storage.getBundle(EXT_ID, version),
  };
}

describe('installFromBytes rollback', () => {
  beforeEach(async () => {
    await new IdbExtensionStorage().clear();
  });

  it('restores the working install when a same-version reinstall is rejected', async () => {
    const good = bundleBytes('1.0.0', 'original');
    const bad = bundleBytes('1.0.0', 'replacement');
    assert.notDeepEqual(
      Array.from(bad),
      Array.from(good),
      'the fixture must actually change the stored bytes',
    );

    const first = makeDeps([okStatus()]);
    await installFromBytes(first.deps, good, ['model.read']);
    const before = await installedState(first.storage, '1.0.0');
    assert.ok(before.record, 'the first install landed');
    assert.ok(before.bytes, 'the first install stored its bundle');

    const second = makeDeps([failStatus(), okStatus()]);
    await assert.rejects(
      () => installFromBytes(second.deps, bad, ['model.read']),
      /Loader rejected the new bundle/,
    );

    // Replacing the bytes under the version that is already loaded is not a
    // version change: the running extension is left alone.
    assert.equal(second.teardowns.count, 0, 'no teardown on a same-version reinstall');

    const after = await installedState(second.storage, '1.0.0');
    assert.deepEqual(after.record, before.record, 'the previous record is back');
    assert.ok(after.bytes, 'the previous bundle bytes are back');
    assert.deepEqual(Array.from(after.bytes), Array.from(before.bytes));
  });

  it('restores the working install when an upgrade is rejected', async () => {
    const good = bundleBytes('1.0.0', 'original');
    const bad = bundleBytes('2.0.0', 'upgrade');

    const first = makeDeps([okStatus()]);
    await installFromBytes(first.deps, good, ['model.read']);
    const before = await installedState(first.storage, '1.0.0');

    const second = makeDeps([failStatus(), okStatus()]);
    await assert.rejects(
      () => installFromBytes(second.deps, bad, ['model.read']),
      /Loader rejected the new bundle/,
    );

    assert.equal(second.teardowns.count, 1, 'the outgoing version is torn down');

    const after = await installedState(second.storage, '1.0.0');
    assert.deepEqual(after.record, before.record);
    assert.ok(after.bytes);
    assert.deepEqual(Array.from(after.bytes), Array.from(before.bytes!));
    assert.equal(
      await second.storage.getBundle(EXT_ID, '2.0.0'),
      undefined,
      'the rejected bundle is gone',
    );
  });

  it('leaves nothing behind when a first install is rejected', async () => {
    const bad = bundleBytes('1.0.0', 'first');
    const deps = makeDeps([failStatus()]);
    await assert.rejects(
      () => installFromBytes(deps.deps, bad, ['model.read']),
      /Loader rejected the new bundle/,
    );
    const after = await installedState(deps.storage, '1.0.0');
    assert.equal(after.record, undefined);
    assert.equal(after.bytes, undefined);
  });
});

/**
 * The record and the bundle bytes are two independent pieces of state. A
 * record can outlive its bytes — the loader has a dedicated
 * `invalid_reference` error for exactly that — and restoring the bytes can
 * fail on its own (a storage quota rejection). Neither may take the record
 * down with it: the record carries the capability grants, the enabled bit,
 * the install time and the source, none of which need bytes to be worth
 * keeping, and none of which the user asked to remove.
 */
describe('installFromBytes rollback keeps the record independent of the bytes', () => {
  beforeEach(async () => {
    await new IdbExtensionStorage().clear();
  });

  it('keeps the previous record when a same-version reinstall is rejected', async () => {
    const first = makeDeps([okStatus()]);
    await installFromBytes(first.deps, bundleBytes('1.0.0', 'original'), ['model.read']);
    const before = await installedState(first.storage, '1.0.0');
    assert.ok(before.record, 'the first install landed');

    // The bytes go missing behind the record's back.
    await first.storage.deleteBundle(EXT_ID, '1.0.0');

    const second = makeDeps([failStatus(), okStatus()]);
    await assert.rejects(
      () => installFromBytes(second.deps, bundleBytes('1.0.0', 'replacement'), ['model.read']),
      /Loader rejected the new bundle/,
    );

    const after = await installedState(second.storage, '1.0.0');
    assert.deepEqual(after.record, before.record, 'the previous record survives');
  });

  it('keeps the previous record when an upgrade is rejected', async () => {
    const first = makeDeps([okStatus()]);
    await installFromBytes(first.deps, bundleBytes('1.0.0', 'original'), ['model.read']);
    const before = await installedState(first.storage, '1.0.0');
    assert.ok(before.record, 'the first install landed');
    await first.storage.deleteBundle(EXT_ID, '1.0.0');

    const second = makeDeps([failStatus(), okStatus()]);
    await assert.rejects(
      () => installFromBytes(second.deps, bundleBytes('2.0.0', 'upgrade'), ['model.read']),
      /Loader rejected the new bundle/,
    );

    // The outgoing version is still torn down — that part is a version change.
    assert.equal(second.teardowns.count, 1, 'the outgoing version is torn down');
    const after = await installedState(second.storage, '1.0.0');
    assert.deepEqual(after.record, before.record, 'the previous record survives');
  });

  it('does not resurrect a record the user uninstalled while the install was loading', async () => {
    // Install v1, its bytes go missing behind the record's back, then a v2
    // install hangs in `load` and the user hits Uninstall before it comes
    // back. The uninstall is explicit and it wins: restoring `previous`
    // here would undo it and leave a listed-but-unloadable record behind.
    const first = makeDeps([okStatus()]);
    await installFromBytes(first.deps, bundleBytes('1.0.0', 'original'), ['model.read']);
    assert.ok(await first.storage.getExtension(EXT_ID), 'the first install landed');
    await first.storage.deleteBundle(EXT_ID, '1.0.0');

    const second = makeDeps([]);
    let uninstalledDuringLoad = false;
    (second.deps.loader as { load: (id: string) => Promise<LoadedExtensionStatus | undefined> })
      .load = async () => {
        if (uninstalledDuringLoad) return okStatus();
        uninstalledDuringLoad = true;
        // The user hits Uninstall while this load is still in flight.
        await uninstall(second.deps, EXT_ID);
        return failStatus();
      };

    await assert.rejects(
      () => installFromBytes(second.deps, bundleBytes('2.0.0', 'upgrade'), ['model.read']),
      /Loader rejected the new bundle/,
    );
    assert.ok(uninstalledDuringLoad, 'the uninstall actually ran mid-install');

    assert.equal(
      await second.storage.getExtension(EXT_ID),
      undefined,
      'the record the user uninstalled stays uninstalled',
    );
  });

  it('still rolls back when the record re-read fails', async () => {
    // The re-read that guards against an uninstall-mid-load proves nothing
    // when it fails, so it falls back to rolling back — what happens when
    // nobody touched storage, which is every case but the racing one.
    const first = makeDeps([okStatus()]);
    await installFromBytes(first.deps, bundleBytes('1.0.0', 'original'), ['model.read']);
    const before = await first.storage.getExtension(EXT_ID);
    assert.ok(before, 'the first install landed');

    const second = makeDeps([failStatus(), okStatus()]);
    const realGet = second.storage.getExtension.bind(second.storage);
    let reads = 0;
    second.storage.getExtension = (id: string) => {
      reads += 1;
      // The pre-install snapshot read succeeds; the rollback's re-read throws.
      return reads === 1 ? realGet(id) : Promise.reject(new Error('re-read blew up'));
    };

    await assert.rejects(
      () => installFromBytes(second.deps, bundleBytes('1.0.0', 'replacement'), ['model.read']),
      /Loader rejected the new bundle/,
    );
    assert.ok(reads > 1, 'the rollback actually attempted the re-read');

    const after = await new IdbExtensionStorage().getExtension(EXT_ID);
    assert.deepEqual(after, before, 'the previous record was still restored');
  });

  it('re-loads the restored record even when there were no bytes to restore', async () => {
    // The rollback's reload is not gated on the byte snapshot. With the bytes
    // gone it is the load that makes the loader report the record's real
    // state (`invalid_reference`) rather than leaving whatever it was running
    // in place, backed by a bundle no longer in storage. Gating it on
    // `previousBundleBytes` is otherwise silent — this is the test that
    // notices.
    const first = makeDeps([okStatus()]);
    await installFromBytes(first.deps, bundleBytes('1.0.0', 'original'), ['model.read']);
    assert.ok(await first.storage.getExtension(EXT_ID), 'the first install landed');
    await first.storage.deleteBundle(EXT_ID, '1.0.0');
    assert.equal(
      await first.storage.getBundle(EXT_ID, '1.0.0'),
      undefined,
      'there is no byte snapshot for the rollback to restore',
    );

    const second = makeDeps([]);
    const loadedIds: string[] = [];
    const verdicts = [failStatus(), okStatus()];
    (second.deps.loader as { load: (id: string) => Promise<LoadedExtensionStatus | undefined> })
      .load = (id: string) => {
      loadedIds.push(id);
      return Promise.resolve(verdicts.shift());
    };

    await assert.rejects(
      () => installFromBytes(second.deps, bundleBytes('1.0.0', 'replacement'), ['model.read']),
      /Loader rejected the new bundle/,
    );

    assert.deepEqual(
      loadedIds,
      [EXT_ID, EXT_ID],
      'the rollback re-loaded the restored record even with no bytes to restore',
    );
  });

  it('keeps the previous record when restoring its bytes fails', async () => {
    const first = makeDeps([okStatus()]);
    await installFromBytes(first.deps, bundleBytes('1.0.0', 'original'), ['model.read']);
    const before = await installedState(first.storage, '1.0.0');
    assert.ok(before.record, 'the first install landed');

    const second = makeDeps([failStatus(), okStatus()]);
    // Fail only the restore's `putBundle`, the way a quota rejection would.
    const realPutBundle = second.storage.putBundle.bind(second.storage);
    let bundleWrites = 0;
    second.storage.putBundle = (id: string, version: string, bytes: Uint8Array) => {
      bundleWrites += 1;
      if (bundleWrites > 1) return Promise.reject(new Error('QuotaExceeded during restore'));
      return realPutBundle(id, version, bytes);
    };

    await assert.rejects(
      () => installFromBytes(second.deps, bundleBytes('1.0.0', 'replacement'), ['model.read']),
      /Loader rejected the new bundle/,
    );
    assert.ok(bundleWrites > 1, 'the restore actually attempted a bundle write');

    const after = await installedState(second.storage, '1.0.0');
    assert.deepEqual(after.record, before.record, 'the previous record survives');
  });
});
