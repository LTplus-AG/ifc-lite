/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite layer log|bake|revert|rebase` — history-shaped operations on
 * the local layer store: provenance log (newest first), tombstone-free
 * bake for foreign tools, append-only revert layers, and rebase as a
 * re-planned three-way (no operational transform).
 */

import { writeFileSync } from 'node:fs';
import type { AuthorKind, IfcxFile } from '@ifc-lite/ifcx';
import {
  bakeLayers,
  computeLayerId,
  computeStackHash,
  createProvenanceManifest,
  getProvenance,
  setProvenance,
} from '@ifc-lite/ifcx';
import {
  applyResolutions,
  opsToNodes,
  planRebase,
  planThreeWayMerge,
  type MergeConflict,
  type ResolutionInput,
} from '@ifc-lite/merge';
import { getFlag, hasFlag, printJson } from '../output.js';
import {
  defaultPrincipal,
  loadLayer,
  loadRefLayers,
  requireRef,
  resolveLayerId,
  setRef,
  shortId,
  storeFromArgs,
  storeLayer,
  type LayerStore,
} from './layer-store.js';
import { resolveAncestor } from './layer-merge.js';
import { deriveScopeOps, verifyScopeClaims, type DerivedScopeOp } from './layer-publish.js';

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

export interface LogEntry {
  id: string;
  shortId: string;
  hasManifest: boolean;
  authorKind?: AuthorKind;
  principal?: string;
  created?: string;
  intent?: string;
}

/** Provenance log of a ref's layers, newest first. */
export function logRef(store: LayerStore, refName: string): LogEntry[] {
  const ids = requireRef(store, refName).layers;
  const entries: LogEntry[] = [];
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i];
    const manifest = getProvenance(loadLayer(store, id));
    const entry: LogEntry = { id, shortId: shortId(id), hasManifest: manifest !== undefined };
    if (manifest) {
      entry.authorKind = manifest.author.kind;
      entry.principal = manifest.author.principal;
      entry.created = manifest.created;
      entry.intent = manifest.intent;
    }
    entries.push(entry);
  }
  return entries;
}

export async function layerLogCommand(args: string[]): Promise<void> {
  const refName = args[0];
  if (!refName || refName.startsWith('-')) {
    throw new Error('Usage: ifc-lite layer log <ref> [--json]');
  }
  const entries = logRef(storeFromArgs(args), refName);
  if (hasFlag(args, '--json')) {
    printJson(entries);
    return;
  }
  if (entries.length === 0) {
    process.stderr.write(`Ref ${refName} has no layers.\n`);
    return;
  }
  for (const entry of entries) {
    if (!entry.hasManifest) {
      process.stdout.write(`${entry.shortId}  (no manifest)\n`);
      continue;
    }
    process.stdout.write(
      `${entry.shortId}  ${entry.authorKind}:${entry.principal}  ${entry.created}  ${entry.intent}\n`
    );
  }
}

// ---------------------------------------------------------------------------
// bake
// ---------------------------------------------------------------------------

/** Bake a ref's stack into one tombstone-free flat document. */
export function bakeRef(store: LayerStore, refName: string): IfcxFile {
  const layers = loadRefLayers(store, refName);
  if (layers.length === 0) {
    throw new Error(`Ref ${refName} has no layers to bake`);
  }
  return bakeLayers(layers);
}

export async function layerBakeCommand(args: string[]): Promise<void> {
  const refName = args[0];
  const outPath = getFlag(args, '-o') ?? getFlag(args, '--out');
  if (!refName || refName.startsWith('-') || !outPath) {
    throw new Error('Usage: ifc-lite layer bake <ref> -o <out.ifcx> [--json]');
  }
  const store = storeFromArgs(args);
  const baked = bakeRef(store, refName);
  writeFileSync(outPath, `${JSON.stringify(baked, null, 2)}\n`, 'utf-8');
  if (hasFlag(args, '--json')) {
    printJson({ ref: refName, out: outPath, nodes: baked.data.length });
  } else {
    process.stderr.write(`Baked ${refName} (${baked.data.length} node(s)) → ${outPath}\n`);
  }
}

// ---------------------------------------------------------------------------
// revert
// ---------------------------------------------------------------------------

export type RevertOutcome =
  | { status: 'conflicts'; conflicts: MergeConflict[] }
  | { status: 'reverted'; revertLayerId: string; refLayers: string[] };

/**
 * Publish an inverse-op layer for `layerId` and append it to the ref.
 *
 * Reverting a non-tip layer is a three-way plan, not a blind inverse:
 * ancestor = the stack through the target layer, theirs = the stack with
 * the target undone, ours = the ref's current state. Components later
 * layers also touched surface as conflicts instead of being silently
 * restored to their pre-target values (`--resolve ours|theirs` decides
 * them in bulk).
 */
export function revertInRef(
  store: LayerStore,
  layerId: string,
  refName: string,
  options: { principal?: string; created?: string; resolve?: 'ours' | 'theirs' } = {}
): RevertOutcome {
  const id = resolveLayerId(store, layerId);
  const entry = requireRef(store, refName);
  const idx = entry.layers.indexOf(id);
  if (idx === -1) {
    throw new Error(`Layer ${id} is not part of ref ${refName}`);
  }
  const before = entry.layers.slice(0, idx).map((lid) => loadLayer(store, lid));
  const through = entry.layers.slice(0, idx + 1).map((lid) => loadLayer(store, lid));
  const current = loadRefLayers(store, refName);

  // A→T is the inverse of the target layer; A→O is everything later
  // layers changed. The matrix folds disjoint edits and flags overlaps.
  const plan = planThreeWayMerge({ ancestor: through, ours: current, theirs: before });
  const resolutions = options.resolve
    ? plan.conflicts.map((conflict) => {
        const resolution: ResolutionInput = { path: conflict.path, choice: options.resolve as 'ours' | 'theirs' };
        if (conflict.componentKey !== undefined) resolution.componentKey = conflict.componentKey;
        return resolution;
      })
    : [];
  const applied = applyResolutions(plan, resolutions);
  if (applied.unresolved.length > 0) {
    return { status: 'conflicts', conflicts: applied.unresolved };
  }

  const manifest = createProvenanceManifest({
    author: { kind: 'human', principal: options.principal ?? defaultPrincipal() },
    intent: `Revert layer ${id}`,
    base: { kind: 'stack', id: computeStackHash(entry.layers) },
    created: options.created,
    parents: [id],
  });
  const target = loadLayer(store, id);
  const bare: IfcxFile = {
    header: {
      id: '',
      ifcxVersion: target.header.ifcxVersion,
      dataVersion: target.header.dataVersion,
      author: manifest.author.principal,
      timestamp: manifest.created,
    },
    imports: [],
    schemas: {},
    data: opsToNodes([...plan.autoOps, ...applied.ops]),
  };
  const withManifest = setProvenance(bare, manifest);
  const revertLayerId = computeLayerId(withManifest);
  storeLayer(store, { ...withManifest, header: { ...withManifest.header, id: revertLayerId } });
  const refLayers = [...entry.layers, revertLayerId];
  setRef(store, refName, { ...entry, layers: refLayers });
  return { status: 'reverted', revertLayerId, refLayers };
}

export async function layerRevertCommand(args: string[]): Promise<void> {
  const layerId = args[0];
  const refName = getFlag(args, '--in');
  if (!layerId || layerId.startsWith('-') || !refName) {
    throw new Error(
      'Usage: ifc-lite layer revert <layer-id> --in <ref> [--resolve ours|theirs] [--json]'
    );
  }
  const store = storeFromArgs(args);
  const options: { principal?: string; resolve?: 'ours' | 'theirs' } = {};
  const principal = getFlag(args, '--principal');
  if (principal !== undefined) options.principal = principal;
  const resolve = getFlag(args, '--resolve');
  if (resolve !== undefined) {
    if (resolve !== 'ours' && resolve !== 'theirs') {
      throw new Error('--resolve must be ours or theirs');
    }
    options.resolve = resolve;
  }
  const result = revertInRef(store, layerId, refName, options);
  const json = hasFlag(args, '--json');
  if (result.status === 'conflicts') {
    if (json) printJson({ status: 'conflicts', conflicts: result.conflicts });
    else {
      process.stderr.write(
        `${result.conflicts.length} conflict(s): later layers touched components this revert would restore.\n`
      );
      for (const c of result.conflicts) {
        const component = c.componentKey ? ` ${c.componentKey}` : '';
        process.stderr.write(`  [${c.kind}] ${c.path}${component}\n`);
      }
      process.stderr.write('Re-run with --resolve ours|theirs to decide them in bulk.\n');
    }
    process.exit(2);
    return;
  }
  if (json) {
    printJson({ status: 'reverted', revertLayer: result.revertLayerId, ref: refName, layers: result.refLayers });
  } else {
    process.stdout.write(`${result.revertLayerId}\n`);
    process.stderr.write(`Reverted ${shortId(layerId)} in ${refName}\n`);
  }
}

// ---------------------------------------------------------------------------
// rebase
// ---------------------------------------------------------------------------

export type RebaseOutcome =
  | { status: 'conflicts'; conflicts: MergeConflict[] }
  | {
      status: 'rebased';
      layerId: string;
      file: IfcxFile;
      /** Carried claims re-verified against the rebased writes (07 §7.2). */
      scopeVerified: boolean;
      violations: DerivedScopeOp[];
    };

/** Re-plan a candidate onto a ref's current stack and publish the result. */
export function rebaseLayerOnto(
  store: LayerStore,
  layerId: string,
  ontoRef: string,
  options: { principal?: string; created?: string } = {}
): RebaseOutcome {
  const candidateId = resolveLayerId(store, layerId);
  const candidate = loadLayer(store, candidateId);
  const manifest = getProvenance(candidate);
  const entry = requireRef(store, ontoRef);

  const oldBase = resolveAncestor(store, entry.layers, manifest?.base ?? null);
  if (!oldBase.matched) {
    process.stderr.write(
      'Warning: candidate base is unknown or not a prefix of the target ref — rebasing from an empty base\n'
    );
  }
  const newBase = loadRefLayers(store, ontoRef);
  const { plan, applied } = planRebase({ candidate, oldBase: oldBase.layers, newBase });
  if (applied.unresolved.length > 0) {
    return { status: 'conflicts', conflicts: applied.unresolved };
  }

  const manifestOut = createProvenanceManifest({
    author: manifest?.author ?? { kind: 'human', principal: options.principal ?? defaultPrincipal() },
    intent: `${manifest?.intent ?? `Rebase ${candidateId}`} (rebased)`,
    base: { kind: 'stack', id: computeStackHash(entry.layers) },
    created: options.created,
    parents: [candidateId],
    scope_claim: manifest?.scope_claim ?? [],
  });
  const bare: IfcxFile = {
    header: {
      id: '',
      ifcxVersion: candidate.header.ifcxVersion,
      dataVersion: candidate.header.dataVersion,
      author: manifestOut.author.principal,
      timestamp: manifestOut.created,
    },
    imports: [],
    schemas: {},
    data: opsToNodes([...plan.autoOps, ...applied.ops]),
  };
  // Carried claims must be re-verified against the rebased writes and the
  // new base — rebasing can change which entities the ops touch, so a
  // claim that covered the original delta may no longer cover this one.
  // Mismatch is flagged, never silently accepted (07 §7.2).
  const scopeOps = deriveScopeOps(bare, newBase);
  const { verified, violations } = verifyScopeClaims(manifestOut.scope_claim, scopeOps);

  const withManifest = setProvenance(bare, manifestOut);
  const newId = computeLayerId(withManifest);
  const file: IfcxFile = { ...withManifest, header: { ...withManifest.header, id: newId } };
  storeLayer(store, file);
  return { status: 'rebased', layerId: newId, file, scopeVerified: verified, violations };
}

export async function layerRebaseCommand(args: string[]): Promise<void> {
  const layerId = args[0];
  const ontoRef = getFlag(args, '--onto');
  if (!layerId || layerId.startsWith('-') || !ontoRef) {
    throw new Error('Usage: ifc-lite layer rebase <layer-id> --onto <ref> [--json]');
  }
  const store = storeFromArgs(args);
  const options: { principal?: string } = {};
  const principal = getFlag(args, '--principal');
  if (principal !== undefined) options.principal = principal;
  const outcome = rebaseLayerOnto(store, layerId, ontoRef, options);
  const json = hasFlag(args, '--json');
  if (outcome.status === 'conflicts') {
    if (json) printJson({ status: 'conflicts', conflicts: outcome.conflicts });
    else {
      process.stderr.write(`${outcome.conflicts.length} conflict(s) rebasing onto ${ontoRef}:\n`);
      for (const c of outcome.conflicts) {
        const component = c.componentKey ? ` ${c.componentKey}` : '';
        process.stderr.write(`  [${c.kind}] ${c.path}${component}\n`);
      }
    }
    process.exit(2);
    return;
  }
  if (!outcome.scopeVerified) {
    process.stderr.write('Warning: scope claim mismatch — rebased ops outside the declared claims:\n');
    for (const op of outcome.violations) {
      const type = op.ifcType ? ` (${op.ifcType})` : '';
      process.stderr.write(`  ${op.path}: ${op.capability}${type}\n`);
    }
  }
  if (json) {
    printJson({ status: 'rebased', id: outcome.layerId, scope_verified: outcome.scopeVerified });
  } else {
    process.stdout.write(`${outcome.layerId}\n`);
    process.stderr.write(`Rebased ${shortId(layerId)} onto ${ontoRef}\n`);
  }
}
