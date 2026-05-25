/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `usePrivacyDisclosure` — show the privacy disclosure once per browser.
 *
 * Fires a one-time toast on first launch after the extensions
 * subsystem (action log + miner) is alive. Persists the
 * acknowledgement under a localStorage flag so users only see the
 * disclosure once. The toast points at the Privacy panel for the
 * full controls.
 *
 * The disclosure is required by RFC §06 §7 — users must be told what
 * gets stored locally before the miner / memory loops start.
 */

import { useEffect } from 'react';
import { toast } from '@/components/ui/toast';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';

const STORAGE_KEY = 'ifclite.extensions.privacy-disclosure.v1';

export function usePrivacyDisclosure(): void {
  const host = useOptionalExtensionHost();
  useEffect(() => {
    if (!host) return;
    if (typeof window === 'undefined') return;
    try {
      if (window.localStorage.getItem(STORAGE_KEY)) return;
    } catch {
      // Privacy modes can block localStorage — skip silently.
      return;
    }
    // Defer slightly so the toast doesn't fight with the splash UI.
    const handle = window.setTimeout(() => {
      toast.info(
        'IFClite keeps a local, content-free action log to suggest one-click tools. Manage or delete it in Extensions → Privacy.',
      );
      try {
        window.localStorage.setItem(STORAGE_KEY, new Date().toISOString());
      } catch {
        // Best effort — re-firing on every load is annoying but not harmful.
      }
    }, 3500);
    return () => window.clearTimeout(handle);
  }, [host]);
}
