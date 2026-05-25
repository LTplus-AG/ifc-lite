/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Saved-scripts → starter-flavor migration.
 *
 * Users who already have saved scripts in the existing `savedScripts`
 * store get a one-time offer (P3.T15) to promote them into a starter
 * flavor named "My scripts." Each saved script becomes a minimal
 * extension contributing one command + one toolbar button.
 *
 * The migration is pure data shaping — it produces a `Flavor` value
 * + a map of extension bundle hashes/sources for the host to install.
 * The host owns the IDB / sandbox lifecycle; this module is testable
 * in isolation.
 *
 * Spec: docs/architecture/ai-customization/05-flavors-and-sharing.md §12.
 */

import { inferCapabilities } from '../inference/capability.js';
import type { Flavor, FlavorExtension } from './types.js';

export interface SavedScript {
  id: string;
  name: string;
  /** Raw script source. */
  code: string;
  /** Optional ISO timestamp. Defaults to now. */
  createdAt?: string;
}

export interface MigrationResult {
  flavor: Flavor;
  /**
   * Synthesised extension descriptors for the host to register. Each
   * carries the manifest + source map; the host packs them into
   * `.iflx` bytes and writes them to storage.
   */
  extensions: SyntheticExtension[];
  /** Scripts that failed inference / wrapping — preserved as-is. */
  skipped: Array<{ id: string; reason: string }>;
}

export interface SyntheticExtension {
  id: string;
  version: '0.1.0';
  /** Full manifest for the synthetic extension. */
  manifest: unknown;
  /** Files map: `manifest.json` + `src/commands/<id>.js`. */
  files: Record<string, string>;
  /** Capabilities inferred from the source. */
  capabilities: string[];
}

/**
 * Migrate an array of saved scripts into a starter Flavor.
 *
 * The resulting Flavor has one extension per script. The host is
 * responsible for packing each `SyntheticExtension` into a `.iflx`
 * bundle, computing the hash, and writing the entry to its
 * `ExtensionStorage`.
 */
export function migrateSavedScripts(
  scripts: readonly SavedScript[],
  opts: { flavorId?: string; now?: () => Date; namespace?: string } = {},
): MigrationResult {
  const flavorId = opts.flavorId ?? 'flv.my-scripts';
  const now = opts.now ?? (() => new Date());
  const namespace = opts.namespace ?? 'com.local.my-scripts';
  const nowIso = now().toISOString();

  const extensions: SyntheticExtension[] = [];
  const flavorExtensions: FlavorExtension[] = [];
  const skipped: MigrationResult['skipped'] = [];

  for (const script of scripts) {
    const slug = toSlug(script.id);
    const extId = `${namespace}.${slug}`;
    const inference = inferCapabilities(script.code);
    if (inference.parseErrors.length > 0) {
      skipped.push({ id: script.id, reason: inference.parseErrors[0].message });
      continue;
    }
    const caps = inference.capabilities.length > 0
      ? inference.capabilities
      : ['model.read'];
    const commandId = `${extId}.run`;
    const wrapped = wrapScriptAsCommand(script.code);
    const manifest = {
      manifestVersion: 1,
      id: extId,
      name: script.name,
      description: `Migrated from saved script "${script.name}".`,
      version: '0.1.0',
      engines: { ifcLiteSdk: '>=2.0.0' },
      capabilities: caps,
      activation: [`onCommand:${commandId}`],
      contributes: {
        commands: [{ id: commandId, title: script.name }],
        toolbar: [{ command: commandId, slot: 'toolbar.right' as const }],
      },
      entry: {
        commands: { [commandId]: 'src/commands/run.js' },
      },
    };

    extensions.push({
      id: extId,
      version: '0.1.0',
      manifest,
      files: {
        'manifest.json': JSON.stringify(manifest, null, 2),
        'src/commands/run.js': wrapped,
      },
      capabilities: caps,
    });

    flavorExtensions.push({
      id: extId,
      version: '0.1.0',
      bundleHash: '0'.repeat(64), // host fills this in after packing
      grantedCapabilities: caps,
      enabled: true,
      installedAt: script.createdAt ?? nowIso,
      source: 'local',
    } as FlavorExtension & { installedAt: string });
  }

  const flavor: Flavor = {
    schemaVersion: 1,
    id: flavorId,
    name: 'My scripts',
    description: `Migrated ${extensions.length} saved script(s) into reusable tools.`,
    createdAt: nowIso,
    updatedAt: nowIso,
    extensions: flavorExtensions,
    lenses: [],
    savedQueries: [],
    keybindings: [],
    layout: { state: {} },
    settings: {},
  };

  return { flavor, extensions, skipped };
}

const SLUG_RE = /[^a-z0-9]+/g;

function toSlug(id: string): string {
  return id
    .toLowerCase()
    .replace(SLUG_RE, '-')
    .replace(/^-+|-+$/g, '')
    || `script-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Wrap a user script so it runs inside the extension's command-handler
 * convention. The script body becomes the function body; `ctx` is
 * passed through so `ctx.bim` is available.
 */
function wrapScriptAsCommand(source: string): string {
  return `/* Migrated from a saved script. */
async function run(ctx) {
  const bim = ctx.bim;
  ${source.trim().split('\n').map((line) => `  ${line}`).join('\n')}
}
`;
}
