// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertWorkspaceCompiled, refreshSourceMtimes } from './lib/retained-default-identity.mjs';

test('#7955 rejects cached-only and partially compiled arms, naming the arm', () => {
  for (const arm of ['arm 1', 'arm 2']) {
    assert.throws(() => assertWorkspaceCompiled('Finished release in 0.36s', arm), { message: new RegExp(`${arm} did not compile workspace crates`) });
    assert.throws(() => assertWorkspaceCompiled('   Compiling unrelated v1.0\n   Compiling ifc-lite-core v1.0', arm), /ifc-lite-geometry/);
  }
});

test('#7955 accepts arms that compiled every required workspace crate', () => {
  const log = ['core', 'geometry', 'processing', 'wasm'].map(name => `   Compiling ifc-lite-${name} v1.0 (/source/rust/${name})`).join('\n');
  for (const arm of ['arm 1', 'arm 2']) assert.doesNotThrow(() => assertWorkspaceCompiled(log, arm));
});

test('#7955 refreshes extracted source mtimes recursively for each arm', () => {
  const directory = mkdtempSync(join(tmpdir(), 'identity-mtime-test-'));
  try {
    mkdirSync(join(directory, 'rust'));
    const file = join(directory, 'rust', 'lib.rs');
    for (const oldTime of [1, 2]) {
      writeFileSync(file, `// arm ${oldTime}`);
      utimesSync(file, oldTime, oldTime);
      const before = Date.now();
      refreshSourceMtimes(directory);
      assert.ok(statSync(file).mtimeMs >= before - 1);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
