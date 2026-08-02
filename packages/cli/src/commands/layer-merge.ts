/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite layer merge <layer-id> --into <ref>` — CLI transport for the
 * shared merge flow in `@ifc-lite/merge` (ref-flow.ts): fast-forward,
 * three-way planning with explicit conflicts, blanket resolutions
 * (--resolve ours|theirs), and ref-policy enforcement. The registry route
 * runs the identical flow server-side.
 *
 * Exit codes (09 §9.3): 0 clean, 2 conflicts, 3 policy failure,
 * 5 unrelated base.
 */

import type { ProvenanceBase } from '@ifc-lite/ifcx';
import {
  mergeIntoRef as mergeIntoRefShared,
  resolveAncestor as resolveAncestorShared,
  type AncestorResolution,
  type LayerRefStore,
  type MergeConflict,
  type MergeInit,
  type MergeOutcome,
  type Waiver,
} from '@ifc-lite/merge';
import { getAllFlags, getFlag, hasFlag, printJson } from '../output.js';
import {
  defaultPrincipal,
  getRef,
  loadLayer,
  resolveLayerId,
  setRef,
  shortId,
  storeFromArgs,
  storeLayer,
  type LayerStore,
} from './layer-store.js';

export { checkRefPolicy, type MergeInit, type MergeOutcome, type Waiver } from '@ifc-lite/merge';

/** The shared flow's store surface, backed by the local `.ifc-lite/` store. */
export function refStoreFor(store: LayerStore): LayerRefStore {
  return {
    loadLayer: (id) => loadLayer(store, id),
    storeLayer: (file) => storeLayer(store, file),
    getRef: (name) => getRef(store, name),
    setRef: (name, entry) => setRef(store, name, entry),
    resolveLayerId: (idOrPrefix) => resolveLayerId(store, idOrPrefix),
  };
}

/** CLI entry to the shared merge flow; defaults the resolver principal. */
export function mergeIntoRef(store: LayerStore, init: MergeInit): MergeOutcome {
  return mergeIntoRefShared(refStoreFor(store), {
    ...init,
    principal: init.principal ?? defaultPrincipal(),
  });
}

/** CLI-signature wrapper kept for the history (revert/rebase) commands. */
export function resolveAncestor(
  store: LayerStore,
  refLayerIds: readonly string[],
  base: ProvenanceBase | null | undefined
): AncestorResolution {
  return resolveAncestorShared({ loadLayer: (id) => loadLayer(store, id) }, refLayerIds, base);
}

// ---------------------------------------------------------------------------
// command
// ---------------------------------------------------------------------------

function parseWaivers(args: string[]): Waiver[] {
  const specs = getAllFlags(args, '--waive');
  const reasons = getAllFlags(args, '--reason');
  if (specs.length !== reasons.length) {
    throw new Error('Each --waive <spec> requires a matching --reason "<text>"');
  }
  return specs.map((spec, i) => ({ spec, reason: reasons[i] }));
}

function printConflicts(conflicts: readonly MergeConflict[]): void {
  process.stderr.write(`${conflicts.length} conflict(s):\n`);
  for (const c of conflicts) {
    const component = c.componentKey ? ` ${c.componentKey}` : '';
    process.stderr.write(`  [${c.kind}] ${c.path}${component}\n`);
  }
}

export async function layerMergeCommand(args: string[]): Promise<void> {
  const candidateId = args[0];
  const into = getFlag(args, '--into');
  if (!candidateId || candidateId.startsWith('-') || !into) {
    throw new Error(
      'Usage: ifc-lite layer merge <layer-id> --into <ref> [--preview] [--resolve ours|theirs] [--waive <spec> --reason "<text>"]... [--approved-by <principal>] [--allow-unrelated] [--json]'
    );
  }
  const resolveFlag = getFlag(args, '--resolve');
  if (resolveFlag !== undefined && resolveFlag !== 'ours' && resolveFlag !== 'theirs') {
    throw new Error(`--resolve must be "ours" or "theirs", got "${resolveFlag}"`);
  }

  const store = storeFromArgs(args);
  const init: MergeInit = {
    candidateId,
    into,
    preview: hasFlag(args, '--preview'),
    waivers: parseWaivers(args),
    allowUnrelated: hasFlag(args, '--allow-unrelated'),
  };
  if (resolveFlag !== undefined) init.resolve = resolveFlag;
  const approvedBy = getFlag(args, '--approved-by');
  if (approvedBy !== undefined) init.approvedBy = approvedBy;
  const principal = getFlag(args, '--principal');
  if (principal !== undefined) init.principal = principal;

  const outcome = mergeIntoRef(store, init);
  const json = hasFlag(args, '--json');

  if (
    outcome.status !== 'policy-failure' &&
    outcome.status !== 'unrelated-base' &&
    outcome.status !== 'fast-forward' &&
    !outcome.ancestorMatched
  ) {
    process.stderr.write(
      'Warning: candidate base is unknown or not a prefix of the target ref — using an empty ancestor\n'
    );
  }

  switch (outcome.status) {
    case 'fast-forward':
      if (json) printJson({ status: outcome.status, ref: into, layers: outcome.refLayers });
      else process.stdout.write(`Fast-forwarded ${into} to ${shortId(candidateId)}\n`);
      return;
    case 'preview':
      if (json) printJson(outcome.plan);
      else {
        process.stdout.write(
          `plan: ${outcome.plan.autoOps.length} auto op(s), ${outcome.plan.conflicts.length} conflict(s)\n`
        );
        if (outcome.plan.conflicts.length > 0) printConflicts(outcome.plan.conflicts);
      }
      if (outcome.plan.conflicts.length > 0) process.exit(2);
      return;
    case 'conflicts':
      if (json) printJson({ status: outcome.status, conflicts: outcome.conflicts });
      else printConflicts(outcome.conflicts);
      process.exit(2);
      return;
    case 'policy-failure':
      if (json) printJson({ status: outcome.status, reason: outcome.reason });
      else process.stderr.write(`Policy failure: ${outcome.reason}\n`);
      process.exit(3);
      return;
    case 'unrelated-base':
      if (json) printJson({ status: outcome.status, declaredBase: outcome.declaredBase });
      else {
        process.stderr.write(
          `Candidate declares base ${outcome.declaredBase.kind} ${outcome.declaredBase.id} which matches nothing on ${into} — ` +
            'it was authored against a different history. Re-run with --allow-unrelated to merge against an empty ancestor (every candidate op will read as new).\n'
        );
      }
      process.exit(5);
      return;
    case 'merged':
      if (json) {
        printJson({
          status: outcome.status,
          mergeLayer: outcome.mergeLayerId,
          ref: into,
          layers: outcome.refLayers,
        });
      } else {
        process.stdout.write(`${outcome.mergeLayerId}\n`);
        process.stderr.write(`Merged ${shortId(candidateId)} into ${into}\n`);
      }
      return;
  }
}
