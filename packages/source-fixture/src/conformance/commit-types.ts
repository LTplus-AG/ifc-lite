/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CommitPayloadFormat, PluginContext } from '@ifc-lite/plugin-api';

/**
 * Known-good coordinates the commit suite exercises a provider against.
 *
 * Nothing here is discovered: as with {@link ConformanceFixtures}, the caller
 * supplies ids that genuinely exist in whatever backs the provider. A
 * conformance run that guessed its own inputs would pass by finding nothing.
 */
export interface CommitConformanceFixtures {
  readonly projectId: string;
  /** A model with at least TWO commits, so an ancestor diff has something to compare. */
  readonly modelId: string;
  /**
   * An element key present in that model's head commit, for the element-history
   * checks. Omit to skip them (a provider may declare `elementHistory: false`).
   */
  readonly elementKey?: string;
  /**
   * A project the caller may WRITE to. Omit to skip the write checks even on a
   * provider declaring `write: true` — a conformance run pointed at a real
   * tenant should not create models in it unless told where.
   */
  readonly writableProjectId?: string;
  /** A model in `writableProjectId` a test commit may be appended to. */
  readonly writableModelId?: string;
}

export interface CommitConformanceOptions {
  readonly createContext: () => PluginContext;
  readonly fixtures: CommitConformanceFixtures;
  /**
   * Page size small enough to force a real page boundary over
   * `fixtures.modelId`'s commits. Default `1`.
   */
  readonly smallPageLimit?: number;
  /**
   * A format the provider does NOT serve, used to prove `loadCommit` throws
   * `unsupported-format` rather than quietly substituting one it does.
   * Defaults to the first declared format this provider is missing; the check
   * is skipped when it serves all of them.
   */
  readonly unsupportedFormat?: CommitPayloadFormat;
}

export const ALL_PAYLOAD_FORMATS: readonly CommitPayloadFormat[] = [
  'ifc-step',
  'ifc-zip',
  'ifcx',
  'ifc-lite-cache',
];
