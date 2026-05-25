/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { ExtensionRuntime } from '../host/runtime.js';
import { createMemorySandboxFactory } from '../host/memory-factory.js';
import { runBundleTests } from './runner.js';
import {
  buildSyntheticBim,
  syntheticFixtureLoader,
  CANONICAL_FIXTURES,
} from './synthetic.js';
import type { Bundle, ExtensionManifest } from '../types.js';

function makeBundle(source: string, tests: ExtensionManifest['tests']): Bundle {
  const encoder = new TextEncoder();
  const manifest: ExtensionManifest = {
    manifestVersion: 1,
    id: 'com.example.synth',
    name: 'Synth Test',
    description: 'd',
    version: '1.0.0',
    engines: { ifcLiteSdk: '>=2.0.0' },
    capabilities: [],
    activation: ['onCommand:ext.synth.run'],
    contributes: { commands: [{ id: 'ext.synth.run', title: 'Run' }] },
    entry: { commands: { 'ext.synth.run': 'src/run.js' } },
    tests,
  };
  const files = new Map<string, { path: string; bytes: Uint8Array; text?: string }>();
  files.set('src/run.js', { path: 'src/run.js', bytes: encoder.encode(source), text: source });
  return { manifest, files };
}

describe('synthetic fixtures', () => {
  it('builds a bim ctx whose query.byType returns the declared entities', () => {
    const bim = buildSyntheticBim({
      id: 'x',
      elements: { IfcWall: 3, IfcSlab: 2 },
    });
    expect(bim.schema).toBe('IFC4');
    expect(bim.query.count()).toBe(5);
    expect(bim.query.byType('IfcWall')).toHaveLength(3);
    expect(bim.query.byType('IfcSlab')).toHaveLength(2);
    expect(bim.query.byType('IfcDoor')).toHaveLength(0);
  });

  it('canonical fixture set has stable counts', () => {
    const bim = buildSyntheticBim(CANONICAL_FIXTURES['residential-small']);
    expect(bim.query.byType('IfcWall')).toHaveLength(12);
    expect(bim.query.count()).toBe(12 + 4 + 6 + 8 + 5);
  });

  it('loader throws for unknown fixture names so tests fail cleanly', async () => {
    const loader = syntheticFixtureLoader({ a: CANONICAL_FIXTURES['empty-model'] });
    await expect(loader('does-not-exist')).rejects.toThrow(/Unknown synthetic fixture/);
  });

  it('integrates with the test runner end-to-end', async () => {
    const runtime = new ExtensionRuntime({ factory: createMemorySandboxFactory() });
    const bundle = makeBundle(
      `function run(ctx) {
        return { walls: ctx.bim.query.byType('IfcWall').length };
      }`,
      [{
        name: 'walls count',
        command: 'ext.synth.run',
        fixture: 'residential-small',
        expect: { jsonShape: { walls: 12 } },
      }],
    );
    const summary = await runBundleTests({
      runtime,
      bundle,
      grants: [],
      loadFixture: syntheticFixtureLoader(CANONICAL_FIXTURES),
    });
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(0);
  });
});
