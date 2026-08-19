/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The real entrypoint must ARM the blob sweep (#2790).
 *
 * Unit-testing `startBlobGc` proves the worker works, not that anything calls
 * it, and #2790 happened precisely because a needed sweep ran nowhere. So this
 * spawns `bin.ts` as an actual process against a temp data dir and asserts a
 * real orphaned blob is deleted from disk. Nothing is asserted about the
 * source text: if the wiring is removed, the blob simply survives.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { geometryMap } from '@ifc-lite/collab';
import { FilePersistence } from '../src/persistence.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, '..');
const repoRoot = path.join(pkgRoot, '..', '..');
const tsx = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

const REFERENCED = 'a'.repeat(32);
const ORPHAN = 'b'.repeat(32);

let child: ChildProcess | null = null;
let dataDir = '';

afterEach(() => {
  child?.kill('SIGKILL');
  child = null;
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('blob gc entrypoint', () => {
  it('the shipped entrypoint sweeps an orphaned blob off disk', async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-bin-'));
    const blobsDir = path.join(dataDir, 'blobs');
    fs.mkdirSync(blobsDir, { recursive: true });

    // A room that references one blob, so the sweep has a real reference set
    // and its zero-room-logs backstop does not fire.
    const doc = new Y.Doc();
    doc.transact(() => {
      geometryMap(doc).set('g0', new Y.Map<unknown>());
      (geometryMap(doc).get('g0') as Y.Map<unknown>).set('blobHash', REFERENCED);
    });
    await new FilePersistence({ dataDir }).append('room-1', Y.encodeStateAsUpdate(doc));
    doc.destroy();

    for (const h of [REFERENCED, ORPHAN]) {
      const f = path.join(blobsDir, h);
      fs.writeFileSync(f, Buffer.from([1, 2, 3]));
      const old = (Date.now() - 7 * 24 * 3600_000) / 1000;
      fs.utimesSync(f, old, old);
    }

    child = spawn(tsx, [path.join(pkgRoot, 'src', 'bin.ts')], {
      env: {
        ...process.env,
        // Pin the feature flag rather than inheriting it. A developer or CI
        // runner with COLLAB_BLOB_GC=0 set would otherwise turn this test into
        // a check that the sweep does nothing, which is the opposite of what
        // it asserts. It fails safe today, but a test whose meaning depends on
        // the ambient environment is not a test.
        COLLAB_BLOB_GC: '1',
        COLLAB_HOST: '127.0.0.1',
        COLLAB_PORT: '0',
        COLLAB_DATA_DIR: dataDir,
        COLLAB_BLOB_GC_INTERVAL_MS: '300',
        // Must clear MIN_BLOB_GC_GRACE_MS: a zero/near-zero grace is the
        // destructive value, so the entrypoint now refuses to start on one.
        COLLAB_BLOB_GC_GRACE_MS: '60000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (d) => (output += String(d)));
    child.stderr?.on('data', (d) => (output += String(d)));

    const orphanPath = path.join(blobsDir, ORPHAN);
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && fs.existsSync(orphanPath)) {
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(
      fs.existsSync(orphanPath),
      `orphaned blob was never swept, so the entrypoint did not arm the GC.\nProcess output:\n${output.slice(0, 1200)}`,
    ).toBe(false);
    expect(
      fs.existsSync(path.join(blobsDir, REFERENCED)),
      'the sweep deleted a REFERENCED blob',
    ).toBe(true);
  }, 40_000);
});
