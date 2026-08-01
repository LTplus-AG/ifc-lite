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
 *
 * The fixtures below satisfy `RunExporterDeps` (and the real `Bundle` /
 * `ExtensionManifest` / `InstalledExtensionRecord` / `ActivationRecord`
 * shapes) without a cast: #1930 review item 4 removed the `as never` that
 * used to sit here, since it erased type-checking of these fixtures against
 * `RunExporterDeps`, letting signature drift compile silently.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import type {
  ActivationRecord,
  Bundle,
  BundleFile,
  ExtensionManifest,
  InstalledExtensionRecord,
} from '@ifc-lite/extensions';
import { runExtensionExporter, coerceExporterOutput, type RunExporterDeps } from './host-exporters.js';

const EXPORTER_ID = 'ext.demo.csv';
const HANDLER_PATH = 'exporters/csv.js';

/** Minimal-but-real `ExtensionManifest`, declaring one exporter contribution. */
function manifestFor(id: string, handler: string): ExtensionManifest {
  return {
    manifestVersion: 1,
    id,
    name: 'Demo',
    description: 'Fixture extension for host-exporters tests.',
    version: '1.0.0',
    engines: { ifcLiteSdk: '^1.0.0' },
    capabilities: [],
    activation: [`onExporter:${EXPORTER_ID}`],
    entry: {},
    contributes: {
      exporters: [{
        id: EXPORTER_ID,
        name: 'Demo CSV',
        mimeType: 'text/csv',
        extension: '.csv',
        handler,
      }],
    },
  };
}

function bundleFile(source: string): BundleFile {
  return { path: HANDLER_PATH, bytes: new TextEncoder().encode(source), text: source };
}

function installedRecord(
  id: string,
  overrides: Partial<InstalledExtensionRecord> = {},
): InstalledExtensionRecord {
  return {
    id,
    version: '1.0.0',
    bundleHash: 'deadbeef',
    grantedCapabilities: [],
    enabled: true,
    installedAt: '2024-01-01T00:00:00.000Z',
    source: 'local',
    ...overrides,
  };
}

/**
 * A fake sandbox that runs the REAL `wrapEntrySource` output via plain
 * `eval`, so these tests break if the wrapper contract changes.
 * `BimSandboxHandle` synthesizes `globalThis.bim` from the host bridge; the
 * wrapper hard-fails without it, so stand that in here and restore after.
 */
function fakeSandbox(
  recordRanSource: (source: string) => void,
  recordSetGlobal?: (name: string, value: unknown) => void,
) {
  let ctx: unknown;
  return {
    setGlobal: async (name: string, value: unknown) => {
      if (name === '__ifclite_ctx__') ctx = value;
      recordSetGlobal?.(name, value);
    },
    run: async (source: string) => {
      recordRanSource(source);
      const g = globalThis as unknown as Record<string, unknown>;
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
    dispose: async () => {},
    isDisposed: false,
  };
}

function activationRecord(
  extensionId: string,
  sandbox: ReturnType<typeof fakeSandbox>,
): ActivationRecord {
  return {
    extensionId,
    activatedAt: '2024-01-01T00:00:00.000Z',
    permissions: {},
    grants: [],
    sandbox,
  };
}

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

  const files = new Map<string, BundleFile>();
  if (options.withHandlerFile !== false) {
    files.set(HANDLER_PATH, bundleFile(options.handlerSource ?? 'function run() { return "a,b\\n1,2"; }'));
  }

  const bundle: Bundle = { manifest: manifestFor('demo', HANDLER_PATH), files };
  const sandbox = fakeSandbox(
    (source) => { ranSource = source; },
    (name, value) => { globals[name] = value; },
  );

  const deps: RunExporterDeps = {
    storage: {
      listExtensions: async () => [installedRecord('demo', {
        enabled: options.enabled ?? true,
        grantedCapabilities: options.grants ?? [],
      })],
    },
    loader: { getBundle: (id: string) => (id === 'demo' ? bundle : undefined) },
    runtime: {
      activate: async () => activationRecord('demo', sandbox),
      deactivate: async () => {},
    },
    dispatcher: { fire: async (event) => { fired.push(event); return []; } },
    sdk: { marker: 'bim-context' },
  };

  return { deps, fired, globals, get ranSource() { return ranSource; } };
}

describe('runExtensionExporter (#1907)', () => {
  it('runs the declared handler and returns its bytes', async () => {
    const f = fixture();

    const out = await runExtensionExporter(f.deps, EXPORTER_ID, 'demo');

    assert.equal(out.data, 'a,b\n1,2');
    assert.equal(out.contribution.mimeType, 'text/csv');
    assert.equal(out.contribution.extension, '.csv');
  });

  it('fires onExporter:<id> so the extension can activate on it', async () => {
    const f = fixture();

    await runExtensionExporter(f.deps, EXPORTER_ID, 'demo');

    assert.deepStrictEqual(f.fired, [`onExporter:${EXPORTER_ID}`]);
  });

  it('injects the SDK context the handler needs to read the model', async () => {
    const f = fixture();

    await runExtensionExporter(f.deps, EXPORTER_ID, 'demo');

    assert.deepStrictEqual(f.globals['__ifclite_ctx__'], { bim: { marker: 'bim-context' } });
  });

  // The handler path is on the contribution, NOT in manifest.entry —
  // ManifestEntry has no exporters map. Resolving it the command way would
  // find nothing and make every exporter look unowned.
  it('resolves the handler from contributes.exporters[].handler, not manifest.entry', async () => {
    const f = fixture();

    await runExtensionExporter(f.deps, EXPORTER_ID, 'demo');

    assert.ok(f.ranSource?.includes('function run'), 'expected the handler file to be the source run');
  });

  // #1930 review item 5: `extensionId` is required, so the old unscoped
  // "first enabled owner" scan no longer exists — a disabled owner now
  // always fails via the scoped "does not own" error, same as a caller
  // naming the wrong extension entirely.
  it('throws the scoped error when the named extension is disabled', async () => {
    const f = fixture({ enabled: false });

    await assert.rejects(
      () => runExtensionExporter(f.deps, EXPORTER_ID, 'demo'),
      /Extension "demo" does not own an enabled exporter "ext\.demo\.csv"/,
    );
  });

  // #1930 review: two enabled extensions can declare the SAME exporter id.
  // `ExtensionExportSlot` renders one button per `SlotContribution`, each
  // carrying its own `extensionId` — without threading that id through,
  // `runExtensionExporter` took the first match in storage order, so the
  // second extension's button silently ran the first extension's handler.
  it('runs the extension named by extensionId, not just the first owner of the id', async () => {
    const filesA = new Map<string, BundleFile>([
      ['exporters/a.js', bundleFile('function run() { return "from-a"; }')],
    ]);
    const filesB = new Map<string, BundleFile>([
      ['exporters/b.js', bundleFile('function run() { return "from-b"; }')],
    ]);
    const bundles = new Map<string, Bundle>([
      ['ext-a', { manifest: manifestFor('ext-a', 'exporters/a.js'), files: filesA }],
      ['ext-b', { manifest: manifestFor('ext-b', 'exporters/b.js'), files: filesB }],
    ]);
    const sandbox = fakeSandbox(() => {});

    const deps: RunExporterDeps = {
      storage: {
        listExtensions: async () => [installedRecord('ext-a'), installedRecord('ext-b')],
      },
      loader: { getBundle: (id: string) => bundles.get(id) },
      runtime: {
        activate: async (extensionId: string) => activationRecord(extensionId, sandbox),
        deactivate: async () => {},
      },
      dispatcher: { fire: async () => [] },
      sdk: { marker: 'bim-context' },
    };

    const out = await runExtensionExporter(deps, EXPORTER_ID, 'ext-b');

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
      () => runExtensionExporter(f.deps, EXPORTER_ID, 'demo'),
      /missing from bundle/,
    );
  });

  // A user who clicks Export and silently gets nothing cannot tell a broken
  // extension from a broken viewer.
  it('throws rather than downloading an empty file when the handler returns nothing', async () => {
    const f = fixture({ handlerSource: 'function run() { return undefined; }' });

    await assert.rejects(
      () => runExtensionExporter(f.deps, EXPORTER_ID, 'demo'),
      /returned nothing; expected a string or byte array/,
    );
  });

  // #1930 review item 1: a handler returning an empty string coerces to a
  // zero-LENGTH value, not `null`, so the "cannot become a file" check alone
  // let it through — the user got a 0-byte file and a success toast.
  it('throws when the handler returns an empty string', async () => {
    const f = fixture({ handlerSource: "function run() { return ''; }" });

    await assert.rejects(
      () => runExtensionExporter(f.deps, EXPORTER_ID, 'demo'),
      /returned an empty string; an empty export is not writable/,
    );
  });

  it('throws when the handler returns an empty array', async () => {
    const f = fixture({ handlerSource: 'function run() { return []; }' });

    await assert.rejects(
      () => runExtensionExporter(f.deps, EXPORTER_ID, 'demo'),
      /returned an empty array; an empty export is not writable/,
    );
  });

  // This test harness runs the handler via plain `eval` (see `fixture()`
  // above), not the real QuickJS sandbox, so a handler literally returning
  // `new Uint8Array(0)` here hits the `instanceof Uint8Array` branch in
  // `coerceExporterOutput` directly, rather than the round-tripped `{}`
  // shape production sees. Both are exercised: this one names the
  // `Uint8Array` case; the `coerceExporterOutput` suite below pins what `{}`
  // does, which is to fall through to the caller's generic object error rather
  // than this empty-specific message.
  it('throws when the handler returns an empty Uint8Array', async () => {
    const f = fixture({ handlerSource: 'function run() { return new Uint8Array(0); }' });

    await assert.rejects(
      () => runExtensionExporter(f.deps, EXPORTER_ID, 'demo'),
      /returned an empty Uint8Array; an empty export is not writable/,
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

  // `{}` is what production actually delivers for an empty export: `vm.dump`
  // JSON round-trips the return value, so `new Uint8Array(0)` reaches the host
  // with no keys at all, indistinguishable from any other empty object. The
  // dense-key branch requires at least one entry, so this returns null and the
  // caller raises its generic "returned an object" error rather than the
  // empty-specific one. Both refuse to write the file, which is what matters;
  // pinned here so the wording of that path is a choice, not an accident.
  it('cannot tell a round-tripped empty typed array from any other empty object', () => {
    assert.equal(coerceExporterOutput({}), null);
  });

  // The third typed-array branch, `ArrayBuffer.isView`, is unreachable through
  // the sandbox for the same round-tripping reason, so this is the only thing
  // exercising it. A view must be read through its own offset and length, not
  // its whole backing buffer.
  // The view must carry a non-zero offset AND a shorter length than its
  // backing buffer, or the test cannot tell `new Uint8Array(buf, off, len)`
  // from `new Uint8Array(buf)` and pins nothing. A plain `Uint8Array` would
  // also return at the earlier `instanceof` branch and never reach this one.
  it('reads a typed-array view through its offset and length, not the whole buffer', () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    assert.deepStrictEqual(coerceExporterOutput(new DataView(backing, 1, 3)), new Uint8Array([2, 3, 4]));
    assert.deepStrictEqual(coerceExporterOutput(new Int8Array(backing, 2, 2)), new Uint8Array([3, 4]));
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

  // #1930 review item 2: `Uint8Array.from` silently wraps out-of-range
  // values mod 256 and truncates floats instead of raising, so
  // `[300, -5, 1.7]` used to become `Uint8Array[44, 251, 1]` with no
  // indication the handler returned garbage. Both branches that build a
  // `Uint8Array` from plain numbers — the array branch and the
  // numeric-keyed-object (structured-clone) branch — must validate every
  // value is `Number.isInteger(v) && v >= 0 && v <= 255` and reject the
  // whole sequence otherwise.
  it('rejects an out-of-range, negative, or non-integer value in a number array', () => {
    assert.equal(coerceExporterOutput([44, 300, 1]), null);
    assert.equal(coerceExporterOutput([44, -5, 1]), null);
    assert.equal(coerceExporterOutput([44, 1.7, 1]), null);
  });

  it('rejects an out-of-range, negative, or non-integer value in a numeric-keyed object', () => {
    assert.equal(coerceExporterOutput({ 0: 300, 1: 5 }), null);
    assert.equal(coerceExporterOutput({ 0: 44, 1: -5 }), null);
    assert.equal(coerceExporterOutput({ 0: 44, 1: 1.7 }), null);
  });
});
