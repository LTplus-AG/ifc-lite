/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { FileSourceProvider } from '@ifc-lite/plugin-api';

/** Every optional method must be present exactly when its capability flag says it is. */
export function describeOptionalMethodConformance(provider: FileSourceProvider): void {
  describe('optional methods match declared capabilities', () => {
    it('listRevisions is present iff capabilities.revisionHistory', () => {
      expect(typeof provider.listRevisions === 'function').toBe(provider.manifest.capabilities.revisionHistory);
    });

    it('watchRevisions is present iff capabilities.changeDetection', () => {
      expect(typeof provider.watchRevisions === 'function').toBe(provider.manifest.capabilities.changeDetection);
    });

    it('searchFiles is present iff capabilities.search', () => {
      expect(typeof provider.searchFiles === 'function').toBe(provider.manifest.capabilities.search);
    });
  });
}
