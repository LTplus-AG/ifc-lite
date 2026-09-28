/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe } from 'vitest';
import type { FileSourceProvider } from '@ifc-lite/plugin-api';

import {
  describeElementHistoryConformance,
  describeFingerprintConformance,
  describeIdentityRecordConformance,
  describeStoredDiffConformance,
} from './commit-history.js';
import {
  describeCommitCapabilityConformance,
  describeCommitListingConformance,
  describeLoadCommitConformance,
} from './commit-reads.js';
import { ALL_PAYLOAD_FORMATS, type CommitConformanceOptions } from './commit-types.js';
import { describeCommitErrorConformance, describeCommitWriteConformance } from './commit-writes.js';

/**
 * Registers the commit-aware conformance suite (contract 2.1.0) as vitest
 * `describe`/`it` blocks.
 *
 * Separate from `runConformanceSuite` rather than folded into it: the 2.0.0
 * suite runs against every provider, and a provider that is not commit-aware
 * must not be made to look like it is skipping half a test run. Call both
 * from a commit-aware provider's test file.
 *
 * Every block past the capability check is gated on the flag that owns it, so
 * a provider declaring `storedDiffs: false` is not failed for a method it
 * correctly does not have.
 */
export function runCommitConformanceSuite(provider: FileSourceProvider, options: CommitConformanceOptions): void {
  const { createContext, fixtures, smallPageLimit = 1 } = options;
  const commits = provider.manifest.capabilities.commits;

  describe('commit-aware source conformance', () => {
    describeCommitCapabilityConformance(provider);

    if (!commits) return;

    const unsupportedFormat = options.unsupportedFormat
      ?? ALL_PAYLOAD_FORMATS.find((format) => !commits.payloadFormats.includes(format));

    describeCommitListingConformance(provider, createContext, fixtures, smallPageLimit);
    describeLoadCommitConformance(provider, createContext, fixtures, unsupportedFormat);
    describeCommitErrorConformance(provider, createContext, fixtures);

    if (commits.fingerprints) describeFingerprintConformance(provider, createContext, fixtures);
    if (commits.storedDiffs) describeStoredDiffConformance(provider, createContext, fixtures);
    if (commits.elementHistory && fixtures.elementKey !== undefined) {
      describeElementHistoryConformance(provider, createContext, fixtures);
    }
    if (commits.identityRecords) describeIdentityRecordConformance(provider, createContext, fixtures);
    if (commits.write && fixtures.writableProjectId !== undefined && fixtures.writableModelId !== undefined) {
      describeCommitWriteConformance(provider, createContext, fixtures);
    }
  });
}
