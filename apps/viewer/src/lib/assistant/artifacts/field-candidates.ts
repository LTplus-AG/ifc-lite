/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ambiguity: a property or quantity a proposal names either exists exactly
 * (same kind, same set name, same property name, case included) on at least
 * one loaded element, or it is unresolved. An unresolved name is never
 * guessed: the review lists candidates the loaded models really carry, ranked
 * by name similarity and then by how many elements carry them, and the user
 * picks one (or asks again). A case-only or spacing-only difference is still a
 * candidate, not a silent match, because engines differ on case.
 */

import { fieldKey, type FieldName, type FieldSite } from './field-refs';
import type { FieldPresence, ModelSchemaIndex } from './model-schema';

export interface FieldCandidate extends FieldPresence { score: number }

export type FieldResolution =
  | { status: 'exact'; site: FieldSite; presence: FieldPresence }
  | { status: 'unresolved'; site: FieldSite; candidates: FieldCandidate[] };

export const CANDIDATE_LIMIT = 6;
const MIN_SCORE = 0.35;

const fold = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Sørensen–Dice over letter pairs of the folded text: 1 for equal, 0 for nothing shared. */
export function similarity(a: string, b: string): number {
  const x = fold(a);
  const y = fold(b);
  if (x === y) return x.length > 0 ? 1 : 0;
  if (x.length < 2 || y.length < 2) return 0;
  const pairs = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) pairs.set(x.slice(i, i + 2), (pairs.get(x.slice(i, i + 2)) ?? 0) + 1);
  let shared = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const pair = y.slice(i, i + 2);
    const left = pairs.get(pair) ?? 0;
    if (left > 0) { shared += 1; pairs.set(pair, left - 1); }
  }
  return (2 * shared) / (x.length + y.length - 2);
}

/** The property name weighs most; the set name breaks ties between same-named properties. */
function score(wanted: FieldName, found: FieldPresence): number {
  const name = similarity(wanted.name, found.name);
  const contains = fold(found.name).includes(fold(wanted.name)) || fold(wanted.name).includes(fold(found.name));
  return 0.75 * Math.max(name, contains ? 0.7 : 0) + 0.25 * similarity(wanted.set, found.set);
}

export function rankCandidates(wanted: FieldName, index: ModelSchemaIndex): FieldCandidate[] {
  const out: FieldCandidate[] = [];
  for (const presence of index.fields.values()) {
    if (presence.kind !== wanted.kind) continue;
    const value = score(wanted, presence);
    if (value >= MIN_SCORE) out.push({ ...presence, score: value });
  }
  out.sort((a, b) => b.score - a.score || b.count - a.count || a.set.localeCompare(b.set) || a.name.localeCompare(b.name));
  return out.slice(0, CANDIDATE_LIMIT);
}

export function resolveFields(sites: readonly FieldSite[], index: ModelSchemaIndex): FieldResolution[] {
  return sites.map((site) => {
    const presence = index.fields.get(fieldKey(site));
    return presence ? { status: 'exact', site, presence } : { status: 'unresolved', site, candidates: rankCandidates(site, index) };
  });
}
