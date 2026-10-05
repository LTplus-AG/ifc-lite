/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Resolve scene-action targets to renderer (federated global) ids against the
 * live store. A GlobalId resolves through each model's own entity table, the
 * same lookup reviewed model changes use; a citation resolves through the row
 * captured in the CURRENT evidence snapshot, and only while that snapshot is
 * still current, so a stale answer can never drive the scene.
 *
 * Citation rows are read by shape, not by source name: any row object carrying
 * a `globalId` (+ `modelId`), a `modelId` + `expressId`, or a `modelId` +
 * `localId` names an element. Clash rows are matched against the live clash
 * result (`resolveCapturedClash`). An evidence adapter added later is
 * therefore citable as soon as its rows carry one of those identities.
 */

import type { ViewerState } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { capturedEvidence } from '@/lib/assistant/captured-rows';
import { evidenceIsCurrent, type EvidenceSnapshot } from '@/lib/assistant/evidence';
import { resolveCapturedClash } from '@/lib/assistant/clash-group-proposal';
import type { SceneTarget } from './scene-actions';

export type TargetStatus = 'resolved' | 'missing' | 'ambiguous' | 'stale-citation' | 'unknown-citation' | 'no-identity';

export interface ResolvedTarget {
  target: SceneTarget;
  status: TargetStatus;
  /** Renderer ids; empty unless resolved. A citation can name several elements. */
  ids: number[];
}

type TargetState = Pick<ViewerState, 'models' | 'mutationViews'>;

const GLOBAL_ID = /^[0-9A-Za-z_$]{22}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function liveEntity(state: TargetState, modelId: string, expressId: number): boolean {
  const model = state.models.get(modelId);
  if (!model?.ifcDataStore || !Number.isInteger(expressId) || expressId <= 0) return false;
  if (state.mutationViews?.get(modelId)?.isDeleted(expressId)) return false;
  return !!model.ifcDataStore.entities?.getTypeName(expressId);
}

/** GlobalId → renderer id, scoped to `modelId` when given. */
function resolveByGlobalId(state: TargetState, globalId: string, modelId?: string): number[] | 'missing' | 'ambiguous' {
  const hits: number[] = [];
  for (const [id, model] of state.models) {
    if (modelId && modelId !== id) continue;
    const expressId = model.ifcDataStore?.entities?.getExpressIdByGlobalId(globalId);
    if (expressId !== undefined && expressId > 0 && !state.mutationViews?.get(id)?.isDeleted(expressId)) {
      hits.push(toGlobalIdFromModels(state.models, id, expressId));
    }
  }
  if (hits.length === 0) return 'missing';
  return hits.length > 1 ? 'ambiguous' : hits;
}

/** Element identities a captured row names, by shape; bounded to two levels of nesting. */
function rowIdentities(state: TargetState, data: unknown): number[] | 'ambiguous' | null {
  const ids: number[] = [];
  let found = false;
  let ambiguous = false;
  const visit = (value: unknown, depth: number) => {
    if (!record(value) || depth > 2) return;
    const modelId = typeof value.modelId === 'string' ? value.modelId : undefined;
    if (typeof value.globalId === 'string' && GLOBAL_ID.test(value.globalId)) {
      found = true;
      const hit = resolveByGlobalId(state, value.globalId, modelId);
      if (hit === 'ambiguous') ambiguous = true;
      else if (hit !== 'missing') ids.push(...hit);
      return;
    }
    const local = typeof value.expressId === 'number' ? value.expressId : typeof value.localId === 'number' ? value.localId : null;
    if (modelId && local !== null) {
      found = true;
      if (liveEntity(state, modelId, local)) ids.push(toGlobalIdFromModels(state.models, modelId, local));
      return;
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(data, 0);
  if (!found) return null;
  return ambiguous && ids.length === 0 ? 'ambiguous' : ids;
}

/** The attached evidence, parsed and freshness-checked once per preview rather than once per target. */
export interface CitationContext {
  evidence: EvidenceSnapshot | null;
  /** Captured rows by citation; null when there is no current evidence. */
  rows: Map<string, unknown> | null;
}

export function citationContext(evidence: EvidenceSnapshot | null): CitationContext {
  if (!evidence || !evidenceIsCurrent(evidence)) return { evidence, rows: null };
  return { evidence, rows: capturedEvidence(evidence.payload)?.rows ?? new Map() };
}

/**
 * Resolve one target. A citation without current evidence is refused, never
 * guessed.
 */
export function resolveSceneTarget(state: TargetState, target: SceneTarget, citations: CitationContext): ResolvedTarget {
  if ('globalId' in target) {
    const hit = resolveByGlobalId(state, target.globalId, target.modelId);
    return typeof hit === 'string' ? { target, status: hit, ids: [] } : { target, status: 'resolved', ids: hit };
  }
  const { evidence, rows } = citations;
  if (!evidence || !rows) return { target, status: 'stale-citation', ids: [] };
  const row = rows.get(target.citation);
  if (row === undefined) return { target, status: 'unknown-citation', ids: [] };
  if (evidence.source === 'clash') {
    // Clash rows carry renderer refs; only the live, uniquely matching clash may supply them.
    const clash = resolveCapturedClash(evidence, target.citation);
    if (!clash) return { target, status: 'missing', ids: [] };
    return { target, status: 'resolved', ids: [...new Set([clash.a.ref, clash.b.ref])] };
  }
  const ids = rowIdentities(state, row);
  if (ids === null) return { target, status: 'no-identity', ids: [] };
  if (ids === 'ambiguous') return { target, status: 'ambiguous', ids: [] };
  const unique = [...new Set(ids)];
  return unique.length ? { target, status: 'resolved', ids: unique } : { target, status: 'missing', ids: [] };
}
