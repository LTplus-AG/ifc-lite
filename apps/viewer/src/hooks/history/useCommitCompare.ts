/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Comparing two commits.
 *
 * Two halves, and the split is the point:
 *
 *  1. The PREVIEW comes from `getCommitDiff` and needs neither commit's
 *     bytes. A coordinator asking "what changed between these two" gets
 *     counts and a grouped list from one request, with no model load at all.
 *  2. "Show in 3D" is the expensive half: both commits have to be loaded, and
 *     then the EXISTING compare runs — `compareSlice` + `useCompare`, not a
 *     second diff implementation. The stored diff is a preview of the same
 *     question, never a substitute for the overlay.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { isCommitSourceError } from '@ifc-lite/plugin-api';
import type { CommitRef, StoredCommitDiff, StoredDiffEntry } from '@ifc-lite/plugin-api';

import { useResolveHistoryProvider } from './useHistoryProvider';

/** Rows the preview renders before it stops and says "and N more". */
export const PREVIEW_LIMIT = 100;

export interface DiffPreviewGroup {
  readonly state: StoredDiffEntry['state'];
  readonly ifcType: string;
  readonly entries: readonly StoredDiffEntry[];
}

export interface CommitCompareState {
  readonly diff: StoredCommitDiff | null;
  readonly groups: readonly DiffPreviewGroup[];
  readonly truncated: number;
  readonly loading: boolean;
  /** `true` while the provider is still computing — a wait, not a failure. */
  readonly calculating: boolean;
  readonly error: string | null;
  readonly supported: boolean;
}

/** Groups by state then IFC type, the shape the preview list renders. */
export function groupDiffEntries(entries: readonly StoredDiffEntry[]): DiffPreviewGroup[] {
  const byKey = new Map<string, StoredDiffEntry[]>();
  for (const entry of entries.slice(0, PREVIEW_LIMIT)) {
    const key = `${entry.state}\u0000${entry.ifcType}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(entry);
    else byKey.set(key, [entry]);
  }
  // Added, then modified, then deleted: the order a reader scans for "what is
  // new" before "what is gone".
  const order: StoredDiffEntry['state'][] = ['added', 'modified', 'deleted'];
  return [...byKey.entries()]
    .map(([key, bucket]) => {
      const [state, ifcType] = key.split('\u0000');
      return { state: state as StoredDiffEntry['state'], ifcType, entries: bucket };
    })
    .sort((a, b) =>
      a.state !== b.state ? order.indexOf(a.state) - order.indexOf(b.state) : a.ifcType.localeCompare(b.ifcType),
    );
}

const EMPTY_GROUPS: readonly DiffPreviewGroup[] = [];

/**
 * Fetches the stored diff between `a` and `b`, retrying while the provider
 * answers `not-ready`.
 *
 * The retry is bounded by the component's lifetime, not by a count: a service
 * computing a diff of a large model can legitimately take a while, and the
 * user is looking at "Calculating changes…" the whole time. Unmounting
 * cancels it.
 */
export function useCommitCompare(modelId: string | null, a: CommitRef | null, b: CommitRef | null): CommitCompareState {
  const resolveProvider = useResolveHistoryProvider();
  const [diff, setDiff] = useState<StoredCommitDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [calculating, setCalculating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keyed on the ref VALUES, not on object identity: a caller that rebuilds
  // `{ projectId, modelId, commitId }` each render (which the panel does not,
  // but nothing stops) would otherwise re-run this effect forever — one
  // request per render against a commit service.
  const pairKey = a && b ? `${a.projectId}|${a.modelId}|${a.commitId}|${b.commitId}` : null;
  const refs = useRef<{ a: CommitRef; b: CommitRef } | null>(null);
  if (a && b) refs.current = { a, b };

  useEffect(() => {
    setDiff(null);
    setError(null);
    setCalculating(false);
    const pair = refs.current;
    if (!modelId || pairKey === null || !pair) {
      setSupported(false);
      return;
    }
    const resolved = resolveProvider(modelId);
    const canDiff = resolved?.provider.manifest.capabilities.commits?.storedDiffs === true
      && resolved.provider.getCommitDiff !== undefined;
    setSupported(canDiff === true);
    if (!resolved || !canDiff) return;

    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const ctx = resolved.createContext();
        const result = await resolved.provider.getCommitDiff!(ctx, pair.a, pair.b);
        if (cancelled) return;
        setDiff(result);
        setCalculating(false);
        setError(null);
      } catch (caught) {
        if (cancelled) return;
        if (isCommitSourceError(caught) && caught.code === 'not-ready') {
          setCalculating(true);
          timer.current = setTimeout(() => void run(), Math.max(caught.retryAfterMs ?? 1000, 250));
          return;
        }
        setCalculating(false);
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();

    return () => {
      cancelled = true;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [modelId, pairKey, resolveProvider]);

  const entries = diff?.entries ?? [];
  return {
    diff,
    groups: diff ? groupDiffEntries(entries) : EMPTY_GROUPS,
    truncated: Math.max(0, entries.length - PREVIEW_LIMIT),
    loading,
    calculating,
    error,
    supported,
  };
}

/**
 * Reviewed identity between two commits, converted to the `{ base, here,
 * reason }` entries the compare panel replays as key aliases.
 *
 * Without this, a commit that re-GUIDed its elements compares as
 * delete-everything / add-everything — which is the single most common way
 * Compare mode is wrong, and the reason the provider stores the reviewed
 * answer in the first place.
 */
export function useCommitIdentity(): (
  modelId: string,
  base: CommitRef,
  head: CommitRef,
) => Promise<{ base: string; here: string; reason: string }[]> {
  const resolveProvider = useResolveHistoryProvider();
  return useCallback(
    async (modelId, base, head) => {
      const resolved = resolveProvider(modelId);
      if (
        !resolved
        || resolved.provider.manifest.capabilities.commits?.identityRecords !== true
        || !resolved.provider.listIdentityRecords
      ) {
        return [];
      }
      try {
        const records = await resolved.provider.listIdentityRecords(resolved.createContext(), base, head);
        return records.entries.map((entry) => ({ base: entry.base, here: entry.here, reason: entry.reason }));
      } catch (error) {
        // Identity is an improvement to the comparison, not a precondition:
        // losing it degrades the result, and failing the whole compare
        // because of it would be worse than the thing it fixes.
        console.warn('[history] Could not read reviewed identity for this commit pair', error);
        return [];
      }
    },
    [resolveProvider],
  );
}
