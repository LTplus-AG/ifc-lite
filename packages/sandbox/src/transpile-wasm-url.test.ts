/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The CDN fallback URL for `esbuild.wasm` must name the same version as the
 * `esbuild-wasm` JS host that loads it: `esbuild.initialize()` rejects a
 * host/binary mismatch outright ("Host version does not match binary
 * version"), so a stale version in the URL means the fallback cannot start at
 * all and the sandbox silently degrades to the regex transpiler.
 *
 * The version here is faked, deliberately: the assertion is that the URL is
 * *derived* from whatever host is loaded, not that it equals today's release.
 * A coordinated dependency bump therefore keeps this green, while re-hardcoding
 * a literal version turns it red.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { FAKE_VERSION, captured } = vi.hoisted(() => ({
  FAKE_VERSION: '9.9.9-fake',
  captured: { wasmURL: undefined as string | undefined, initialized: false },
}));

vi.mock('esbuild-wasm', () => {
  // Shape mirrors the real package: named exports plus a `default` carrying
  // the same members, which is what `transpile.ts` reaches for first.
  const fake = {
    version: FAKE_VERSION,
    initialize: async (options: { wasmURL?: string }) => {
      captured.wasmURL = options.wasmURL;
      captured.initialized = true;
    },
    transform: async (code: string) => ({ code }),
  };
  return { ...fake, default: fake };
});

// The Vite-only `?url` asset hint is what the CDN branch is a fallback for.
// Force that branch by making the asset unresolvable, as a non-Vite bundler
// would.
vi.mock('esbuild-wasm/esbuild.wasm?url', () => {
  throw new Error('no ?url asset resolver (simulating a non-Vite bundler)');
});

describe('esbuild.wasm CDN fallback URL', () => {
  beforeEach(() => {
    captured.wasmURL = undefined;
    captured.initialized = false;
    vi.resetModules();
  });

  it('names the version of the esbuild-wasm host that will load it', async () => {
    const { transpileTypeScript } = await import('./transpile.js');
    await transpileTypeScript('const x: number = 1;');

    expect(captured.initialized).toBe(true);
    expect(captured.wasmURL).toBe(`https://unpkg.com/esbuild-wasm@${FAKE_VERSION}/esbuild.wasm`);
  });

  // The test above proves the URL follows the host's `version`; this one proves
  // that `version` is a real thing the installed package exports, and that it
  // is the version unpkg would be asked for. Without it, a dropped export would
  // yield `esbuild-wasm@undefined` and still satisfy the mock.
  it('reads a version from the installed esbuild-wasm that matches its manifest', async () => {
    const actual = await vi.importActual<{ version: string }>('esbuild-wasm');
    const manifestPath = createRequire(import.meta.url).resolve('esbuild-wasm/package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string };

    expect(actual.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(actual.version).toBe(manifest.version);
  });
});
