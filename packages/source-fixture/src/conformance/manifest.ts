/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { PLUGIN_API_VERSION, satisfiesCaretRange } from '@ifc-lite/plugin-api';
import type { FileSourceProvider } from '@ifc-lite/plugin-api';

import { isValidHostPattern } from './host-pattern.js';

/** Every manifest-shape check that doesn't require calling the provider. */
export function describeManifestConformance(provider: FileSourceProvider): void {
  describe('manifest', () => {
    it('declares an api range the reference host version satisfies', () => {
      expect(satisfiesCaretRange(PLUGIN_API_VERSION, provider.manifest.api)).toBe(true);
    });

    it('declares well-formed capabilities', () => {
      const caps = provider.manifest.capabilities;
      expect(caps).toBeDefined();
      expect(caps.containerListing === 'direct-children' || caps.containerListing === 'flat-subtree').toBe(true);
      expect(typeof caps.listFilesIsRecursive).toBe('boolean');
      expect(typeof caps.revisionHistory).toBe('boolean');
      expect(typeof caps.downloadHistoricalRevisions).toBe('boolean');
      expect(typeof caps.changeDetection).toBe('boolean');
      expect(typeof caps.search).toBe('boolean');
    });

    it('implements SourceAuth when, and only when, auth is interactive', () => {
      if (provider.manifest.auth === 'interactive') {
        expect(provider.auth, 'auth: "interactive" but provider.auth is missing').toBeDefined();
        expect(typeof provider.auth?.restore).toBe('function');
        expect(typeof provider.auth?.signIn).toBe('function');
        expect(typeof provider.auth?.signOut).toBe('function');
        expect(typeof provider.auth?.getIdentity).toBe('function');
      } else {
        expect(provider.auth, 'auth: "preferences" but provider.auth is set').toBeUndefined();
      }
    });

    it('declares a well-formed relay when present', () => {
      const relay = provider.manifest.permissions.relay;
      if (!relay) return;
      expect(relay.upstream.length).toBeGreaterThan(0);
      expect(relay.path.length).toBeGreaterThan(0);
    });

    it('declares only valid host patterns in permissions.network', () => {
      for (const host of provider.manifest.permissions.network) {
        expect(isValidHostPattern(host), `invalid host pattern: ${host}`).toBe(true);
      }
    });

    it('declares only valid host patterns in permissions.publicNetwork', () => {
      for (const host of provider.manifest.permissions.publicNetwork ?? []) {
        expect(isValidHostPattern(host), `invalid host pattern: ${host}`).toBe(true);
      }
    });
  });
}
