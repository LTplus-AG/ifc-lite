/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  PLUGIN_API_VERSION,
  satisfiesCaretRange,
  type FileSourceProvider,
  type PluginContext,
  type PluginManifest,
  type PublicFetchInit,
  type SourceFile,
  type SourceTag,
} from '@ifc-lite/plugin-api';
import {
  applyRelay,
  fetchWithBoundedRetry,
  isAllowedHost,
  isHttpsUrl,
  validateRelayDeclaration,
} from './host-fetch';
import { createNamespacedStorage, createPrefixedLogger, sourcesDebugEnabled } from './host-storage';

// ============================================================================
// SourceHost — manages registered file-source providers and manufactures
// sandboxed PluginContext instances for each one.
//
// The host and every provider must agree on exactly one version of the
// contract. That constant, and the range check that compares against it,
// live in `@ifc-lite/plugin-api` — not here — so the host can never drift
// from what providers are written against. (The previous incarnation of this
// file kept its own `HOST_API_VERSION` constant and its own copy of the caret
// check; the two were free to disagree, which is exactly the bug this
// rewrite closes.)
// ============================================================================

/** Convenience re-export — see `@ifc-lite/plugin-api`'s `version.ts` for what this means and how it's compared. */
export { PLUGIN_API_VERSION };

export interface SourceHostOptions {
  onProviderError?: (provider: string, error: unknown) => void;
}

/** Why a provider failed to register — surfaced by `getRegistrationFailures()` so a panel can render "provider X failed to load: reason" instead of the app going blank. */
export interface ProviderRegistrationFailure {
  readonly provider: string;
  readonly reason: string;
}

export class SourceHost {
  private readonly providers = new Map<string, FileSourceProvider>();
  private readonly failures: ProviderRegistrationFailure[] = [];
  private readonly options: SourceHostOptions;

  constructor(options: SourceHostOptions = {}) {
    this.options = options;
  }

  /**
   * Registers a provider. Never throws: a bad manifest (version mismatch, an
   * undeclared relay, a duplicate name) is recorded as a registration
   * failure and logged, not raised — a provider bug or an operator forgetting
   * to update a package must not be able to take down the whole app. Callers
   * that want to know whether registration actually succeeded can check the
   * boolean return value or `getRegistrationFailures()`.
   */
  register(provider: FileSourceProvider): boolean {
    const name = provider.manifest.name;
    const reason = this.validate(provider);
    if (reason) {
      this.failures.push({ provider: name, reason });
      console.error(`[source-host] Failed to register provider "${name}": ${reason}`);
      try {
        this.options.onProviderError?.(name, new Error(reason));
      } catch (callbackError) {
        console.error(`[source-host] onProviderError callback threw for "${name}"`, callbackError);
      }
      return false;
    }

    this.providers.set(name, provider);
    return true;
  }

  /** Returns a human-readable failure reason, or `undefined` if `provider` may be registered. */
  private validate(provider: FileSourceProvider): string | undefined {
    const { manifest } = provider;
    if (this.providers.has(manifest.name)) {
      return `a provider named "${manifest.name}" is already registered`;
    }
    if (!satisfiesCaretRange(PLUGIN_API_VERSION, manifest.api)) {
      return (
        `requires host api "${manifest.api}", but this host implements "${PLUGIN_API_VERSION}"`
      );
    }
    const relay = manifest.permissions.relay;
    if (relay) {
      const relayError = validateRelayDeclaration(relay);
      if (relayError) return relayError;
    }
    return undefined;
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

  /** Providers that failed to register, in registration order. Render these in the sources panel so a stale/misconfigured provider is visible instead of silently absent. */
  getRegistrationFailures(): readonly ProviderRegistrationFailure[] {
    return this.failures;
  }

  createContext(
    manifest: PluginManifest,
    preferences: Record<string, string>,
  ): PluginContext {
    const { network: allowedDomains, publicNetwork, relay } = manifest.permissions;
    const publicAllowedDomains = publicNetwork ?? [];

    const wrappedFetch: typeof fetch = async (input, init) => {
      const originalRequest = input instanceof Request ? input : null;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url);

      if (!isHttpsUrl(parsed)) {
        throw new Error(
          `Source provider "${manifest.name}" attempted a non-https request to "${url}". ` +
          `Only https is permitted.`,
        );
      }
      if (!isAllowedHost(allowedDomains, parsed.hostname)) {
        throw new Error(
          `Source provider "${manifest.name}" is not allowed to contact ${parsed.hostname}. ` +
          `Allowed: ${allowedDomains.join(', ')}`,
        );
      }

      const relayedUrl = applyRelay(url, relay, window.location.origin);
      if (relayedUrl !== url && sourcesDebugEnabled()) {
        console.debug(`[source:${manifest.name}]`, 'Relay fetch', {
          upstreamUrl: url,
          relayUrl: relayedUrl,
        });
      }

      let finalInit: RequestInit = { ...init };
      if (originalRequest) {
        finalInit = {
          method: originalRequest.method,
          headers: originalRequest.headers,
          signal: originalRequest.signal,
          ...init,
        };
        if (originalRequest.method !== 'GET' && originalRequest.method !== 'HEAD') {
          finalInit.body = await originalRequest.clone().arrayBuffer();
        }
      }
      // Never let a source provider's fetch silently follow a redirect off the
      // permission-checked host — a compromised/malicious endpoint could 302
      // to an arbitrary origin and exfiltrate the request (headers, API key).
      finalInit.redirect = 'error';
      // Always omit ambient credentials, regardless of what the caller asked
      // for: the relay makes this request same-origin, so the browser's
      // default would attach the app's own session cookies and send them to
      // a third-party API.
      finalInit.credentials = 'omit';

      const signal = finalInit.signal ?? undefined;
      return fetchWithBoundedRetry(() => fetch(relayedUrl, finalInit), signal);
    };

    const fetchPublic = async (url: string, init: PublicFetchInit = {}): Promise<Response> => {
      const parsed = new URL(url);

      if (!isHttpsUrl(parsed)) {
        throw new Error(
          `Source provider "${manifest.name}" attempted a non-https public fetch to "${url}". ` +
          `Only https is permitted.`,
        );
      }
      if (!isAllowedHost(publicAllowedDomains, parsed.hostname)) {
        throw new Error(
          `Source provider "${manifest.name}" is not allowed to fetch public URLs on ${parsed.hostname}. ` +
          `Allowed (permissions.publicNetwork): ${publicAllowedDomains.length ? publicAllowedDomains.join(', ') : '(none declared)'}`,
        );
      }

      // Every header this request will ever carry — nothing from the
      // caller's environment leaks in, so a provider cannot use this path to
      // smuggle a credential to a host outside `permissions.network`.
      const headers: Record<string, string> = { Accept: '*/*' };
      if (init.range) headers.Range = init.range;

      return fetch(url, {
        headers,
        credentials: 'omit',
        redirect: 'follow', // pre-signed URLs commonly bounce (e.g. to a CDN edge)
        signal: init.signal,
      });
    };

    return {
      fetch: wrappedFetch,
      fetchPublic,
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

// Re-exported so callers (and tests) can gate their own debug logging the
// same way the host does, from a single import.
export { sourcesDebugEnabled } from './host-storage';
