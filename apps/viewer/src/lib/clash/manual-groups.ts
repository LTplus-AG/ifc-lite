/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { clashReviewKey, type Clash } from '@ifc-lite/clash';

export interface ManualClashGroup {
  id: string;
  name: string;
  /** Durable identities, retained even when a narrower run omits them. */
  members: ManualClashMember[];
}

export interface ManualClashMember {
  /** Model-independent fallback that survives reloads and model revisions. */
  reviewKey: string;
  /** Model-qualified identity that distinguishes equal GUID pairs in one run. */
  occurrenceKey: string;
}

export interface ResolvedManualClashGroup {
  definition: ManualClashGroup;
  members: Clash[];
  /** Persisted records aligned one-for-one with `members`. */
  memberDefinitions: ManualClashMember[];
}

export type ManualGroupSaveResult =
  | { ok: true }
  | { ok: false; reason: 'quota' | 'serialize' | 'too_many'; message: string };

export const MANUAL_CLASH_GROUPS_KEY = 'ifc-lite-clash-manual-groups';
const SCHEMA_VERSION = 2;
const MAX_GROUPS = 200;
const MAX_MEMBERS_PER_GROUP = 2_000;
const MAX_NAME_LENGTH = 100;

function normalizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().slice(0, MAX_NAME_LENGTH);
  return name || null;
}

/**
 * Validate persisted data and enforce partition semantics: one clash belongs
 * to at most one manual group. Earlier groups win when corrupt input overlaps.
 */
export function normalizeManualClashGroups(raw: unknown): ManualClashGroup[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { groups?: unknown }).groups)
      ? (raw as { groups: unknown[] }).groups
      : [];
  const groups: ManualClashGroup[] = [];
  const groupIds = new Set<string>();
  const claimedOccurrences = new Set<string>();
  const claimedReviews = new Set<string>();
  const legacyReviewClaims = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = normalizeName(record.name);
    if (!id || !name || groupIds.has(id)) continue;
    const persistedMembers = Array.isArray(record.members)
      ? record.members
      : Array.isArray(record.clashKeys)
        ? record.clashKeys.map((reviewKey) => ({ reviewKey, occurrenceKey: '' }))
        : [];
    const members: ManualClashMember[] = [];
    for (const value of persistedMembers) {
      if (!value || typeof value !== 'object') continue;
      const member = value as Record<string, unknown>;
      const reviewKey = typeof member.reviewKey === 'string' ? member.reviewKey : '';
      const occurrenceKey = typeof member.occurrenceKey === 'string' ? member.occurrenceKey : '';
      if (!reviewKey) continue;
      if (occurrenceKey) {
        if (claimedOccurrences.has(occurrenceKey) || legacyReviewClaims.has(reviewKey)) continue;
        claimedOccurrences.add(occurrenceKey);
      } else {
        if (claimedReviews.has(reviewKey)) continue;
        legacyReviewClaims.add(reviewKey);
      }
      claimedReviews.add(reviewKey);
      members.push({ reviewKey, occurrenceKey });
      if (members.length >= MAX_MEMBERS_PER_GROUP) break;
    }
    if (members.length === 0) continue;
    groupIds.add(id);
    groups.push({ id, name, members });
    if (groups.length >= MAX_GROUPS) break;
  }
  return groups;
}

export function loadManualClashGroups(): ManualClashGroup[] {
  try {
    const value = localStorage.getItem(MANUAL_CLASH_GROUPS_KEY);
    return value ? normalizeManualClashGroups(JSON.parse(value)) : [];
  } catch (error) {
    console.warn('[clash] Could not read saved manual clash groups:', error);
    return [];
  }
}

export function saveManualClashGroups(groups: readonly ManualClashGroup[]): ManualGroupSaveResult {
  if (groups.length > MAX_GROUPS || groups.some((group) => group.members.length > MAX_MEMBERS_PER_GROUP)) {
    return { ok: false, reason: 'too_many', message: 'Too many clash groups or members to save.' };
  }
  let payload: string;
  try {
    payload = JSON.stringify({ schemaVersion: SCHEMA_VERSION, groups });
  } catch (error) {
    return { ok: false, reason: 'serialize', message: `Could not serialize clash groups: ${String(error)}` };
  }
  try {
    localStorage.setItem(MANUAL_CLASH_GROUPS_KEY, payload);
    return { ok: true };
  } catch (error) {
    console.warn('[clash] Could not save manual clash groups:', error);
    return { ok: false, reason: 'quota', message: 'Browser storage is full — clash groups were not saved.' };
  }
}

/** Resolve durable group definitions against one run without deleting absent ids. */
export function resolveManualClashGroups(
  groups: readonly ManualClashGroup[],
  clashes: readonly Clash[],
): ResolvedManualClashGroup[] {
  const byOccurrence = new Map<string, Clash[]>();
  const byReview = new Map<string, Clash[]>();
  for (const clash of clashes) {
    const occurrenceKey = manualClashOccurrenceKey(clash);
    const occurrences = byOccurrence.get(occurrenceKey);
    if (occurrences) occurrences.push(clash);
    else byOccurrence.set(occurrenceKey, [clash]);
    const reviewKey = clashReviewKey(clash);
    const reviews = byReview.get(reviewKey);
    if (reviews) reviews.push(clash);
    else byReview.set(reviewKey, [clash]);
  }
  const claimed = new Set<Clash>();
  return groups
    .map((definition) => {
      const entries = definition.members.flatMap((member) => {
        const exact = (byOccurrence.get(member.occurrenceKey) ?? [])
          .find((clash) => clashReviewKey(clash) === member.reviewKey && !claimed.has(clash));
        const fallback = (byReview.get(member.reviewKey) ?? []).find((clash) => !claimed.has(clash));
        const clash = exact ?? fallback;
        if (!clash) return [];
        claimed.add(clash);
        return [{ member, clash }];
      });
      return {
        definition,
        members: entries.map((entry) => entry.clash),
        memberDefinitions: entries.map((entry) => entry.member),
      };
    })
    .filter((group) => group.members.length > 0);
}

/** Remove the persisted claim behind one displayed member, including an ambiguous stale fallback. */
export function removeResolvedManualClashMember(
  groups: readonly ManualClashGroup[],
  resolved: readonly ResolvedManualClashGroup[],
  groupId: string,
  clash: Clash,
): ManualClashGroup[] {
  return groups.flatMap((group) => {
    if (group.id !== groupId) return [group];
    const current = resolved.find((item) => item.definition.id === groupId);
    const index = current?.members.findIndex((member) => member.id === clash.id) ?? -1;
    const persisted = index >= 0 ? current?.memberDefinitions[index] : undefined;
    const usedFallback = persisted ? persisted.occurrenceKey !== manualClashOccurrenceKey(clash) : false;
    const members = persisted
      ? group.members.filter((member) => usedFallback
        ? member.reviewKey !== persisted.reviewKey
        : member !== persisted)
      : group.members;
    return members.length > 0 ? [{ ...group, members }] : [];
  });
}

/** Identify one occurrence without sacrificing the durable review-key fallback. */
export function manualClashMember(clash: Clash): ManualClashMember {
  return { reviewKey: clashReviewKey(clash), occurrenceKey: manualClashOccurrenceKey(clash) };
}

export function manualClashOccurrenceKey(clash: Pick<Clash, 'rule' | 'a' | 'b'>): string {
  const elements = [clash.a, clash.b]
    .map((element) => [element.model, element.key] as const)
    .sort(([modelA, keyA], [modelB, keyB]) => modelA.localeCompare(modelB) || keyA.localeCompare(keyB));
  return JSON.stringify([clash.rule, ...elements]);
}

/** Default to the most frequent shared element name, then a numbered label. */
export function defaultManualClashGroupName(clashes: readonly Clash[], number: number): string {
  const counts = new Map<string, { count: number; label: string }>();
  for (const clash of clashes) {
    for (const element of [clash.a, clash.b]) {
      const key = JSON.stringify([element.model, element.key]);
      const current = counts.get(key);
      counts.set(key, { count: (current?.count ?? 0) + 1, label: element.name ?? element.key });
    }
  }
  const shared = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))[0];
  return shared && shared.count > 1 ? shared.label : `Clash group ${number}`;
}
