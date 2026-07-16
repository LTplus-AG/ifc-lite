/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  FileSourceProvider,
  PluginContext,
  PluginManifest,
  KeyValueStore,
  Logger,
  SourceFile,
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
    const allowedDomains = manifest.permissions.network;

    const wrappedFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url);

      if (!isAllowedHost(allowedDomains, parsed.hostname)) {
        throw new Error(
          `Source provider "${manifest.name}" is not allowed to contact ${parsed.hostname}. ` +
          `Allowed: ${[...allowedDomains].join(', ')}`,
        );
      }

      const finalUrl = applyCorsRelay(url);
      if (finalUrl !== url) {
        console.debug(`[source:${manifest.name}]`, 'Relay fetch', {
          upstreamUrl: url,
          relayUrl: finalUrl,
        });
      }

      return fetch(finalUrl, init);
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
// Source download event — bridges a source provider's downloaded bytes to
// the viewer's federated-load pipeline without coupling the sources UI to
// viewer internals (ViewportContainer owns the listener).
// ---------------------------------------------------------------------------

export const SOURCE_DOWNLOAD_EVENT = 'ifc-lite:source-download';

export interface SourceDownloadItem {
  readonly name: string;
  readonly buffer: ArrayBuffer;
  readonly sourceFile: SourceFile;
  readonly tag: SourceTag;
}

export type SourceDownloadEvent = CustomEvent<{ items: SourceDownloadItem[] }>;

/** Dispatches every downloaded file in one event so the listener can load them as a single federated batch, sequentially (the WASM parser isn't thread-safe). */
export function dispatchSourceDownload(items: SourceDownloadItem[]): void {
  if (items.length === 0) return;
  window.dispatchEvent(
    new CustomEvent(SOURCE_DOWNLOAD_EVENT, { detail: { items } }) satisfies SourceDownloadEvent,
  );
}

// ---------------------------------------------------------------------------
// Built-in CORS relay — some source APIs (Dalux Build) don't send CORS
// headers, so a direct browser fetch fails the preflight. Rather than a
// user-facing "relay URL" preference, we route known hosts through a fixed
// same-origin path that the app's own server forwards upstream — the exact
// pattern already used for bSDD/EPSG (see apps/viewer/vite.config.ts's dev
// proxy and vercel.json's rewrites for the matching same-origin routes).
// The permission check above still runs against the real upstream host;
// this only changes where the browser physically sends the request.
// ---------------------------------------------------------------------------

const CORS_RELAY_ORIGINS: ReadonlyArray<readonly [string, string]> = [
  ['https://node1.field.dalux.com/service/api', '/api/dalux'],
];

function applyCorsRelay(url: string): string {
  for (const [upstreamOrigin, relayPath] of CORS_RELAY_ORIGINS) {
    if (url.startsWith(upstreamOrigin)) {
      return `${window.location.origin}${relayPath}${url.slice(upstreamOrigin.length)}`;
    }
  }
  return url;
}

function isAllowedHost(
  allowedDomains: readonly string[],
  hostname: string,
): boolean {
  const normalizedHost = hostname.toLowerCase();

  return allowedDomains.some((pattern) => {
    const normalizedPattern = pattern.toLowerCase();
    if (normalizedPattern.startsWith('*.')) {
      const suffix = normalizedPattern.slice(2);
      return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
    }
    return normalizedHost === normalizedPattern;
  });
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
