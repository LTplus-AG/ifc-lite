/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useState } from 'react';
import type { FileSourceProvider, SourceIdentity } from '@ifc-lite/plugin-api';
import type { SourceHost } from '@/services/sources/source-host';
import { loadResolvedSourcePrefs } from '@/lib/sources/preferences';

export type SourceAuthStatus =
  /** Provider does not use interactive auth. */
  | 'not-interactive'
  /** Silent `restore()` is running. */
  | 'restoring'
  | 'signed-in'
  | 'signed-out'
  /** Interactive sign-in/out in progress. */
  | 'busy';

export interface SourceAuthState {
  readonly status: SourceAuthStatus;
  readonly identity: SourceIdentity | null;
  /** A gentle prompt ("Please sign in again."), never a hard error. */
  readonly notice: string | null;
  readonly signIn: () => void;
  readonly signOut: () => void;
}

/**
 * Drives a provider's `SourceAuth` for the panel UI. `restore()` runs
 * silently on mount; a failed silent refresh surfaces as "sign in again",
 * never as an error. `signIn()` is synchronous up to the provider call so it
 * can open a popup from the user gesture that invoked it — no awaits may
 * ever be inserted before the `auth.signIn(ctx)` call.
 */
export function useSourceAuth(provider: FileSourceProvider, sourceHost: SourceHost): SourceAuthState {
  const interactive = provider.manifest.auth === 'interactive' && provider.auth !== undefined;
  const [status, setStatus] = useState<SourceAuthStatus>(interactive ? 'restoring' : 'not-interactive');
  const [identity, setIdentity] = useState<SourceIdentity | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!interactive) return;
    const auth = provider.auth;
    if (!auth) return;
    let cancelled = false;

    setStatus('restoring');
    const ctx = sourceHost.createContext(provider.manifest, loadResolvedSourcePrefs(provider.manifest));
    void auth
      .restore(ctx)
      .then((restored) => {
        if (cancelled) return;
        setIdentity(restored);
        setStatus(restored ? 'signed-in' : 'signed-out');
        setNotice(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A failed silent refresh means the session is gone, not that the
        // provider is broken — degrade to signed-out with a prompt.
        console.warn(`[sources] Silent session restore failed for "${provider.manifest.name}"`, err);
        setIdentity(null);
        setStatus('signed-out');
        setNotice('Your session expired. Please sign in again.');
      });

    return () => {
      cancelled = true;
    };
  }, [interactive, provider, sourceHost]);

  const signIn = useCallback(() => {
    const auth = provider.auth;
    if (!auth) return;
    // Everything up to `auth.signIn(ctx)` must stay synchronous: the provider
    // may open a popup, and browsers only allow that inside a user gesture.
    const ctx = sourceHost.createContext(provider.manifest, loadResolvedSourcePrefs(provider.manifest));
    setStatus('busy');
    setNotice(null);
    auth
      .signIn(ctx)
      .then((signedIn) => {
        setIdentity(signedIn);
        setStatus('signed-in');
      })
      .catch((err: unknown) => {
        console.warn(`[sources] Sign-in failed for "${provider.manifest.name}"`, err);
        setIdentity(null);
        setStatus('signed-out');
        setNotice(err instanceof Error ? err.message : 'Sign-in failed. Please try again.');
      });
  }, [provider, sourceHost]);

  const signOut = useCallback(() => {
    const auth = provider.auth;
    if (!auth) return;
    const ctx = sourceHost.createContext(provider.manifest, loadResolvedSourcePrefs(provider.manifest));
    setStatus('busy');
    auth
      .signOut(ctx)
      .catch((err: unknown) => {
        console.warn(`[sources] Sign-out failed for "${provider.manifest.name}"`, err);
      })
      .finally(() => {
        setIdentity(null);
        setStatus('signed-out');
        setNotice(null);
      });
  }, [provider, sourceHost]);

  return { status, identity, notice, signIn, signOut };
}
