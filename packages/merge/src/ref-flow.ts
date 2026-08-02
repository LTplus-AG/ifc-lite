/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Store-agnostic layer-PR merge flow: fast-forward when the candidate was
 * authored against the ref's current stack, otherwise a three-way plan
 * with explicit conflicts, blanket resolutions, and ref-policy
 * enforcement (required checks, human approval) before completion.
 *
 * The flow is shared verbatim by the CLI (`ifc layer merge`, filesystem
 * store) and the registry route (`POST /api/v1/refs/:name/merge`,
 * collab-server) — one decision procedure, two transports, no drift.
 */

import type { IfcxFile, ProvenanceBase, ProvenanceManifest, WaivedCheck } from '@ifc-lite/ifcx';
import { computeStackHash, getProvenance } from '@ifc-lite/ifcx';
import { applyResolutions, buildMergeLayer } from './merge-layer.js';
import { planThreeWayMerge } from './three-way.js';
import type { MergeConflict, MergePlan, ResolutionInput } from './types.js';

export interface RefPolicy {
  requireHumanApproval?: boolean;
  requiredChecks?: string[];
  /**
   * Merge conflict-free, all-checks-green candidates unattended
   * (10-registry.md §10.4). Consumed by the registry on push; ignored by
   * the local CLI flow (the operator IS the merge decision there).
   * Combined with `requireHumanApproval`, auto-merge never fires — an
   * unattended merge cannot satisfy an approval requirement (fail closed).
   */
  autoMerge?: boolean;
}

export interface RefEntry {
  /** Ordered layer ids, weakest first. */
  layers: string[];
  policy?: RefPolicy;
}

/** Minimal store surface the merge flow needs; implementations own durability. */
export interface LayerRefStore {
  loadLayer(layerId: string): IfcxFile;
  /** Persist a published layer; `file.header.id` is its blake3 id. */
  storeLayer(file: IfcxFile): string;
  getRef(name: string): RefEntry | undefined;
  setRef(name: string, entry: RefEntry): void;
  /** Optional id-prefix resolution (CLI convenience); identity if absent. */
  resolveLayerId?(idOrPrefix: string): string;
}

export interface AncestorResolution {
  /** Ordered layer documents forming the ancestor stack. */
  layers: IfcxFile[];
  /** Layer ids forming the ancestor stack. */
  ids: string[];
  /** False when manifest.base was null or matched no prefix of the ref. */
  matched: boolean;
}

/**
 * Resolve a candidate's `manifest.base` to a prefix of the ref's layer
 * list: a stack base matches the prefix with the same stack hash, a layer
 * base matches the prefix ending at that layer id.
 */
export function resolveAncestor(
  store: Pick<LayerRefStore, 'loadLayer'>,
  refLayerIds: readonly string[],
  base: ProvenanceBase | null | undefined
): AncestorResolution {
  const load = (ids: readonly string[]): IfcxFile[] => ids.map((id) => store.loadLayer(id));
  // Null/missing base: ancestor is the empty stack ("warn" case in 09).
  if (base == null) return { layers: [], ids: [], matched: false };

  if (base.kind === 'layer') {
    const idx = refLayerIds.indexOf(base.id);
    if (idx !== -1) {
      const ids = refLayerIds.slice(0, idx + 1);
      return { layers: load(ids), ids: [...ids], matched: true };
    }
    return { layers: [], ids: [], matched: false };
  }

  for (let i = 0; i <= refLayerIds.length; i++) {
    const prefix = refLayerIds.slice(0, i);
    if (computeStackHash(prefix) === base.id) {
      return { layers: load(prefix), ids: [...prefix], matched: true };
    }
  }
  return { layers: [], ids: [], matched: false };
}

export interface Waiver {
  spec: string;
  reason: string;
}

/** Returns a failure message when the ref's policy blocks completion. */
export function checkRefPolicy(
  entry: RefEntry,
  manifest: ProvenanceManifest | undefined,
  waivers: readonly Waiver[],
  approvedBy: string | undefined
): string | undefined {
  const policy = entry.policy;
  if (!policy) return undefined;

  const waived = new Set(waivers.map((w) => w.spec));
  for (const spec of policy.requiredChecks ?? []) {
    if (waived.has(spec)) continue;
    const passing = (manifest?.checks ?? []).some((c) => c.spec === spec && c.result === 'pass');
    if (!passing) {
      return `required check "${spec}" did not pass on the candidate (waive with --waive "${spec}" --reason "...")`;
    }
  }
  // Fail closed on unknown authorship: a candidate with no provenance
  // manifest could be an agent layer with the manifest stripped — the
  // approval gate must not be bypassable that way.
  if (
    policy.requireHumanApproval &&
    (manifest === undefined || manifest.author.kind === 'agent') &&
    approvedBy === undefined
  ) {
    return 'ref requires human approval for agent-authored (or manifest-less) layers (pass --approved-by <principal>)';
  }
  return undefined;
}

export interface MergeInit {
  candidateId: string;
  into: string;
  preview?: boolean;
  resolve?: 'ours' | 'theirs';
  /**
   * Per-conflict resolutions (the review-UI flow: preview, decide each
   * conflict, execute). Takes precedence over the blanket `resolve`;
   * conflicts left unaddressed surface as a `conflicts` outcome.
   */
  resolutions?: ResolutionInput[];
  waivers?: Waiver[];
  approvedBy?: string;
  principal?: string;
  created?: string;
  /** Merge a candidate whose declared base matches nothing on the ref. */
  allowUnrelated?: boolean;
}

export type MergeOutcome =
  | { status: 'fast-forward'; refLayers: string[]; ancestorMatched: true }
  | { status: 'preview'; plan: MergePlan; ancestorMatched: boolean }
  | { status: 'conflicts'; conflicts: MergeConflict[]; ancestorMatched: boolean }
  | { status: 'policy-failure'; reason: string }
  | { status: 'unrelated-base'; declaredBase: ProvenanceBase }
  | {
      status: 'merged';
      mergeLayerId: string;
      refLayers: string[];
      plan: MergePlan;
      ancestorMatched: boolean;
    };

/**
 * True when completing this merge would rely on a waiver — a required
 * check that has no passing evidence on the manifest and is only
 * satisfied because it was waived. Such merges must leave a durable
 * record (`manifest.merge.waived_checks`), so they cannot take the plain
 * fast-forward path that appends no merge layer.
 */
function waiversConsumed(
  entry: RefEntry,
  manifest: ProvenanceManifest | undefined,
  waivers: readonly Waiver[]
): boolean {
  const required = entry.policy?.requiredChecks ?? [];
  if (required.length === 0 || waivers.length === 0) return false;
  const waived = new Set(waivers.map((w) => w.spec));
  return required.some(
    (spec) =>
      waived.has(spec) &&
      !(manifest?.checks ?? []).some((c) => c.spec === spec && c.result === 'pass')
  );
}

/** Core merge flow; returns an outcome instead of exiting (transport-neutral). */
export function mergeIntoRef(store: LayerRefStore, init: MergeInit): MergeOutcome {
  const candidateId = store.resolveLayerId ? store.resolveLayerId(init.candidateId) : init.candidateId;
  const candidate = store.loadLayer(candidateId);
  const manifest = getProvenance(candidate);
  const entry = store.getRef(init.into);
  if (!entry) throw new Error(`No ref named "${init.into}"`);
  const oursIds = [...entry.layers];
  const waivers = init.waivers ?? [];
  const resolver = init.principal ?? 'unknown';

  // A candidate already ON the ref is a completed merge, not a mismatch:
  // publishing appends the draft to its home ref, so re-merging that
  // layer into the same ref must no-op instead of refusing as
  // unrelated-base (its declared base is the composition it was authored
  // against, which need not be representable on the ref).
  if (oursIds.includes(candidateId)) {
    if (init.preview) {
      return {
        status: 'preview',
        plan: { autoOps: [], conflicts: [], stats: { touched: 0, autoMerged: 0, conflicting: 0 } },
        ancestorMatched: true,
      };
    }
    return { status: 'fast-forward', refLayers: oursIds, ancestorMatched: true };
  }

  // Fast path: candidate authored against the ref's current stack. A
  // merge that consumes a waiver falls through to the three-way path so
  // the waiver is durably recorded on a merge layer.
  if (manifest?.base?.kind === 'stack' && manifest.base.id === computeStackHash(oursIds)) {
    if (init.preview) {
      // Preview of a fast-forward is an empty plan.
      return {
        status: 'preview',
        plan: { autoOps: [], conflicts: [], stats: { touched: 0, autoMerged: 0, conflicting: 0 } },
        ancestorMatched: true,
      };
    }
    const failure = checkRefPolicy(entry, manifest, waivers, init.approvedBy);
    if (failure) return { status: 'policy-failure', reason: failure };
    if (!waiversConsumed(entry, manifest, waivers)) {
      const refLayers = [...oursIds, candidateId];
      store.setRef(init.into, { ...entry, layers: refLayers });
      return { status: 'fast-forward', refLayers, ancestorMatched: true };
    }
  }

  const ancestor = resolveAncestor(store, oursIds, manifest?.base ?? null);
  // A candidate that DECLARES a base which matches nothing on the ref was
  // authored against a different history: three-way planning against an
  // empty ancestor would read its every op as "new" and steamroll the
  // ref. Refuse unless explicitly overridden. (Baseless candidates keep
  // the documented warn-and-proceed semantics — null base is a legitimate
  // publish mode, not a mismatch.)
  if (manifest?.base != null && !ancestor.matched && !init.preview && !init.allowUnrelated) {
    return { status: 'unrelated-base', declaredBase: manifest.base };
  }
  const ours = oursIds.map((id) => store.loadLayer(id));
  const plan = planThreeWayMerge({
    ancestor: ancestor.layers,
    ours,
    theirs: [...ancestor.layers, candidate],
  });

  if (init.preview) return { status: 'preview', plan, ancestorMatched: ancestor.matched };

  let resolutionInputs: ResolutionInput[] = [];
  if (plan.conflicts.length > 0) {
    if (init.resolutions !== undefined && init.resolutions.length > 0) {
      resolutionInputs = init.resolutions;
    } else if (init.resolve) {
      const choice = init.resolve;
      resolutionInputs = plan.conflicts.map((conflict) => {
        const input: ResolutionInput = { path: conflict.path, choice };
        if (conflict.componentKey !== undefined) input.componentKey = conflict.componentKey;
        return input;
      });
    } else {
      return { status: 'conflicts', conflicts: plan.conflicts, ancestorMatched: ancestor.matched };
    }
  }
  const applied = applyResolutions(plan, resolutionInputs);
  if (applied.unresolved.length > 0) {
    return { status: 'conflicts', conflicts: applied.unresolved, ancestorMatched: ancestor.matched };
  }

  const failure = checkRefPolicy(entry, manifest, waivers, init.approvedBy);
  if (failure) return { status: 'policy-failure', reason: failure };

  const waivedChecks: WaivedCheck[] = waivers.map((w) => ({
    spec: w.spec,
    reason: w.reason,
    waivedBy: resolver,
  }));
  const merged = buildMergeLayer({
    ops: [...plan.autoOps, ...applied.ops],
    author: { kind: 'human', principal: resolver },
    intent: `Merge ${candidateId} into ${init.into}`,
    base: { kind: 'stack', id: computeStackHash(oursIds) },
    merge: {
      candidate: candidateId,
      into: init.into,
      resolutions: applied.resolutions,
      waived_checks: waivedChecks,
      resolver,
    },
    created: init.created,
  });
  // The store owns the persisted identity: a backend that canonicalizes
  // or re-materializes content may return a different id than the one
  // precomputed on the merge layer.
  const mergeLayerId = store.storeLayer(merged.file);
  const refLayers = [...oursIds, mergeLayerId];
  store.setRef(init.into, { ...entry, layers: refLayers });
  return {
    status: 'merged',
    mergeLayerId,
    refLayers,
    plan,
    ancestorMatched: ancestor.matched,
  };
}
