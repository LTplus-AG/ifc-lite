/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { KeyValueStore, Logger } from '@ifc-lite/plugin-api';

// ---------------------------------------------------------------------------
// Namespaced localStorage-backed key-value store, per provider.
//
// `localStorage` is synchronous and can throw (most commonly
// `QuotaExceededError`, but also in locked-down/private-browsing contexts
// where ANY access — reads included — throws a SecurityError). Every accessor
// degrades to an in-memory fallback rather than throwing out of a provider's
// `ctx.storage.*` call, so a key that only ever made it to the fallback still
// round-trips for the rest of the session. Values are user-revocable
// (clearing site data drops them), not securely encrypted — see
// `PluginContext.storage`'s doc comment.
// ---------------------------------------------------------------------------

export function createNamespacedStorage(namespace: string): KeyValueStore {
  const prefix = `ifc-lite-source:${namespace}:`;
  const memoryFallback = new Map<string, string>();
  const warnBlocked = (operation: string, error: unknown) => {
    console.warn(
      `[source:${namespace}] localStorage.${operation} failed (blocked or quota exceeded?); ` +
      'falling back to in-memory storage for this session',
      error,
    );
  };

  return {
    async get(key: string) {
      try {
        const stored = localStorage.getItem(prefix + key);
        if (stored !== null) return stored;
      } catch (error) {
        warnBlocked('getItem', error);
      }
      return memoryFallback.get(key);
    },
    async set(key: string, value: string) {
      try {
        localStorage.setItem(prefix + key, value);
        memoryFallback.delete(key); // a later successful write supersedes an earlier fallback
      } catch (error) {
        warnBlocked('setItem', error);
        memoryFallback.set(key, value);
      }
    },
    async delete(key: string) {
      memoryFallback.delete(key);
      try {
        localStorage.removeItem(prefix + key);
      } catch (error) {
        warnBlocked('removeItem', error);
      }
    },
    async keys() {
      const result = new Set<string>(memoryFallback.keys());
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k?.startsWith(prefix)) result.add(k.slice(prefix.length));
        }
      } catch (error) {
        warnBlocked('key', error);
      }
      return [...result];
    },
  };
}

// ---------------------------------------------------------------------------
// Prefixed, debug-gated logger
// ---------------------------------------------------------------------------

/** Set `localStorage.IFC_SOURCES_DEBUG = '1'` in the browser to log verbose
 *  source-provider activity (request URLs, project/folder listings) to the
 *  console. Off by default — providers can log per-row details on every
 *  list call, which is too chatty to leave on unconditionally. */
export const sourcesDebugEnabled = (): boolean => {
  if (typeof window === 'undefined') return false;
  try { return window.localStorage?.getItem('IFC_SOURCES_DEBUG') === '1'; }
  catch { return false; }
};

export function createPrefixedLogger(name: string): Logger {
  const tag = `[source:${name}]`;
  return {
    debug: (...args: unknown[]) => { if (sourcesDebugEnabled()) console.debug(tag, ...args); },
    info: (...args: unknown[]) => { if (sourcesDebugEnabled()) console.info(tag, ...args); },
    warn: (...args: unknown[]) => console.warn(tag, ...args),
    error: (...args: unknown[]) => console.error(tag, ...args),
  };
}
