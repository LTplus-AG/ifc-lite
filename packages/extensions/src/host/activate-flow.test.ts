/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end activation flow tests using the in-memory sandbox factory.
 *
 * These tests verify that the full pipeline — bundle loaded, source
 * wrapped, ctx injected, entry function invoked — produces the
 * expected outcomes. The viewer-side QuickJS factory follows the same
 * contract; tests there will swap in `createSandbox` from
 * `@ifc-lite/sandbox`.
 */

import { describe, expect, it } from 'vitest';
import { parseCapability } from '../capability/parse.js';
import type { Bundle, ExtensionManifest } from '../types.js';
import { createMemorySandboxFactory } from './memory-factory.js';
import { EntrySourceError, ExtensionRuntime } from './runtime.js';

function p(raw: string) {
  const r = parseCapability(raw);
  if (!r.ok) throw new Error(r.errors[0].message);
  return r.value;
}

function makeBundle(source: string | undefined, opts: { deactivate?: string } = {}): Bundle {
  const files = new Map<string, { path: string; bytes: Uint8Array; text?: string }>();
  files.set('manifest.json', {
    path: 'manifest.json',
    bytes: new TextEncoder().encode('{}'),
    text: '{}',
  });
  if (source !== undefined) {
    files.set('src/activate.js', {
      path: 'src/activate.js',
      bytes: new TextEncoder().encode(source),
      text: source,
    });
  }
  if (opts.deactivate !== undefined) {
    files.set('src/deactivate.js', {
      path: 'src/deactivate.js',
      bytes: new TextEncoder().encode(opts.deactivate),
      text: opts.deactivate,
    });
  }
  const manifest: ExtensionManifest = {
    manifestVersion: 1,
    id: 'com.example.flow',
    name: 'Flow Test',
    description: 'Activation flow fixture.',
    version: '0.0.1',
    engines: { ifcLiteSdk: '>=0.0.0' },
    capabilities: ['model.read'],
    activation: ['onStartup'],
    entry: {
      ...(source !== undefined ? { activate: 'src/activate.js' } : {}),
      ...(opts.deactivate !== undefined ? { deactivate: 'src/deactivate.js' } : {}),
    },
  };
  return { manifest, files, source: { kind: 'memory' } };
}

describe('ExtensionRuntime.activate — entry execution', () => {
  it('runs entry.activate with ctx populated from sdk', async () => {
    const factory = createMemorySandboxFactory();
    const sdk = { greet: () => 'hello' };
    const runtime = new ExtensionRuntime({ factory, sdk });
    const bundle = makeBundle(
      'function activate(ctx) { return ctx.bim.greet(); }',
    );
    const record = await runtime.activate('com.example.flow', [p('model.read')], bundle);
    expect(record.activateResult?.value).toBe('hello');
  });

  it('returns undefined activateResult when entry.activate is absent', async () => {
    const runtime = new ExtensionRuntime({ factory: createMemorySandboxFactory() });
    const bundle = makeBundle(undefined);
    const record = await runtime.activate('com.example.flow', [], bundle);
    expect(record.activateResult).toBeUndefined();
  });

  it('captures console logs from activate', async () => {
    const runtime = new ExtensionRuntime({ factory: createMemorySandboxFactory() });
    const bundle = makeBundle(
      'function activate(ctx) { console.log("activating"); }',
    );
    const record = await runtime.activate('com.example.flow', [], bundle);
    expect(record.activateResult?.logs?.[0].message).toBe('activating');
  });

  it('disposes sandbox and propagates EntrySourceError on bad source', async () => {
    const factory = createMemorySandboxFactory();
    const runtime = new ExtensionRuntime({ factory });
    const bundle = makeBundle('export default function activate(ctx) {}');
    await expect(
      runtime.activate('com.example.flow', [], bundle),
    ).rejects.toBeInstanceOf(EntrySourceError);
    expect(runtime.isActive('com.example.flow')).toBe(false);
  });

  it('disposes sandbox if the entry script throws', async () => {
    const runtime = new ExtensionRuntime({ factory: createMemorySandboxFactory() });
    const bundle = makeBundle('function activate(ctx) { throw new Error("nope"); }');
    await expect(
      runtime.activate('com.example.flow', [], bundle),
    ).rejects.toThrow('nope');
    expect(runtime.isActive('com.example.flow')).toBe(false);
  });

  it('rejects when entry.activate path does not exist in bundle', async () => {
    const runtime = new ExtensionRuntime({ factory: createMemorySandboxFactory() });
    const bundle = makeBundle(undefined);
    bundle.manifest.entry.activate = 'src/missing.js';
    await expect(
      runtime.activate('com.example.flow', [], bundle),
    ).rejects.toThrow(/not found in bundle/);
    expect(runtime.isActive('com.example.flow')).toBe(false);
  });

  it('idempotence still holds when activate has executed', async () => {
    const factory = createMemorySandboxFactory();
    const runtime = new ExtensionRuntime({ factory });
    const bundle = makeBundle('function activate(ctx) { return 1; }');
    const a = await runtime.activate('com.example.flow', [], bundle);
    const b = await runtime.activate('com.example.flow', [], bundle);
    expect(a).toBe(b);
    // activateResult should remain whatever the first run produced.
    expect(a.activateResult?.value).toBe(1);
  });
});

describe('ExtensionRuntime.deactivateWithBundle — entry execution', () => {
  it('runs entry.deactivate then disposes', async () => {
    const factory = createMemorySandboxFactory();
    const runtime = new ExtensionRuntime({ factory });
    const bundle = makeBundle(
      'function activate(ctx) {}',
      { deactivate: 'function deactivate(ctx) { console.log("bye"); }' },
    );
    await runtime.activate('com.example.flow', [], bundle);
    await runtime.deactivateWithBundle('com.example.flow', bundle);
    expect(runtime.isActive('com.example.flow')).toBe(false);
  });

  it('disposes even when deactivate throws', async () => {
    const factory = createMemorySandboxFactory();
    const runtime = new ExtensionRuntime({ factory });
    const bundle = makeBundle(
      'function activate(ctx) {}',
      { deactivate: 'function deactivate(ctx) { throw new Error("oops"); }' },
    );
    await runtime.activate('com.example.flow', [], bundle);
    await expect(
      runtime.deactivateWithBundle('com.example.flow', bundle),
    ).resolves.toBeUndefined();
    expect(runtime.isActive('com.example.flow')).toBe(false);
  });

  it('no-op when deactivate path is absent', async () => {
    const factory = createMemorySandboxFactory();
    const runtime = new ExtensionRuntime({ factory });
    const bundle = makeBundle('function activate(ctx) {}');
    await runtime.activate('com.example.flow', [], bundle);
    await runtime.deactivateWithBundle('com.example.flow', bundle);
    expect(runtime.isActive('com.example.flow')).toBe(false);
  });

  it('no-op for unknown extension id', async () => {
    const runtime = new ExtensionRuntime({ factory: createMemorySandboxFactory() });
    const bundle = makeBundle('function activate(ctx) {}');
    await expect(
      runtime.deactivateWithBundle('not-active', bundle),
    ).resolves.toBeUndefined();
  });
});

describe('ExtensionRuntime — sdk plumbing', () => {
  it('passes the runtime sdk through ctx.bim', async () => {
    const sdk = { ping: () => 'pong' };
    const runtime = new ExtensionRuntime({ factory: createMemorySandboxFactory(), sdk });
    const bundle = makeBundle(
      'function activate(ctx) { return ctx.bim.ping(); }',
    );
    const record = await runtime.activate('com.example.flow', [], bundle);
    expect(record.activateResult?.value).toBe('pong');
  });

  it('ctx.bim is undefined when no sdk is provided', async () => {
    const runtime = new ExtensionRuntime({ factory: createMemorySandboxFactory() });
    const bundle = makeBundle(
      'function activate(ctx) { return typeof ctx.bim; }',
    );
    const record = await runtime.activate('com.example.flow', [], bundle);
    expect(record.activateResult?.value).toBe('undefined');
  });
});
