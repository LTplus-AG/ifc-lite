/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model version history (`docs/architecture/commit-history/02-history-ui.md`).
 *
 * What lives here is only what OUTLIVES a render: which commit each loaded
 * viewer model actually is, which models the resolver linked locally, the
 * panel's focus and A/B picks, and the heads `watchCommits` has reported
 * moving.
 *
 * There is no `historyPanelVisible` flag: the History panel is FLAG-FREE,
 * like the four side panels added before it (Location zones, Load report,
 * Cost, Environment). `openWorkspacePanel` adopts a panel with no flag of its
 * own directly into the docked slot (`store/index.ts`), which every entry
 * point here routes through — the row badge, the command palette and the
 * activity bar all call `showWorkspacePanel('history')`. Spec 02 §4 asks for
 * a flag; a second, redundant source of truth for "is this panel open" is
 * what that would buy.
 *
 * What deliberately does NOT live here is the commit LISTS. Commits are
 * immutable, so `useModelHistory` caches pages in a module-level map keyed by
 * `provider|projectId|sourceModelId` with no expiry; putting them in the
 * store would make every page fetch a state write that re-renders every
 * subscriber, for data that never changes.
 */

import type { StateCreator } from 'zustand';
import type { CommitRef } from '@ifc-lite/plugin-api';

/**
 * Which commit a loaded viewer model is.
 *
 * Distinct from `SourceTag`, and both can be present: a model synced from a
 * file source AND tracked by a commit service carries the file coordinates
 * and the commit coordinates, and neither substitutes for the other.
 * `sourceModelId` is the PROVIDER's model id — the viewer's own model id is
 * the map key — because the two are unrelated strings and conflating them is
 * the single easiest mistake to make here.
 */
export interface CommitTag {
  readonly provider: string;
  readonly projectId: string;
  readonly sourceModelId: string;
  readonly commitId: string;
  readonly artifactDigest: string;
  /** True when this commit was not the source model's head at load time. */
  readonly historical: boolean;
  readonly loadedAt: number;
}

/**
 * A local "this file is a newer version of that one" link, written by the
 * revision resolver in local mode (spec 03) when there is no source to record
 * it against. Keyed by the NEWER model's viewer id.
 */
export interface LocalLineageLink {
  /** Viewer model id of the earlier version. */
  readonly baseModelId: string;
  readonly decidedAt: number;
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
}

export interface HistorySlice {
  /** Keyed by the VIEWER's model id. */
  commitTags: ReadonlyMap<string, CommitTag>;
  /** Keyed by the newer viewer model id. */
  localLineage: ReadonlyMap<string, LocalLineageLink>;
  /** Viewer model id the panel is showing. */
  historyFocusModelId: string | null;
  historyPickA: CommitRef | null;
  historyPickB: CommitRef | null;
  /** New heads reported by `watchCommits`, keyed by viewer model id. */
  historyNewHeads: ReadonlyMap<string, string>;

  setCommitTag: (modelId: string, tag: CommitTag) => void;
  removeCommitTag: (modelId: string) => void;
  setLocalLineage: (modelId: string, link: LocalLineageLink) => void;
  removeLocalLineage: (modelId: string) => void;
  setHistoryFocus: (modelId: string | null) => void;
  pickCommit: (slot: 'A' | 'B', ref: CommitRef | null) => void;
  noteNewHead: (modelId: string, commitId: string) => void;
  clearNewHead: (modelId: string) => void;

  /**
   * True when this model is a PAST version, so it must not be edited.
   *
   * A selector rather than a field: it is derived from the commit tag, and a
   * second stored boolean could disagree with the tag that produced it.
   */
  isHistoricalModel: (modelId: string) => boolean;

  /**
   * The single "may this model be edited" answer every mutation checks.
   *
   * It subsumes the collab role gate rather than sitting beside it, because
   * two independent gates on the same action is how one of them gets
   * forgotten on the next action added — which is exactly the defect
   * `mutationSlice.collab-gate.test.ts` was written for after `setQuantity`
   * and `createQuantitySet` shipped with neither.
   */
  canEditModel: (modelId: string) => boolean;
}

/**
 * What this slice reads from its neighbours. Declared rather than reached
 * for, the `cesiumSlice` pattern: the composed store supplies it, and a unit
 * test can stub exactly this much.
 */
export interface HistoryCrossSliceState {
  canCollabEdit: () => boolean;
}

/** Drops one model's entry from a map, returning the original when there was nothing to drop. */
function withoutKey<T>(map: ReadonlyMap<string, T>, key: string): ReadonlyMap<string, T> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

export const createHistorySlice: StateCreator<HistorySlice & HistoryCrossSliceState, [], [], HistorySlice> = (set, get) => ({
  commitTags: new Map(),
  localLineage: new Map(),
  historyFocusModelId: null,
  historyPickA: null,
  historyPickB: null,
  historyNewHeads: new Map(),

  setCommitTag: (modelId, tag) => {
    const next = new Map(get().commitTags);
    next.set(modelId, tag);
    // Opening a commit answers whatever "new version available" was pending
    // for that model — leaving the banner up after the user acted on it is
    // the fastest way to teach them to ignore it.
    set({ commitTags: next, historyNewHeads: withoutKey(get().historyNewHeads, modelId) });
  },

  removeCommitTag: (modelId) => set({ commitTags: withoutKey(get().commitTags, modelId) }),

  setLocalLineage: (modelId, link) => {
    const next = new Map(get().localLineage);
    next.set(modelId, link);
    set({ localLineage: next });
  },

  removeLocalLineage: (modelId) => set({ localLineage: withoutKey(get().localLineage, modelId) }),

  setHistoryFocus: (modelId) => {
    if (get().historyFocusModelId === modelId) return;
    // The A/B picks name commits of the model that was focused; carrying them
    // to another model would offer a compare across two different models,
    // which `getCommitDiff` refuses (`invalid`) and which means nothing.
    set({ historyFocusModelId: modelId, historyPickA: null, historyPickB: null });
  },

  pickCommit: (slot, ref) => set(slot === 'A' ? { historyPickA: ref } : { historyPickB: ref }),

  noteNewHead: (modelId, commitId) => {
    const next = new Map(get().historyNewHeads);
    next.set(modelId, commitId);
    set({ historyNewHeads: next });
  },

  clearNewHead: (modelId) => set({ historyNewHeads: withoutKey(get().historyNewHeads, modelId) }),

  isHistoricalModel: (modelId) => get().commitTags.get(modelId)?.historical === true,

  canEditModel: (modelId) => {
    // Historical FIRST: a past version is read-only for everyone, including
    // a single user with no collab session at all.
    if (get().commitTags.get(modelId)?.historical === true) return false;
    // `?? true` for the harnesses that stub this slice alone: single-user
    // editing has never been gated by collab, and a missing neighbour must
    // not silently become a refusal.
    return get().canCollabEdit?.() ?? true;
  },
});
