/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression guard for #2130.
 *
 * `vite-plugin-top-level-await` re-parses every emitted ES chunk with SWC. Its
 * parser config asks for plain `ecmascript` without `explicitResourceManagement`,
 * and `@swc/core`'s `Visitor` base class has no `UsingDeclaration` arm — so a
 * single `using x = ...` anywhere in `apps/viewer` failed the production build
 * long after a clean `tsc --noEmit`, with a diagnostic that crashed the error
 * formatter and showed no line number.
 *
 * Both holes are closed by patches (`patches/vite-plugin-top-level-await@1.6.0.patch`,
 * `patches/@swc__core@1.15.8.patch`). This test drives a real `vite.build()` over
 * a four-line fixture that uses `using`, so the guard is the actual build path
 * rather than an assertion about patch file contents.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build } from 'vite';
import topLevelAwait from 'vite-plugin-top-level-await';

/** The fixture the viewer cannot express today: a `using` declaration plus a TLA. */
const FIXTURE = `
export const order: string[] = [];

class Handle {
  constructor(private readonly name: string) {
    order.push('open:' + this.name);
  }
  [Symbol.dispose]() {
    order.push('close:' + this.name);
  }
}

export function withHandles(): number {
  using a = new Handle('a');
  using b = new Handle('b');
  order.push('body');
  return 42;
}

// Present so the plugin actually engages: without a top-level await it may skip
// the chunk entirely and the parse that #2130 trips over never happens.
export const tla = await Promise.resolve('tla');
`;

interface BuiltChunk {
  code: string;
  order: string[];
  result: number;
}

/** Builds the fixture at `target`, returning the single emitted chunk. */
async function buildFixture(target: string, run: boolean): Promise<BuiltChunk> {
  const root = mkdtempSync(join(tmpdir(), 'ifclite-2130-'));
  try {
    writeFileSync(join(root, 'entry.ts'), FIXTURE);
    const outDir = join(root, 'dist');
    mkdirSync(outDir, { recursive: true });
    await build({
      root,
      logLevel: 'silent',
      configFile: false,
      build: {
        target,
        outDir,
        emptyOutDir: true,
        lib: { entry: join(root, 'entry.ts'), formats: ['es'], fileName: 'chunk' },
      },
      plugins: [topLevelAwait()],
    });
    const emitted = readdirSync(outDir).filter((f) => f.endsWith('.mjs') || f.endsWith('.js'));
    assert.equal(emitted.length, 1, `expected exactly one chunk, got ${emitted.join(', ')}`);
    const file = join(outDir, emitted[0]!);
    const code = readFileSync(file, 'utf8');
    if (!run) return { code, order: [], result: 0 };
    const mod = (await import(file)) as {
      withHandles: () => number;
      order: string[];
      tla: string;
    };
    const result = mod.withHandles();
    return { code, order: mod.order, result };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('using declarations survive the vite-plugin-top-level-await pipeline (#2130)', () => {
  it('builds a chunk containing a `using` declaration at target esnext', async () => {
    // Before the patches this rejected with an SWC parse error
    // ("Using declaration is not enabled"), surfacing in the real viewer build
    // as a miette panic with no line number.
    const { code } = await buildFixture('esnext', false);
    // esnext keeps `using` un-lowered, so the plugin's SWC round trip has to
    // both parse and re-print it. Assert it survived rather than being dropped:
    // a chunk that silently lost the declaration would never dispose the handle.
    assert.match(code, /\busing\b/, 'the `using` declaration was lost in the SWC round trip');
  });

  it('preserves disposal semantics when the target lowers `using`', async () => {
    // es2022 makes esbuild lower `using` to a try/finally stack, so the emitted
    // chunk is executable here and the ordering contract can be asserted for real.
    const { order, result } = await buildFixture('es2022', true);
    assert.equal(result, 42);
    assert.deepEqual(order, ['open:a', 'open:b', 'body', 'close:b', 'close:a']);
  });
});
