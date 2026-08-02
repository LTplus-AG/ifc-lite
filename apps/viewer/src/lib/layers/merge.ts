/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Merge orchestration for the Layers panel (#1717 V3): one preview /
 * execute surface over the two ref backends. Local refs run the shared
 * engine in-process (the browser store satisfies the sync
 * `LayerRefStore`); registry refs merge SERVER-side, where ref policies
 * and approvals are enforced — the candidate is pushed first so the
 * server can load it.
 */

import type { IfcxFile } from '@ifc-lite/ifcx';
import { getProvenance } from '@ifc-lite/ifcx';
import { mergeIntoRef } from '@ifc-lite/merge';
import type { MergeConflict, MergeOutcome, ResolutionInput, Waiver } from '@ifc-lite/merge';
import type { BrowserLayerStore } from './browser-store';
import { LayerRegistryClient, RegistryError } from './registry-client';
import type { RegistryMergeOutcome } from './registry-client';

export type MergeTarget =
  | { kind: 'local'; refName: string }
  | { kind: 'registry'; refName: string; client: LayerRegistryClient };

/** The panel's normalized view of both backends' outcomes. */
export interface ViewerMergeResult {
  status: MergeOutcome['status'];
  conflicts: MergeConflict[];
  /** Ref layer ids after a completed merge / fast-forward. */
  refLayers?: string[];
  mergeLayerId?: string;
  reason?: string;
  /** Plan stats for previews. */
  stats?: { autoMerged: number; conflicting: number };
  /**
   * False on previews planned against an empty ancestor because the
   * candidate's declared base matched nothing on the ref — executing
   * such a merge will be refused (unrelated-base), so the panel warns.
   */
  ancestorMatched?: boolean;
}

function fromRegistry(outcome: RegistryMergeOutcome): ViewerMergeResult {
  return {
    status: outcome.status,
    conflicts: outcome.conflicts ?? outcome.plan?.conflicts ?? [],
    refLayers: outcome.layers,
    mergeLayerId: outcome.merge_layer,
    reason:
      outcome.reason ??
      (outcome.declared_base
        ? `declared base ${outcome.declared_base.id} matches nothing on the ref`
        : undefined),
    ...(outcome.plan
      ? { stats: { autoMerged: outcome.plan.stats.autoMerged, conflicting: outcome.plan.stats.conflicting } }
      : {}),
    ...(outcome.ancestor_matched !== undefined ? { ancestorMatched: outcome.ancestor_matched } : {}),
  };
}

function fromLocal(outcome: MergeOutcome): ViewerMergeResult {
  switch (outcome.status) {
    case 'preview':
      return {
        status: 'preview',
        conflicts: outcome.plan.conflicts,
        stats: { autoMerged: outcome.plan.stats.autoMerged, conflicting: outcome.plan.stats.conflicting },
        ancestorMatched: outcome.ancestorMatched,
      };
    case 'conflicts':
      return { status: 'conflicts', conflicts: outcome.conflicts };
    case 'fast-forward':
      return { status: 'fast-forward', conflicts: [], refLayers: outcome.refLayers };
    case 'merged':
      return { status: 'merged', conflicts: [], refLayers: outcome.refLayers, mergeLayerId: outcome.mergeLayerId };
    case 'policy-failure':
      return { status: 'policy-failure', conflicts: [], reason: outcome.reason };
    case 'unrelated-base':
      return { status: 'unrelated-base', conflicts: [], reason: `declared base ${outcome.declaredBase.id} matches nothing on the ref` };
  }
}

export async function ensureCandidateOnRegistry(
  client: LayerRegistryClient,
  store: BrowserLayerStore,
  candidateId: string,
): Promise<void> {
  try {
    await client.pushLayer(store.loadLayer(candidateId));
  } catch (err) {
    // An identical re-push is idempotent (201); a content-conflict means
    // the id exists with the same canonical bytes but different
    // non-canonical ones — the server copy wins, merging can proceed.
    if (err instanceof RegistryError && err.status === 409) return;
    throw err;
  }
}

export async function previewMergeInto(
  target: MergeTarget,
  store: BrowserLayerStore,
  candidateId: string,
): Promise<ViewerMergeResult> {
  if (target.kind === 'local') {
    return fromLocal(mergeIntoRef(store, { candidateId, into: target.refName, preview: true }));
  }
  await ensureCandidateOnRegistry(target.client, store, candidateId);
  return fromRegistry(await target.client.mergeRef(target.refName, { candidate: candidateId, preview: true }));
}

export async function executeMergeInto(
  target: MergeTarget,
  store: BrowserLayerStore,
  candidateId: string,
  resolutions: ResolutionInput[],
  resolver: string,
  waivers: Waiver[] = [],
): Promise<ViewerMergeResult> {
  if (target.kind === 'local') {
    return fromLocal(
      mergeIntoRef(store, {
        candidateId,
        into: target.refName,
        principal: resolver,
        ...(resolutions.length > 0 ? { resolutions } : {}),
        ...(waivers.length > 0 ? { waivers } : {}),
      }),
    );
  }
  await ensureCandidateOnRegistry(target.client, store, candidateId);
  return fromRegistry(
    await target.client.mergeRef(target.refName, {
      candidate: candidateId,
      ...(resolutions.length > 0
        ? {
            resolutions: resolutions.map((r) => ({
              path: r.path,
              choice: r.choice,
              ...(r.componentKey !== undefined ? { component_key: r.componentKey } : {}),
              ...(r.choice === 'edited' && r.attributes !== undefined ? { attributes: r.attributes } : {}),
            })),
          }
        : {}),
      ...(waivers.length > 0 ? { waivers } : {}),
    }),
  );
}

/**
 * Composition is per-attribute LWW: a key the reviewer DELETED from an
 * edited resolution must become an explicit `null` opinion, or the old
 * value silently shines through the merge. Fill removals against the
 * union of both sides' keys.
 */
export function editedWithRemovals(
  conflict: MergeConflict,
  edited: Record<string, unknown>,
): Record<string, unknown> {
  const union = new Set([
    ...Object.keys((conflict.ours?.attributes as Record<string, unknown> | undefined) ?? {}),
    ...Object.keys((conflict.theirs?.attributes as Record<string, unknown> | undefined) ?? {}),
  ]);
  const out: Record<string, unknown> = { ...edited };
  for (const key of union) {
    if (!(key in out)) out[key] = null;
  }
  return out;
}

/** A target ref's required checks scored against the candidate manifest. */
export interface RequiredCheckStatus {
  spec: string;
  passing: boolean;
}

/**
 * Which of the target ref's required checks (08-review.md §8.4) the
 * candidate satisfies — the UI offers waive-with-reason for the rest.
 * The engine/registry re-verify at execute; this only drives display.
 */
export async function requiredCheckStatus(
  target: MergeTarget,
  store: BrowserLayerStore,
  candidateId: string,
): Promise<RequiredCheckStatus[]> {
  const policy =
    target.kind === 'local'
      ? store.getRef(target.refName)?.policy
      : (await target.client.getRef(target.refName)).policy;
  const required = policy?.requiredChecks ?? [];
  if (required.length === 0) return [];
  let checks: Array<{ spec?: string; result: 'pass' | 'fail' }> = [];
  try {
    checks = getProvenance(store.loadLayer(candidateId))?.checks ?? [];
  } catch {
    // manifest-less candidate: every required check is failing
  }
  return required.map((spec) => ({
    spec,
    passing: checks.some((check) => check.spec === spec && check.result === 'pass'),
  }));
}

/** Short human label for a candidate layer (intent, else id prefix). */
export function candidateLabel(store: BrowserLayerStore, layerId: string): string {
  try {
    const manifest = getProvenance(store.loadLayer(layerId));
    if (manifest?.intent) return manifest.intent;
  } catch {
    // fall through to the id prefix
  }
  return layerId.slice(0, 15);
}

/** The files composing a ref's stack, for loading into the viewer. */
export function refStackFiles(store: BrowserLayerStore, refName: string): IfcxFile[] {
  const entry = store.getRef(refName);
  if (!entry) throw new Error(`No local ref '${refName}'`);
  return entry.layers.map((id) => store.loadLayer(id));
}
