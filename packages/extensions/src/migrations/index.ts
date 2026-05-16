/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Manifest migration chain.
 *
 * Each entry takes a manifest at version N and returns the equivalent
 * manifest at version N+1. The chain is applied in declaration order
 * until the manifest reaches the current schema version.
 *
 * Newer manifests than this loader supports are rejected by the bundle
 * loader; only forward (older → newer) migration is automated.
 *
 * Spec: docs/architecture/ai-customization/01-extension-model.md §1.3.
 */

import type { ValidationResult } from '../types.js';
import { migrateV1 } from './v1.js';

export interface MigrationEntry {
  /** The schema version this migration consumes (input). */
  fromVersion: number;
  /** Produces this schema version on success (output). */
  toVersion: number;
  /** Migration function. Returns the new manifest or structured errors. */
  apply: (input: Record<string, unknown>) => ValidationResult<Record<string, unknown>>;
}

/** The current manifest schema version this loader supports. */
export const CURRENT_MANIFEST_VERSION = 1;

const CHAIN: readonly MigrationEntry[] = [
  // No entries yet; v1 is the current schema. The `migrateV1` function is
  // a no-op placeholder that proves the chain wiring works end-to-end.
];

/**
 * Run the migration chain to bring the manifest up to the current schema
 * version. If the input is already at the current version, returns it
 * unchanged. Returns errors if migration fails or if the input is from
 * a future version we do not understand.
 */
export function migrateManifest(
  input: Record<string, unknown>,
): ValidationResult<Record<string, unknown>> {
  const rawVersion = input.manifestVersion;
  if (typeof rawVersion !== 'number') {
    return {
      ok: false,
      errors: [{
        path: 'manifestVersion',
        code: 'invalid_manifest_version',
        message: 'manifestVersion is required and must be a number.',
      }],
    };
  }

  if (rawVersion > CURRENT_MANIFEST_VERSION) {
    return {
      ok: false,
      errors: [{
        path: 'manifestVersion',
        code: 'invalid_manifest_version',
        message: `Manifest version ${rawVersion} is newer than this loader supports (v${CURRENT_MANIFEST_VERSION}).`,
        hint: 'Update IFClite to a newer version, or downgrade the manifest.',
      }],
    };
  }

  let current: Record<string, unknown> = input;
  let currentVersion = rawVersion;
  let safety = 0;
  while (currentVersion < CURRENT_MANIFEST_VERSION) {
    if (safety > 32) {
      return {
        ok: false,
        errors: [{
          path: '',
          code: 'invalid_manifest_version',
          message: 'Manifest migration chain exceeded safety limit (possible cycle).',
        }],
      };
    }
    safety += 1;
    const next = CHAIN.find((m) => m.fromVersion === currentVersion);
    if (!next) {
      return {
        ok: false,
        errors: [{
          path: 'manifestVersion',
          code: 'invalid_manifest_version',
          message: `No migration available from v${currentVersion} to v${CURRENT_MANIFEST_VERSION}.`,
        }],
      };
    }
    const result = next.apply(current);
    if (!result.ok) return result;
    current = result.value;
    currentVersion = next.toVersion;
  }

  return { ok: true, value: current };
}

// Re-export individual migrations for tests / future chain composition.
export { migrateV1 };
