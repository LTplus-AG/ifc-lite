/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { PLUGIN_API_VERSION } from '@ifc-lite/plugin-api';
import type { PluginAuthKind, PluginManifest, ProviderCapabilities, RelayDeclaration } from '@ifc-lite/plugin-api';

export interface FixtureManifestOptions {
  readonly name?: string;
  readonly title?: string;
  /** Defaults to `^${PLUGIN_API_VERSION}` — the range the reference host always satisfies. */
  readonly apiRange?: string;
  /** Defaults to `['fixture.invalid']` — an RFC 2606 reserved, never-resolvable host. */
  readonly network?: readonly string[];
  readonly relay?: RelayDeclaration;
  readonly auth: PluginAuthKind;
  readonly capabilities: ProviderCapabilities;
}

/** Builds a well-formed `PluginManifest` for the fixture provider. */
export function buildFixtureManifest(options: FixtureManifestOptions): PluginManifest {
  return {
    name: options.name ?? 'fixture',
    title: options.title ?? 'Fixture Source',
    api: options.apiRange ?? `^${PLUGIN_API_VERSION}`,
    permissions: {
      network: options.network ?? ['fixture.invalid'],
      ...(options.relay ? { relay: options.relay } : {}),
    },
    auth: options.auth,
    preferences:
      options.auth === 'preferences'
        ? [
            {
              name: 'apiKey',
              title: 'API key',
              description: 'Fixture credential — any non-empty value is accepted.',
              type: 'password',
              required: true,
            },
          ]
        : [],
    capabilities: options.capabilities,
    contributes: { fileSources: ['./src/provider.ts'] },
  };
}
