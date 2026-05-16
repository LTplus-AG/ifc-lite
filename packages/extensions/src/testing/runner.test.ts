/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { ExtensionRuntime } from '../host/runtime.js';
import { createMemorySandboxFactory } from '../host/memory-factory.js';
import { runBundleTests } from './runner.js';
import type { Bundle, ExtensionManifest } from '../types.js';

function makeBundle(opts: {
  source: string;
  tests: ExtensionManifest['tests'];
}): Bundle {
  const encoder = new TextEncoder();
  const manifest: ExtensionManifest = {
    manifestVersion: 1,
    id: 'com.example.runnertest',
    name: 'Runner Test',
    description: 'd',
    version: '1.0.0',
    engines: { ifcLiteSdk: '>=2.0.0' },
    capabilities: [],
    activation: ['onCommand:ext.runnertest.run'],
    contributes: {
      commands: [{ id: 'ext.runnertest.run', title: 'Run' }],
    },
    entry: {
      commands: { 'ext.runnertest.run': 'src/run.js' },
    },
    tests: opts.tests,
  };
  const files = new Map<string, { path: string; bytes: Uint8Array; text?: string }>();
  files.set('src/run.js', {
    path: 'src/run.js',
    bytes: encoder.encode(opts.source),
    text: opts.source,
  });
  return { manifest, files };
}

const RUNTIME = new ExtensionRuntime({
  factory: createMemorySandboxFactory({}),
});

describe('runBundleTests', () => {
  it('passes on a clean mimeType + minBytes match', async () => {
    const bundle = makeBundle({
      source: `function run() {
        return { mimeType: 'text/csv', bytes: new Uint8Array(120) };
      }`,
      tests: [{
        name: 'csv export size',
        command: 'ext.runnertest.run',
        fixture: 'residential-small',
        expect: { mimeType: 'text/csv', minBytes: 100, maxBytes: 1000 },
      }],
    });
    const summary = await runBundleTests({
      runtime: RUNTIME,
      bundle,
      grants: [],
    });
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it('fails when mimeType mismatches', async () => {
    const bundle = makeBundle({
      source: `function run() {
        return { mimeType: 'application/json', bytes: new Uint8Array(120) };
      }`,
      tests: [{
        name: 'csv',
        command: 'ext.runnertest.run',
        fixture: 'x',
        expect: { mimeType: 'text/csv' },
      }],
    });
    const summary = await runBundleTests({
      runtime: RUNTIME,
      bundle,
      grants: [],
    });
    expect(summary.passed).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.results[0].error).toMatch(/mimeType/);
  });

  it('honours regex matchers against string returns', async () => {
    const bundle = makeBundle({
      source: `function run() { return 'hello world 42'; }`,
      tests: [{
        name: 'regex',
        command: 'ext.runnertest.run',
        fixture: 'x',
        expect: { regex: 'hello.*42' },
      }],
    });
    const summary = await runBundleTests({
      runtime: RUNTIME,
      bundle,
      grants: [],
    });
    expect(summary.passed).toBe(1);
  });

  it('checks jsonShape types and rejects mismatches', async () => {
    const bundle = makeBundle({
      source: `function run() {
        return { count: 4, items: [{ id: 'a' }] };
      }`,
      tests: [{
        name: 'shape',
        command: 'ext.runnertest.run',
        fixture: 'x',
        expect: {
          jsonShape: {
            count: { type: 'number' },
            items: [{ id: { type: 'string' } }],
          },
        },
      }],
    });
    const summary = await runBundleTests({
      runtime: RUNTIME,
      bundle,
      grants: [],
    });
    expect(summary.passed).toBe(1);
  });

  it('reports a missing command as failure rather than throwing', async () => {
    const bundle = makeBundle({
      source: `function run() { return 'x'; }`,
      tests: [{
        name: 'wrong cmd',
        command: 'ext.runnertest.doesnotexist',
        fixture: 'x',
        expect: { regex: '.*' },
      }],
    });
    const summary = await runBundleTests({
      runtime: RUNTIME,
      bundle,
      grants: [],
    });
    expect(summary.failed).toBe(1);
    expect(summary.results[0].error).toMatch(/not declared/);
  });

  it('exposes test args via __ifclite_test_args__', async () => {
    const bundle = makeBundle({
      source: `function run() {
        const args = globalThis.__ifclite_test_args__;
        return { ok: args && args.label === 'hello' };
      }`,
      tests: [{
        name: 'args round-trip',
        command: 'ext.runnertest.run',
        fixture: 'x',
        args: { label: 'hello' },
        expect: { jsonShape: { ok: true } },
      }],
    });
    const summary = await runBundleTests({
      runtime: RUNTIME,
      bundle,
      grants: [],
    });
    expect(summary.passed).toBe(1);
  });

  it('bail option stops after first failure', async () => {
    const bundle = makeBundle({
      source: `function run() { return 'x'; }`,
      tests: [
        { name: 'a', command: 'ext.runnertest.run', fixture: 'x', expect: { regex: 'NOPE' } },
        { name: 'b', command: 'ext.runnertest.run', fixture: 'x', expect: { regex: '.*' } },
      ],
    });
    const summary = await runBundleTests({
      runtime: RUNTIME,
      bundle,
      grants: [],
      bail: true,
    });
    expect(summary.results).toHaveLength(1);
    expect(summary.failed).toBe(1);
  });

  it('returns an empty summary when manifest declares no tests', async () => {
    const bundle = makeBundle({
      source: `function run() { return 'x'; }`,
      tests: undefined,
    });
    const summary = await runBundleTests({
      runtime: RUNTIME,
      bundle,
      grants: [],
    });
    expect(summary.results).toHaveLength(0);
    expect(summary.passed).toBe(0);
    expect(summary.failed).toBe(0);
  });
});
