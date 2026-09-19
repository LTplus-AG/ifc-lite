/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { clashReviewKey, type Clash } from '@ifc-lite/clash';

export interface ManualClashGroup {
  id: string;
  name: string;
  /** Durable `clashReviewKey` values, retained even when a narrower run omits them. */
  clashKeys: string[];
}

export interface ResolvedManualClashGroup {
  definition: ManualClashGroup;
  members: Clash[];
}

export interface ManualClashGroupBcfRefs {
  selectedRefs: number[];
  aRefs: number[];
  bRefs: number[];
}

export type ManualGroupSaveResult =
  | { ok: true }
  | { ok: false; reason: 'quota' | 'serialize' | 'too_many'; message: string };

export const MANUAL_CLASH_GROUPS_KEY = 'ifc-lite-clash-manual-groups';
const SCHEMA_VERSION = 1;
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
  const claimedClashes = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = normalizeName(record.name);
    if (!id || !name || groupIds.has(id) || !Array.isArray(record.clashKeys)) continue;
    const clashKeys: string[] = [];
    for (const value of record.clashKeys) {
      if (typeof value !== 'string' || !value || claimedClashes.has(value)) continue;
      claimedClashes.add(value);
      clashKeys.push(value);
      if (clashKeys.length >= MAX_MEMBERS_PER_GROUP) break;
    }
    if (clashKeys.length === 0) continue;
    groupIds.add(id);
    groups.push({ id, name, clashKeys });
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
  if (groups.length > MAX_GROUPS || groups.some((group) => group.clashKeys.length > MAX_MEMBERS_PER_GROUP)) {
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
  const byKey = new Map(clashes.map((clash) => [clashReviewKey(clash), clash]));
  return groups
    .map((definition) => ({
      definition,
      members: definition.clashKeys
        .map((key) => byKey.get(key))
        .filter((clash): clash is Clash => clash !== undefined),
    }))
    .filter((group) => group.members.length > 0);
}

/** Build one de-duplicated selection/color payload for the group's viewpoint. */
export function manualClashGroupBcfRefs(clashes: readonly Clash[]): ManualClashGroupBcfRefs {
  const selectedRefs = new Set<number>();
  const aRefs = new Set<number>();
  const bRefs = new Set<number>();
  for (const clash of clashes) {
    selectedRefs.add(clash.a.ref);
    selectedRefs.add(clash.b.ref);
    aRefs.add(clash.a.ref);
    bRefs.add(clash.b.ref);
  }
  // An object found on both sides gets one deterministic color instead of two.
  for (const ref of aRefs) bRefs.delete(ref);
  return { selectedRefs: [...selectedRefs], aRefs: [...aRefs], bRefs: [...bRefs] };
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
