/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// A reusable conformance test kit for `FileSourceProvider` implementations.
//
// Its only non-dev dependency is `@ifc-lite/plugin-api` (types only) and
// `vitest`'s `describe`/`it`/`expect` — deliberately framework-agnostic
// beyond that, so any provider package (Dalux, Microsoft Graph, ...) can run
// it against its own mocked provider without pulling in the fixture's data
// model or any test-only surface of this package.
//
// Usage: call `runConformanceSuite(provider, options)` from inside a
// `describe` block (or at the top of a test file) with known-good ids that
// genuinely exist for the provider under test.
// ============================================================================

import { describe } from 'vitest';
import type { FileSourceProvider } from '@ifc-lite/plugin-api';

import { describeContainerListingConformance } from './containers.js';
import { describeDownloadConformance } from './download.js';
import { describeFileConformance } from './files.js';
import { describeManifestConformance } from './manifest.js';
import { describeOptionalMethodConformance } from './optional-methods.js';
import { describePagingConformance } from './paging.js';
import type { ConformanceOptions } from './types.js';
import { describeWatchRevisionsConformance } from './watch.js';

export type { ConformanceFileRef, ConformanceFixtures, ConformanceOptions } from './types.js';

/**
 * Registers the full conformance suite as vitest `describe`/`it` blocks.
 * Call it directly inside a test file — it does not itself call
 * `describe.skip`/`only`, so it composes normally with the surrounding file.
 */
export function runConformanceSuite(provider: FileSourceProvider, options: ConformanceOptions): void {
  const { createContext, fixtures, smallPageLimit = 1 } = options;

  describe('FileSourceProvider conformance', () => {
    describeManifestConformance(provider);
    describeOptionalMethodConformance(provider);
    describeContainerListingConformance(provider, createContext, fixtures);
    describeFileConformance(provider, createContext, fixtures);
    describePagingConformance(provider, createContext, fixtures, smallPageLimit);
    describeDownloadConformance(provider, createContext, fixtures);
    describeWatchRevisionsConformance(provider, createContext, fixtures);
  });
}
