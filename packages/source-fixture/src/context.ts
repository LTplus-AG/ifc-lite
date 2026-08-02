/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { KeyValueStore, Logger, PluginContext } from '@ifc-lite/plugin-api';

export interface FixtureContextOverrides {
  /** Default: throws — the in-memory fixture never calls `ctx.fetch`. */
  readonly fetch?: PluginContext['fetch'];
  /** Default: throws — the in-memory fixture never calls `ctx.fetchPublic`. */
  readonly fetchPublic?: PluginContext['fetchPublic'];
  readonly preferences?: Readonly<Record<string, string>>;
  readonly log?: Partial<Logger>;
}

const unusedFetch: PluginContext['fetch'] = async () => {
  throw new Error('fixture PluginContext: ctx.fetch should never be called by an in-memory provider');
};

const unusedFetchPublic: PluginContext['fetchPublic'] = async () => {
  throw new Error('fixture PluginContext: ctx.fetchPublic should never be called by an in-memory provider');
};

/**
 * A minimal, fully in-memory `PluginContext` — `storage` is a real (per-
 * instance) key/value map so auth persistence and container/file location
 * caching behave like they would against the host's real store, `log` is a
 * no-op by default, and `fetch`/`fetchPublic` throw unless overridden, since
 * a conformant in-memory provider should never reach for either.
 *
 * Exported for reuse by any provider's own tests, not only the fixture's —
 * mocking a `PluginContext` from scratch in every provider package would
 * otherwise duplicate this same handful of lines.
 */
export function createFixtureContext(overrides: FixtureContextOverrides = {}): PluginContext {
  const store = new Map<string, string>();
  const storage: KeyValueStore = {
    async get(key) {
      return store.get(key);
    },
    async set(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async keys() {
      return [...store.keys()];
    },
  };
  const preferences = overrides.preferences ?? {};
  const log: Logger = {
    debug: overrides.log?.debug ?? (() => {}),
    info: overrides.log?.info ?? (() => {}),
    warn: overrides.log?.warn ?? (() => {}),
    error: overrides.log?.error ?? (() => {}),
  };
  return {
    fetch: overrides.fetch ?? unusedFetch,
    fetchPublic: overrides.fetchPublic ?? unusedFetchPublic,
    async getPreference(name: string) {
      // Own properties only. A plain object inherits from Object.prototype, so
      // an un-guarded lookup answers `getPreference('toString')` with a
      // function — a fixture used as the conformance oracle must not hand
      // providers something the real host never would.
      return Object.prototype.hasOwnProperty.call(preferences, name)
        ? preferences[name]
        : undefined;
    },
    storage,
    log,
  };
}
