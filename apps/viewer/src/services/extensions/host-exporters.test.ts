/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression coverage for #1907: a declared `exporters` contribution loaded
 * and registered to the `exportMenu` slot but was never reachable, because
 * nothing could run it and nothing rendered it.
 *
 * These drive the dispatch half end-to-end against a fixture extension —
 * manifest, bundle file, storage record — rather than asserting a mock's
 * return value.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { runExtensionExporter, coerceExporterOutput } from './host-exporters.js';

const EXPORTER_ID = 'ext.demo.csv';
const HANDLER_PATH = 'exporters/csv.js';

/** A fixture extension declaring one exporter, wired the way the loader expects. */
function fixture(options: {
  handlerSource?: string;
  enabled?: boolean;
  withHandlerFile?: boolean;
  grants?: string[];
} = {}) {
  const fired: string[] = [];
  const globals: Record<string, unknown> = {};
  let ranSource: string | null = null;

  const manifest = {
    id: 'demo',
    entry: {},
    contributes: {
      exporters: [{
        id: EXPORTER_ID,
        name: 'Demo CSV',
        mimeType: 'text/csv',
        extension: '.csv',
        handler: HANDLER_PATH,
      }],
    },
  };

  const files = new Map<string, { text?: string; bytes?: Uint8Array }>();
  if (options.withHandlerFile !== false) {
    files.set(HANDLER_PATH, {
      text: options.handlerSource ?? 'function run() { return "a,b\\n1,2"; }',
    });
  }

  const bundle = { manifest, files };

  const deps = {
    storage: {
      listExtensions: async () => [{
        id: 'demo',
        enabled: options.enabled ?? true,
        grantedCapabilities: options.grants ?? [],
      }],
    },
    loader: { getBundle: (id: string) => (id === 'demo' ? bundle : undefined) },
    runtime: {
      activate: async () => ({
        sandbox: {
          setGlobal: async (k: string, v: unknown) => { globals[k] = v; },
          run: async (source: string) => {
            ranSource = source;
            // Evaluate the REAL wrapEntrySource output, so these tests break if
            // the wrapper contract changes. BimSandboxHandle synthesizes
            // `globalThis.bim` from the host bridge; the wrapper hard-fails
            // without it, so stand that in here and restore after.
            const g = globalThis as unknown as Record<string, unknown>;
            const prevCtx = g.__ifclite_ctx__;
            const prevBim = g.bim;
            g.__ifclite_ctx__ = globals['__ifclite_ctx__'];
            g.bim = (globals['__ifclite_ctx__'] as { bim?: unknown } | undefined)?.bim;
            try {
              const value = await (0, eval)(source);
              return { value, logs: [], durationMs: 1 };
            } finally {
              g.__ifclite_ctx__ = prevCtx;
              g.bim = prevBim;
            }
          },
        },
      }),
      deactivate: async () => {},
    },
    dispatcher: { fire: async (event: string) => { fired.push(event); } },
    sdk: { marker: 'bim-context' },
  };

  return { deps: deps as never, fired, globals, get ranSource() { return ranSource; } };
}

describe('runExtensionExporter (#1907)', () => {
  it('runs the declared handler and returns its bytes', async () => {
    const f = fixture();

    const out = await runExtensionExporter(f.deps, EXPORTER_ID);

    assert.equal(out.data, 'a,b\n1,2');
    assert.equal(out.contribution.mimeType, 'text/csv');
    assert.equal(out.contribution.extension, '.csv');
  });

  it('fires onExporter:<id> so the extension can activate on it', async () => {
    const f = fixture();

    await runExtensionExporter(f.deps, EXPORTER_ID);

    assert.deepStrictEqual(f.fired, [`onExporter:${EXPORTER_ID}`]);
  });

  it('injects the SDK context the handler needs to read the model', async () => {
    const f = fixture();

    await runExtensionExporter(f.deps, EXPORTER_ID);

    assert.deepStrictEqual(f.globals['__ifclite_ctx__'], { bim: { marker: 'bim-context' } });
  });

  // The handler path is on the contribution, NOT in manifest.entry —
  // ManifestEntry has no exporters map. Resolving it the command way would
  // find nothing and make every exporter look unowned.
  it('resolves the handler from contributes.exporters[].handler, not manifest.entry', async () => {
    const f = fixture();

    await runExtensionExporter(f.deps, EXPORTER_ID);

    assert.ok(f.ranSource?.includes('function run'), 'expected the handler file to be the source run');
  });

  it('throws a named error when no enabled extension owns the id', async () => {
    const f = fixture({ enabled: false });

    await assert.rejects(
      () => runExtensionExporter(f.deps, EXPORTER_ID),
      /No installed, enabled extension owns exporter/,
    );
  });

  // #1930 review: two enabled extensions can declare the SAME exporter id.
  // `ExtensionExportSlot` renders one button per `SlotContribution`, each
  // carrying its own `extensionId` — without threading that id through,
  // `runExtensionExporter` took the first match in storage order, so the
  // second extension's button silently ran the first extension's handler.
  it('runs the extension named by extensionId, not just the first owner of the id', async () => {
    const fired: string[] = [];
    const files = new Map<string, { text: string }>([
      ['exporters/a.js', { text: 'function run() { return "from-a"; }' }],
      ['exporters/b.js', { text: 'function run() { return "from-b"; }' }],
    ]);
    const manifestFor = (handler: string) => ({
      id: 'unused',
      entry: {},
      contributes: {
        exporters: [{ id: EXPORTER_ID, name: 'x', mimeType: 'text/plain', extension: '.txt', handler }],
      },
    });
    const bundles = new Map([
      ['ext-a', { manifest: manifestFor('exporters/a.js'), files }],
      ['ext-b', { manifest: manifestFor('exporters/b.js'), files }],
    ]);
    const deps = {
      storage: {
        listExtensions: async () => [
          { id: 'ext-a', enabled: true, grantedCapabilities: [] },
          { id: 'ext-b', enabled: true, grantedCapabilities: [] },
        ],
      },
      loader: { getBundle: (id: string) => bundles.get(id) },
      runtime: {
        activate: async () => ({
          sandbox: {
            setGlobal: async (k: string, v: unknown) => { (globalThis as unknown as Record<string, unknown>).__probe_ctx__ = v; void k; },
            // Mirror `fixture()`'s sandbox: stand in the `globalThis.bim` /
            // `__ifclite_ctx__` the real wrapper hard-requires, then restore.
            run: async (source: string) => {
              const g = globalThis as unknown as Record<string, unknown>;
              const ctx = g.__probe_ctx__;
              const prevCtx = g.__ifclite_ctx__;
              const prevBim = g.bim;
              g.__ifclite_ctx__ = ctx;
              g.bim = (ctx as { bim?: unknown } | undefined)?.bim;
              try {
                const value = await (0, eval)(source);
                return { value, logs: [], durationMs: 1 };
              } finally {
                g.__ifclite_ctx__ = prevCtx;
                g.bim = prevBim;
              }
            },
          },
        }),
        deactivate: async () => {},
      },
      dispatcher: { fire: async (event: string) => { fired.push(event); } },
      sdk: { marker: 'bim-context' },
    };

    const out = await runExtensionExporter(deps as never, EXPORTER_ID, 'ext-b');

    assert.equal(out.data, 'from-b');
  });

  it('throws naming the extension when it does not own an enabled exporter with that id', async () => {
    const f = fixture();

    await assert.rejects(
      () => runExtensionExporter(f.deps, EXPORTER_ID, 'someone-else'),
      /Extension "someone-else" does not own an enabled exporter/,
    );
  });

  it('throws when the handler file is missing from the bundle', async () => {
    const f = fixture({ withHandlerFile: false });

    await assert.rejects(
      () => runExtensionExporter(f.deps, EXPORTER_ID),
      /missing from bundle/,
    );
  });

  // A user who clicks Export and silently gets nothing cannot tell a broken
  // extension from a broken viewer.
  it('throws rather than downloading an empty file when the handler returns nothing', async () => {
    const f = fixture({ handlerSource: 'function run() { return undefined; }' });

    await assert.rejects(
      () => runExtensionExporter(f.deps, EXPORTER_ID),
      /returned nothing; expected a string or byte array/,
    );
  });
});

describe('coerceExporterOutput', () => {
  it('passes strings through', () => {
    assert.equal(coerceExporterOutput('hello'), 'hello');
  });

  it('passes a Uint8Array through', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    assert.equal(coerceExporterOutput(bytes), bytes);
  });

  it('wraps an ArrayBuffer', () => {
    assert.deepStrictEqual(coerceExporterOutput(new Uint8Array([4, 5]).buffer), new Uint8Array([4, 5]));
  });

  it('accepts a number array', () => {
    assert.deepStrictEqual(coerceExporterOutput([7, 8, 9]), new Uint8Array([7, 8, 9]));
  });

  // Typed arrays flatten to numeric-keyed objects across a sandbox boundary.
  // Rejecting that shape would fail valid extensions for an invisible reason.
  it('rebuilds a structured-cloned Uint8Array', () => {
    assert.deepStrictEqual(coerceExporterOutput({ 0: 10, 1: 20, 2: 30 }), new Uint8Array([10, 20, 30]));
  });

  it('rejects values that cannot become a file', () => {
    assert.equal(coerceExporterOutput(undefined), null);
    assert.equal(coerceExporterOutput(null), null);
    assert.equal(coerceExporterOutput(42), null);
    assert.equal(coerceExporterOutput({ nope: true }), null);
  });

  // A sparse numeric-keyed object (e.g. `{0: 65, 100: 66}`) used to pass the
  // old "all keys are digit-strings" check, then allocate
  // `Uint8Array(entries.length)` — 2 bytes here — and write `bytes[100] = 66`,
  // which JS silently drops since it's out of range. That produced a
  // corrupted 2-byte download instead of a clear rejection. Only a DENSE,
  // in-order object ("0".."n-1") may be treated as a cloned Uint8Array.
  it('rejects a sparse numeric-keyed object instead of silently dropping out-of-range writes', () => {
    assert.equal(coerceExporterOutput({ 0: 65, 100: 66 }), null);
  });

  it('rejects a numeric-keyed object with a gap in the sequence', () => {
    assert.equal(coerceExporterOutput({ 0: 1, 2: 3 }), null);
  });
});
