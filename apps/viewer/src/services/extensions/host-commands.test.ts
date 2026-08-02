/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coverage for the confused-deputy ambiguity in `runExtensionCommand`, the
 * command-side twin of the exporter defect fixed in #1930.
 *
 * `runExtensionCommand(deps, commandId)` used to take a bare command id and
 * run the first ENABLED extension in storage order that declared it. Command
 * ids are namespaced by convention only: the manifest validator
 * (`packages/extensions/src/manifest/contributions.ts`) checks that
 * `contributes.commands[].id` is a string and nothing more, and no
 * install-time check rejects an id another installed extension already
 * declares. So a second installed extension declaring a popular id could
 * serve someone else's toolbar button, context-menu item or palette entry.
 * `extensionId` is now required and matched first.
 *
 * These drive dispatch end-to-end against a fixture extension — manifest,
 * bundle file, storage record — rather than asserting a mock's return value.
 *
 * The fixtures satisfy `RunCommandDeps` (and the real `Bundle` /
 * `ExtensionManifest` / `InstalledExtensionRecord` / `ActivationRecord`
 * shapes) without a cast, because `RunCommandDeps` narrowed to structural
 * `Pick<>` types for the same reason `RunExporterDeps` did.
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
import { runExtensionCommand, type RunCommandDeps } from './host-commands.js';

const COMMAND_ID = 'ext.demo.check';
const HANDLER_PATH = 'commands/check.js';

/** Minimal-but-real `ExtensionManifest`, declaring one command contribution. */
function manifestFor(id: string, handler: string): ExtensionManifest {
  return {
    manifestVersion: 1,
    id,
    name: 'Demo',
    description: 'Fixture extension for host-commands tests.',
    version: '1.0.0',
    engines: { ifcLiteSdk: '^1.0.0' },
    capabilities: [],
    activation: [`onCommand:${COMMAND_ID}`],
    entry: { commands: { [COMMAND_ID]: handler } },
    contributes: {
      commands: [{ id: COMMAND_ID, title: 'Demo Check' }],
    },
  };
}

function bundleFile(path: string, source: string): BundleFile {
  return { path, bytes: new TextEncoder().encode(source), text: source };
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
 * The wrapper (`packages/extensions/src/host/source-wrap.ts`) reads
 * `globalThis.__ifclite_ctx__` and falls back to `globalThis.bim`, throwing
 * only when both are absent. This fixture sets the former, so the `bim` stand-in
 * below is belt-and-braces rather than load-bearing.
 * Copied in shape from `host-exporters.test.ts`.
 */
function fakeSandbox(recordRanSource: (source: string) => void) {
  let ctx: unknown;
  return {
    setGlobal: async (name: string, value: unknown) => {
      if (name === '__ifclite_ctx__') ctx = value;
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

/** A single fixture extension declaring one command, wired the loader's way. */
function fixture(options: { handlerSource?: string; enabled?: boolean } = {}) {
  const fired: string[] = [];
  const files = new Map<string, BundleFile>([
    [HANDLER_PATH, bundleFile(HANDLER_PATH, options.handlerSource ?? 'function run() { return "ran-demo"; }')],
  ]);
  const bundle: Bundle = { manifest: manifestFor('demo', HANDLER_PATH), files };
  const sandbox = fakeSandbox(() => {});

  const deps: RunCommandDeps = {
    storage: {
      listExtensions: async () => [installedRecord('demo', { enabled: options.enabled ?? true })],
    },
    loader: { getBundle: (id: string) => (id === 'demo' ? bundle : undefined) },
    runtime: {
      activate: async () => activationRecord('demo', sandbox),
      deactivate: async () => {},
    },
    dispatcher: { fire: async (event) => { fired.push(event); return []; } },
    sdk: { marker: 'bim-context' },
  };

  return { deps, fired };
}

/**
 * Two enabled extensions, `ext-a` and `ext-b`, BOTH declaring `COMMAND_ID`,
 * each with its own handler file returning a distinguishable value. Storage
 * order is `[ext-a, ext-b]`, so the pre-fix first-match scan always returned
 * `ext-a`.
 */
function collidingFixture() {
  const activated: string[] = [];
  const bundles = new Map<string, Bundle>([
    ['ext-a', {
      manifest: manifestFor('ext-a', 'commands/a.js'),
      files: new Map([['commands/a.js', bundleFile('commands/a.js', 'function run() { return "from-a"; }')]]),
    }],
    ['ext-b', {
      manifest: manifestFor('ext-b', 'commands/b.js'),
      files: new Map([['commands/b.js', bundleFile('commands/b.js', 'function run() { return "from-b"; }')]]),
    }],
  ]);
  const sandbox = fakeSandbox(() => {});

  const deps: RunCommandDeps = {
    storage: {
      listExtensions: async () => [installedRecord('ext-a'), installedRecord('ext-b')],
    },
    loader: { getBundle: (id: string) => bundles.get(id) },
    runtime: {
      activate: async (extensionId: string) => {
        activated.push(extensionId);
        return activationRecord(extensionId, sandbox);
      },
      deactivate: async () => {},
    },
    dispatcher: { fire: async () => [] },
    sdk: { marker: 'bim-context' },
  };

  return { deps, activated };
}

describe('runExtensionCommand', () => {
  it('runs the declared handler and returns its value', async () => {
    const f = fixture();

    const result = await runExtensionCommand(f.deps, COMMAND_ID, 'demo');

    assert.equal(await result?.value, 'ran-demo');
  });

  it('fires onCommand:<id> so the extension can activate on it', async () => {
    const f = fixture();

    await runExtensionCommand(f.deps, COMMAND_ID, 'demo');

    assert.deepStrictEqual(f.fired, [`onCommand:${COMMAND_ID}`]);
  });

  // The confused deputy. Both extensions declare `ext.demo.check`; the
  // manifest validator permits that and nothing dedupes ids at install time.
  // Before `extensionId` was threaded through, storage order decided the
  // winner, so `ext-b`'s toolbar button ran `ext-a`'s handler.
  it('runs the extension named by extensionId, not the first owner of the id', async () => {
    const f = collidingFixture();

    const result = await runExtensionCommand(f.deps, COMMAND_ID, 'ext-b');

    assert.equal(await result?.value, 'from-b');
  });

  // Stronger than checking the return value: the other extension must not be
  // activated by the dispatch itself. Activation boots a sandbox, which is
  // observable side-effect territory even when the value came from the right
  // place.
  //
  // Scoped to `runExtensionCommand` on purpose, and this fixture's dispatcher
  // is a no-op stub. In production the callers fire `onCommand:<id>` BEFORE
  // calling this, and that event wakes every extension subscribed to it,
  // including a collider. So a colliding extension can still be ACTIVATED by a
  // click on someone else's button; what it can no longer do is RUN. Closing
  // that remaining wake-up means scoping activation events too, which is a
  // wider change than this one. (#1907 follow-up)
  it('does not activate the other extension when dispatching to a named one', async () => {
    const f = collidingFixture();

    await runExtensionCommand(f.deps, COMMAND_ID, 'ext-b');

    assert.deepStrictEqual(f.activated, ['ext-b']);
  });

  // Symmetry check: naming `ext-a` must reach `ext-a`. Without it, a fix that
  // simply reversed the scan order would pass the `ext-b` case above.
  it('runs ext-a when ext-a is named, so the pin is not just reversed order', async () => {
    const f = collidingFixture();

    const result = await runExtensionCommand(f.deps, COMMAND_ID, 'ext-a');

    assert.equal(await result?.value, 'from-a');
    assert.deepStrictEqual(f.activated, ['ext-a']);
  });

  it('throws naming the extension when it does not own the command', async () => {
    const f = fixture();

    await assert.rejects(
      () => runExtensionCommand(f.deps, COMMAND_ID, 'someone-else'),
      /Extension "someone-else" has no enabled, loaded command "ext\.demo\.check"/,
    );
  });

  // A disabled owner must fail, never silently hand the run to a different
  // enabled extension that happens to declare the same id.
  it('throws when the named extension is disabled', async () => {
    const f = fixture({ enabled: false });

    await assert.rejects(
      () => runExtensionCommand(f.deps, COMMAND_ID, 'demo'),
      /Extension "demo" has no enabled, loaded command "ext\.demo\.check"/,
    );
  });

  // The absent/disabled case with a live collision present: `ext-a` is enabled
  // and owns the id, so a fallback scan would have run it. It must not.
  it('throws rather than falling back when the named extension is disabled and another owns the id', async () => {
    const f = collidingFixture();
    const base = f.deps.storage.listExtensions;
    const deps: RunCommandDeps = {
      ...f.deps,
      storage: {
        listExtensions: async () =>
          (await base()).map((r) => (r.id === 'ext-b' ? { ...r, enabled: false } : r)),
      },
    };

    await assert.rejects(
      () => runExtensionCommand(deps, COMMAND_ID, 'ext-b'),
      /Extension "ext-b" has no enabled, loaded command/,
    );
    assert.deepStrictEqual(f.activated, [], 'no extension should have been activated');
  });

  it('throws when the handler file is missing from the bundle', async () => {
    const bundle: Bundle = { manifest: manifestFor('demo', HANDLER_PATH), files: new Map() };
    const sandbox = fakeSandbox(() => {});
    const deps: RunCommandDeps = {
      storage: { listExtensions: async () => [installedRecord('demo')] },
      loader: { getBundle: () => bundle },
      runtime: {
        activate: async () => activationRecord('demo', sandbox),
        deactivate: async () => {},
      },
      dispatcher: { fire: async () => [] },
      sdk: { marker: 'bim-context' },
    };

    await assert.rejects(
      () => runExtensionCommand(deps, COMMAND_ID, 'demo'),
      /missing from bundle demo/,
    );
  });
});
