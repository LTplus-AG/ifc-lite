/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { diffModels, type EntityFingerprint, type IdentityMapEntry, type DiffScope } from '@ifc-lite/diff';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { FederatedModel } from '@/store/types';
import type { CompareResult } from '@/store/slices/compareSlice';
import { buildEntityFingerprints, type CompareRef } from './buildFingerprints';
import { effectiveComparePair } from './effectiveCompareStore';
import { fallbackPairDuplicateAuthoredKeys } from './authoredKeys';
import { geometryVolumesSurviveAlignment, resolveGeometryChannel } from './geometryCapability';
import { keyAliasesFromAccepted } from './acceptedIdentity';
import type { BuiltPair } from '@/hooks/compare/comparePairCache';

export interface ComparisonOptions {
  scope: DiffScope;
  excludedTypes: string[];
  matchByContent: boolean;
  /** Explicit pair-scoped decisions. Automation omits these. */
  acceptedIdentity?: readonly IdentityMapEntry[];
}

export interface ComparisonPreparation {
  baseModel: FederatedModel;
  headModel: FederatedModel;
  getMutationView: (modelId: string) => MutablePropertyView | null;
  mutationVersion: number;
  contentVersion: number;
  keyProperty?: string;
  signal?: AbortSignal;
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Comparison cancelled', 'AbortError');
}

/** Prepare immutable fingerprint inputs; neither the panel nor automation options are read here. */
export async function prepareComparison(input: ComparisonPreparation): Promise<BuiltPair> {
  const { baseModel, headModel, getMutationView, mutationVersion, contentVersion, keyProperty, signal } = input;
  if (baseModel.id === headModel.id) throw new Error('Pick two different models to compare.');
  const baseId = baseModel.id, headId = headModel.id;
  const baseStore = baseModel.ifcDataStore, headStore = headModel.ifcDataStore;
  const baseGeometry = baseModel.geometryResult, headGeometry = headModel.geometryResult;
  if (!baseStore) throw new Error('Version A is not fully loaded yet.');
  if (!headStore) throw new Error('Version B is not fully loaded yet.');
  checkCancelled(signal);
  // ONE collision map for both sides (#4989): if either revision
  // duplicates a value, the pair-level fallback below retires that
  // authored key from both revisions before diffing.
  const duplicateAuthoredKeys = new Map<string, number[]>();
  // The models as edited, not as loaded (#5312): see effectiveCompareStore.
  const { baseEffective, headEffective, comparedStores } = await effectiveComparePair(
    [baseModel, baseStore], [headModel, headStore], getMutationView);
  checkCancelled(signal);
  const base = await buildEntityFingerprints({
    modelId: baseId,
    store: baseEffective,
    meshes: baseGeometry?.meshes ?? [],
    instancedGeometryHashes: baseGeometry?.instancedGeometryHashes,
    instancedGeometryAabbs: baseGeometry?.instancedGeometryAabbs,
    instancedGeometryVolumes: baseGeometry?.instancedGeometryVolumes,
    geometryVolumesTrusted: geometryVolumesSurviveAlignment(
      baseModel.federationAlignmentStatus,
    ),
    idOffset: baseModel.idOffset,
    keyProperty,
    duplicateAuthoredKeys,
  });
  checkCancelled(signal);
  const head = await buildEntityFingerprints({
    modelId: headId,
    store: headEffective,
    meshes: headGeometry?.meshes ?? [],
    instancedGeometryHashes: headGeometry?.instancedGeometryHashes,
    instancedGeometryAabbs: headGeometry?.instancedGeometryAabbs,
    instancedGeometryVolumes: headGeometry?.instancedGeometryVolumes,
    geometryVolumesTrusted: geometryVolumesSurviveAlignment(
      headModel.federationAlignmentStatus,
    ),
    idOffset: headModel.idOffset,
    keyProperty,
    duplicateAuthoredKeys,
  });
  checkCancelled(signal);
  fallbackPairDuplicateAuthoredKeys([
    { fingerprints: base, store: baseEffective },
    { fingerprints: head, store: headEffective },
  ], duplicateAuthoredKeys);
  return {
    comparedStores,
    mutationVersion,
    baseModelId: baseId,
    headModelId: headId,
    contentVersion,
    keyProperty,
    duplicateAuthoredKeys,
    baseName: baseModel.name,
    headName: headModel.name,
    base,
    head,
  };
}

function collectExcludedHiddenIds(built: BuiltPair, excludedTypes: string[]): Set<number> {
  const ids = new Set<number>();
  const excluded = new Set(excludedTypes.map((t) => t.trim().toUpperCase()).filter(Boolean));
  if (excluded.size === 0) return ids;
  const isExcluded = (fp: EntityFingerprint<CompareRef>): boolean =>
    excluded.has(fp.ifcType.trim().toUpperCase());
  // Keys excluded on either side (a re-class can be excluded via A's or B's type).
  const excludedKeys = new Set<string>();
  for (const side of [built.base, built.head]) {
    for (const fp of side) if (isExcluded(fp)) excludedKeys.add(fp.key);
  }
  // Hide every copy of an excluded key.
  for (const side of [built.base, built.head]) {
    for (const fp of side) if (excludedKeys.has(fp.key)) ids.add(fp.ref.globalId);
  }
  return ids;
}

export function comparePreparedPair(built: BuiltPair, options: ComparisonOptions): CompareResult {
  const { scope, excludedTypes, matchByContent, acceptedIdentity } = options;
  // The strip decision, the warning flag and its placement-only nuance are ONE
  // resolution (`resolveGeometryChannel`), so the panel's warning can never
  // disagree with what the engine was actually given: a MIXED-capability pair
  // (one side mesh-hashed) has placement fingerprints stripped from both sides
  // so the engine's asymmetry abstention can fire; a symmetric mesh-less pair
  // keeps them, still reports placement-driven moves, and the warning must say
  // reshapes-only.
  const {
    base,
    head,
    geometryUnavailable,
    placementOnlyGeometry,
  } = resolveGeometryChannel(built.base, built.head);

  const diff = diffModels(base, head, {
    scope,
    excludeTypes: excludedTypes,
    // #1891. On by default: a from-scratch re-export re-GUIDs every element,
    // and a pure key diff then reports the entire model as deleted-and-added.
    // The world `aabb` rides on the fingerprints (#2005), so a 1:1 geometry
    // mismatch reports a real distance; an entity the wasm pass produced no box
    // for still degrades to a bare `moved`, the engine's documented fallback.
    matchUnpairedByContent: matchByContent,
    // #4955. Suggestions, never decisions: neither stage retires an entry or
    // touches a count, and both abstain with the content pass when a side has
    // no geometry. The panel's Suggestions section lists what they found.
    detectSplitMerge: true,
    detectSuccessors: true,
    // The pairs the user accepted (or imported) this session, replayed so
    // they classify by key and leave the suggestions. Read HERE with the
    // other options, under the same no-await rule.
    keyAliases: keyAliasesFromAccepted(acceptedIdentity ?? []),
  });
  return {
    baseModelId: built.baseModelId,
    headModelId: built.headModelId,
    baseName: built.baseName,
    headName: built.headName,
    scope,
    geometryUnavailable,
    placementOnlyGeometry,
    excludedHiddenIds: collectExcludedHiddenIds(built, excludedTypes),
    diff,
    // #4989: the scheme THIS extraction ran under, not whatever the store
    // holds now — see the doc comment on `BuiltPair.keyProperty`.
    keyProperty: built.keyProperty,
    duplicateAuthoredKeys: built.duplicateAuthoredKeys.size > 0 ? built.duplicateAuthoredKeys : undefined,
    comparedStores: built.comparedStores.size > 0 ? built.comparedStores : undefined,
    mutationVersion: built.mutationVersion,
  };
}
