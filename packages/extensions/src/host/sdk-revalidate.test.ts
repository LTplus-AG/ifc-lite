/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { ExtensionRuntime } from './runtime.js';
import { createMemorySandboxFactory } from './memory-factory.js';
import { revalidateAgainstSdk } from './sdk-revalidate.js';
import type { Bundle, ExtensionManifest } from '../types.js';

function makeBundle(opts: {
  id?: string;
  declared: string;
  source?: string;
  withTests?: boolean;
}): Bundle {
  const encoder = new TextEncoder();
  const id = opts.id ?? 'com.example.staleish';
  const manifest: ExtensionManifest = {
    manifestVersion: 1,
    id,
    name: 'Staleish',
    description: 'd',
    version: '1.0.0',
    engines: { ifcLiteSdk: opts.declared },
    capabilities: [],
    activation: [`onCommand:${id}.run`],
    contributes: { commands: [{ id: `${id}.run`, title: 'Run' }] },
    entry: { commands: { [`${id}.run`]: 'src/run.js' } },
    tests: opts.withTests
      ? [{
          name: 'returns ok',
          command: `${id}.run`,
          fixture: 'empty-model',
          expect: { regex: 'ok' },
        }]
      : undefined,
  };
  const files = new Map<string, { path: string; bytes: Uint8Array; text?: string }>();
  const source = opts.source ?? `function run() { return 'ok'; }`;
  files.set('src/run.js', { path: 'src/run.js', bytes: encoder.encode(source), text: source });
  return { manifest, files };
}

describe('revalidateAgainstSdk', () => {
  const runtime = new ExtensionRuntime({ factory: createMemorySandboxFactory() });

  it('skips compatible extensions without running their tests', async () => {
    const bundle = makeBundle({ declared: '>=2.0.0', withTests: true });
    let resolved = 0;
    const summary = await revalidateAgainstSdk({
      sdk: '2.5.0',
      installed: [{ id: bundle.manifest.id, engines: bundle.manifest.engines, grants: [] }],
      resolveBundle: () => {
        resolved += 1;
        return bundle;
      },
      runtime,
    });
    expect(summary.items[0].compatibility.status).toBe('compatible');
    expect(summary.items[0].outcome).toBe('pass');
    expect(summary.items[0].tests).toBeUndefined();
    expect(summary.needsRepair).toHaveLength(0);
    expect(resolved).toBe(0); // compatible rows don't resolve the bundle
  });

  it('marks outdated extensions as needing repair when bundle bytes are missing', async () => {
    const bundle = makeBundle({ declared: '^1.0.0' });
    const summary = await revalidateAgainstSdk({
      sdk: '3.0.0',
      installed: [{ id: bundle.manifest.id, engines: bundle.manifest.engines, grants: [] }],
      resolveBundle: () => undefined,
      runtime,
    });
    expect(summary.items[0].compatibility.status).toBe('outdated');
    expect(summary.items[0].outcome).toBe('skipped');
    expect(summary.needsRepair).toHaveLength(1);
  });

  it('marks outdated extensions as skipped when manifest declares no tests', async () => {
    const bundle = makeBundle({ declared: '^1.0.0', withTests: false });
    const summary = await revalidateAgainstSdk({
      sdk: '3.0.0',
      installed: [{ id: bundle.manifest.id, engines: bundle.manifest.engines, grants: [] }],
      resolveBundle: () => bundle,
      runtime,
    });
    expect(summary.items[0].outcome).toBe('skipped');
    expect(summary.items[0].reason).toMatch(/no tests/);
    expect(summary.needsRepair).toHaveLength(1);
  });

  it('runs tests for outdated ranges and reports pass when tests pass', async () => {
    const bundle = makeBundle({ declared: '^1.0.0', withTests: true });
    const summary = await revalidateAgainstSdk({
      sdk: '3.0.0',
      installed: [{ id: bundle.manifest.id, engines: bundle.manifest.engines, grants: [] }],
      resolveBundle: () => bundle,
      runtime,
    });
    expect(summary.items[0].compatibility.status).toBe('outdated');
    expect(summary.items[0].outcome).toBe('pass');
    expect(summary.items[0].tests?.passed).toBe(1);
    expect(summary.needsRepair).toHaveLength(0);
  });

  it('reports fail when tests fail against the new SDK', async () => {
    const bundle = makeBundle({
      declared: '^1.0.0',
      withTests: true,
      source: `function run() { return 'oops'; }`,
    });
    const summary = await revalidateAgainstSdk({
      sdk: '3.0.0',
      installed: [{ id: bundle.manifest.id, engines: bundle.manifest.engines, grants: [] }],
      resolveBundle: () => bundle,
      runtime,
    });
    expect(summary.items[0].outcome).toBe('fail');
    expect(summary.needsRepair).toHaveLength(1);
  });

  it('handles a mix of compatible + outdated extensions', async () => {
    const bundleA = makeBundle({ id: 'com.example.a', declared: '>=2.0.0', withTests: true });
    const bundleB = makeBundle({ id: 'com.example.b', declared: '^1.0.0', withTests: true });
    const summary = await revalidateAgainstSdk({
      sdk: '2.5.0',
      installed: [
        { id: bundleA.manifest.id, engines: bundleA.manifest.engines, grants: [] },
        { id: bundleB.manifest.id, engines: bundleB.manifest.engines, grants: [] },
      ],
      resolveBundle: (id) => (id === bundleA.manifest.id ? bundleA : bundleB),
      runtime,
    });
    expect(summary.items).toHaveLength(2);
    expect(summary.items[0].compatibility.status).toBe('compatible');
    expect(summary.items[1].compatibility.status).toBe('outdated');
  });
});
