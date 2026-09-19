/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The lineage **sidecar** (issue #4955): a JSON artifact carrying lineage
 * entries for plain-file workflows, pinned to the content digest of BOTH
 * revisions they were derived from — the same discipline as the identity-map
 * sidecar, for the same reason: a bare list of key relations says nothing
 * about which two files a human looked at when accepting it.
 *
 * It differs from the identity-map sidecar in one rule, and the difference is
 * the point of the artifact: an identity map tolerates two `here`s on one
 * `base` (one of the two head entities may since have been deleted, and the
 * models can adjudicate), while a lineage is a DECIDED document — every key
 * appears in at most one entry on its side, because a `split` already binds
 * one base to k heads by design and a second entry about the same base would
 * be a second answer. `lineageConflicts` refuses that at parse and at create.
 */

import { lineageConflicts, type LineageEntry, type LineageRelation } from './lineage.js';
import {
  compareCodeUnits,
  normalizeModelIdentity,
  pinnedModelMismatches,
  validateCreated,
  validateKeyProperty,
  validateModelIdentity,
  type ModelIdentity,
} from './sidecar-common.js';

export const LINEAGE_SIDECAR_FORMAT = 'ifc-lite/lineage';
export const LINEAGE_SIDECAR_VERSION = 1;
/** A keyed lineage must use a version old readers reject; otherwise they can
 * silently interpret authored keys as GlobalIds. */
export const LINEAGE_SIDECAR_KEYED_VERSION = 2;

const RELATIONS: ReadonlySet<string> = new Set<LineageRelation>(['identity', 'split', 'merge', 'replaced']);

export interface LineageSidecar {
  format: typeof LINEAGE_SIDECAR_FORMAT;
  version: typeof LINEAGE_SIDECAR_VERSION | typeof LINEAGE_SIDECAR_KEYED_VERSION;
  base: ModelIdentity;
  head: ModelIdentity;
  created?: string;
  /** See `IdentityMapSidecar.keyProperty`; absent means GlobalId. */
  keyProperty?: string;
  /** Sorted by (first base key, first head key); every key in at most one entry per side. */
  entries: LineageEntry[];
  /**
   * Base keys the comparison left deleted with no lineage — sorted. A key in
   * neither this list nor any entry was matched by key and keeps its key on
   * rekey. See `Lineage` in `lineage.ts`.
   */
  deleted: string[];
}

export interface LineageSidecarInit {
  base: ModelIdentity;
  head: ModelIdentity;
  entries: readonly LineageEntry[];
  deleted?: readonly string[];
  created?: string;
  keyProperty?: string;
}

function normalizeEntry(entry: LineageEntry): LineageEntry {
  const normalized: LineageEntry = {
    base: [...entry.base],
    head: [...entry.head],
    relation: entry.relation,
    reason: entry.reason,
  };
  if (entry.shares) normalized.shares = [...entry.shares];
  return normalized;
}

function compareEntries(a: LineageEntry, b: LineageEntry): number {
  return (
    compareCodeUnits(a.base[0] ?? '', b.base[0] ?? '') ||
    compareCodeUnits(a.head[0] ?? '', b.head[0] ?? '')
  );
}

/**
 * Build a lineage sidecar: entries sorted and de-duplicated (an identical
 * entry arriving twice is not a conflict), then validated.
 *
 * @throws when the result is not a valid, conflict-free lineage.
 */
export function createLineageSidecar(init: LineageSidecarInit): LineageSidecar {
  const seen = new Set<string>();
  const entries: LineageEntry[] = [];
  for (const entry of init.entries) {
    const signature = `${entry.relation}\u0000${entry.base.join('\u0001')}\u0000${entry.head.join('\u0001')}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    entries.push(normalizeEntry(entry));
  }
  entries.sort(compareEntries);

  const sidecar: LineageSidecar = {
    format: LINEAGE_SIDECAR_FORMAT,
    version: init.keyProperty !== undefined ? LINEAGE_SIDECAR_KEYED_VERSION : LINEAGE_SIDECAR_VERSION,
    base: normalizeModelIdentity(init.base),
    head: normalizeModelIdentity(init.head),
    entries,
    deleted: [...new Set(init.deleted ?? [])].sort(compareCodeUnits),
  };
  if (init.created !== undefined) sidecar.created = init.created;
  if (init.keyProperty !== undefined) sidecar.keyProperty = init.keyProperty;

  const errors = validateLineageSidecar(sidecar);
  if (errors.length > 0) throw new Error(`Invalid lineage sidecar: ${errors.join('; ')}`);
  return sidecar;
}

export function serializeLineageSidecar(sidecar: LineageSidecar): string {
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

/** @throws with every structural problem listed; a half-read lineage is worse than none. */
export function parseLineageSidecar(text: string): LineageSidecar {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid lineage sidecar: not JSON (${(error as Error).message})`);
  }
  const errors = validateLineageSidecar(value);
  if (errors.length > 0) throw new Error(`Invalid lineage sidecar: ${errors.join('; ')}`);
  return value as LineageSidecar;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

function validateEntry(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'entries must be { base[], head[], relation, reason, shares? } objects';
  }
  const entry = value as Record<string, unknown>;
  if (!isStringList(entry.base) || !isStringList(entry.head)) {
    return 'entries must carry non-empty string lists for base and head';
  }
  if (entry.base.length === 0 || entry.head.length === 0) {
    return 'an entry must name at least one key on each side';
  }
  if (typeof entry.relation !== 'string' || !RELATIONS.has(entry.relation)) {
    return 'entries must carry a relation of identity | split | merge | replaced';
  }
  if (typeof entry.reason !== 'string') return 'entries must carry a string reason';
  const relation = entry.relation as LineageRelation;
  if ((relation === 'identity' || relation === 'replaced') && (entry.base.length !== 1 || entry.head.length !== 1)) {
    return `a ${relation} entry must be 1:1`;
  }
  if (relation === 'split' && entry.base.length !== 1) return 'a split entry must have exactly one base key';
  if (relation === 'merge' && entry.head.length !== 1) return 'a merge entry must have exactly one head key';
  if (entry.shares !== undefined) {
    const expected = relation === 'split' ? entry.head.length : relation === 'merge' ? entry.base.length : -1;
    if (
      !Array.isArray(entry.shares) ||
      entry.shares.length !== expected ||
      !entry.shares.every((share) => typeof share === 'number' && Number.isFinite(share) && share >= 0)
    ) {
      return 'shares must be one finite non-negative number per key on the k side of a split or merge';
    }
  }
  return undefined;
}

/** Structural validation of an untrusted value; empty means valid. */
export function validateLineageSidecar(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['sidecar must be an object'];
  }
  const errors: string[] = [];
  const sidecar = value as Record<string, unknown>;
  if (sidecar.format !== LINEAGE_SIDECAR_FORMAT) errors.push(`format must be "${LINEAGE_SIDECAR_FORMAT}"`);
  if (sidecar.version !== LINEAGE_SIDECAR_VERSION && sidecar.version !== LINEAGE_SIDECAR_KEYED_VERSION) {
    errors.push(`version must be ${LINEAGE_SIDECAR_VERSION} or ${LINEAGE_SIDECAR_KEYED_VERSION}`);
  } else if ((sidecar.keyProperty !== undefined) !== (sidecar.version === LINEAGE_SIDECAR_KEYED_VERSION)) {
    errors.push(`version ${LINEAGE_SIDECAR_KEYED_VERSION} requires keyProperty and version ${LINEAGE_SIDECAR_VERSION} forbids it`);
  }
  for (const side of ['base', 'head'] as const) errors.push(...validateModelIdentity(sidecar[side], side));
  errors.push(...validateCreated(sidecar.created));
  errors.push(...validateKeyProperty(sidecar.keyProperty));
  if (!Array.isArray(sidecar.entries)) {
    errors.push('entries must be an array');
  } else {
    let shaped = true;
    for (const entry of sidecar.entries) {
      const problem = validateEntry(entry);
      if (problem) {
        errors.push(problem);
        shaped = false;
        break;
      }
    }
    if (shaped) errors.push(...lineageConflicts(sidecar.entries as LineageEntry[]));
  }
  if (!isStringList(sidecar.deleted)) {
    errors.push('deleted must be a list of non-empty strings');
  } else if (Array.isArray(sidecar.entries)) {
    // A key cannot be both deleted and carried forward.
    const inEntries = new Set<string>();
    for (const entry of sidecar.entries as LineageEntry[]) {
      if (Array.isArray(entry?.base)) for (const key of entry.base) inEntries.add(key);
    }
    const both = sidecar.deleted.filter((key) => inEntries.has(key)).sort(compareCodeUnits);
    for (const key of both) errors.push(`deleted key "${key}" also appears in a lineage entry`);
  }
  return errors;
}

/** Digest and key-scheme check against the two files the lineage is about to be applied to. */
export function lineageSidecarMismatches(
  sidecar: LineageSidecar,
  models: { base: ModelIdentity; head: ModelIdentity; keyProperty?: string },
): string[] {
  return pinnedModelMismatches(sidecar, models, 'lineage');
}
