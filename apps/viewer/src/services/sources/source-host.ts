/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  FileSourceProvider,
  PluginContext,
  PluginManifest,
  KeyValueStore,
  Logger,
  SourceTag,
} from '@ifc-lite/plugin-api';

// ---------------------------------------------------------------------------
// SourceHost — manages registered file-source providers and manufactures
// sandboxed PluginContext instances for each one.
// ---------------------------------------------------------------------------

export interface SourceHostOptions {
  onProviderError?: (provider: string, error: unknown) => void;
}

export class SourceHost {
  private readonly providers = new Map<string, FileSourceProvider>();
  private readonly options: SourceHostOptions;

  constructor(options: SourceHostOptions = {}) {
    this.options = options;
  }

  register(provider: FileSourceProvider): void {
    const name = provider.manifest.name;
    if (this.providers.has(name)) {
      throw new Error(`Source provider "${name}" is already registered`);
    }
    this.providers.set(name, provider);
  }

  unregister(name: string): void {
    this.providers.delete(name);
  }

  get(name: string): FileSourceProvider | undefined {
    return this.providers.get(name);
  }

  list(): FileSourceProvider[] {
    return [...this.providers.values()];
  }

  createContext(
    manifest: PluginManifest,
    preferences: Record<string, string>,
  ): PluginContext {
    const allowedDomains = new Set(manifest.permissions.network);
    const proxyUrl = preferences['proxyUrl'];

    const wrappedFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url);

      if (!allowedDomains.has(parsed.hostname)) {
        throw new Error(
          `Source provider "${manifest.name}" is not allowed to contact ${parsed.hostname}. ` +
          `Allowed: ${[...allowedDomains].join(', ')}`,
        );
      }

      if (proxyUrl) {
        const relayUrl = `${proxyUrl.replace(/\/$/, '')}/relay?url=${encodeURIComponent(url)}`;
        return fetch(relayUrl, init);
      }

      return fetch(url, init);
    };

    return {
      fetch: wrappedFetch,
      getPreference: async (name: string) => preferences[name],
      storage: createNamespacedStorage(manifest.name),
      log: createPrefixedLogger(manifest.name),
    };
  }

  createSourceTag(
    provider: string,
    projectId: string,
    containerId: string,
    fileId: string,
    revisionId: string,
  ): SourceTag {
    return { provider, projectId, containerId, fileId, revisionId, loadedAt: Date.now() };
  }
}

// ---------------------------------------------------------------------------
// Namespaced IndexedDB storage
// ---------------------------------------------------------------------------

function createNamespacedStorage(namespace: string): KeyValueStore {
  const prefix = `ifc-lite-source:${namespace}:`;

  return {
    async get(key: string) {
      return localStorage.getItem(prefix + key) ?? undefined;
    },
    async set(key: string, value: string) {
      localStorage.setItem(prefix + key, value);
    },
    async delete(key: string) {
      localStorage.removeItem(prefix + key);
    },
    async keys() {
      const result: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(prefix)) {
          result.push(k.slice(prefix.length));
        }
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Prefixed logger
// ---------------------------------------------------------------------------

function createPrefixedLogger(name: string): Logger {
  const tag = `[source:${name}]`;
  return {
    debug: (...args: unknown[]) => console.debug(tag, ...args),
    info: (...args: unknown[]) => console.info(tag, ...args),
    warn: (...args: unknown[]) => console.warn(tag, ...args),
    error: (...args: unknown[]) => console.error(tag, ...args),
  };
}
