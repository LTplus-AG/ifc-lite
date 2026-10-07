/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite flow` review checkpoints (#6923): pause, review, resume.
 *
 *   flow run    <graph> <model> --checkpoint cp.json [--out paused.ifc]   exits 3 when it paused for review
 *   flow review <cp.json> [--approve <proposal digest> | --reject] [--json]
 *   flow resume <graph> <model> --checkpoint cp.json [--out done.ifc] [--next-checkpoint cp2.json]
 *
 * The approval names the proposal digest the reviewer was shown, so an
 * approval cannot apply to a proposal it did not see. A resume claims the
 * checkpoint once (compare-and-swap on the file), checks that the graph,
 * Player inputs and the model it starts from are the ones the pause
 * recorded, runs only what was paused (completed nodes are restored, never
 * re-executed), and records completed or partially committed.
 */

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { type FlowDocument, type RunResult } from '@ifc-lite/flow';
import {
  approveCheckpoint, checkpointProposal, claimCheckpoint, createCheckpoint, finishCheckpoint, graphDigest,
  recoverCheckpoint, rejectCheckpoint, updateCheckpoint, type FlowCheckpoint
} from '@ifc-lite/flow/checkpoint';
import { redactDeep } from '@ifc-lite/flow-nodes';
import { fatal, printJson } from '../output.js';
import { FileCheckpointStore } from './flow-checkpoint.js';

/** Exit code of a run that stopped at a review checkpoint: not a failure, not done. */
export const PAUSED_FOR_REVIEW = 3;
const LEASE_MS = 10 * 60_000;

function describe(checkpoint: FlowCheckpoint): string[] {
  const lines = [`checkpoint ${checkpoint.id} (${checkpoint.state}) for "${checkpoint.graphName}"`, `  proposal digest ${checkpoint.proposalDigest}`];
  for (const [nodeId, ports] of checkpointProposal(checkpoint)) {
    for (const [port, data] of ports) {
      const value = data.kind === 'item' ? data.value : data.kind === 'list' ? data.items : Object.fromEntries(data.branches);
      lines.push(`  ${nodeId}.${port}: ${JSON.stringify(value)}`);
    }
  }
  return lines;
}

/** Build the exact portable proposal before persisting model or tracking effects. */
export function preparePause(input: Parameters<typeof createCheckpoint>[0], redaction: ReadonlyMap<string, string>): FlowCheckpoint {
  const checkpoint = createCheckpoint(input);
  if (JSON.stringify(checkpoint.outputs) !== JSON.stringify(redactDeep(checkpoint.outputs, redaction))) {
    throw new Error('the paused outputs contain a secret; no checkpoint can be saved or displayed');
  }
  return checkpoint;
}

/** Refuse an existing destination before a resume consumes its approval. */
export async function checkPauseDestination(path: string): Promise<void> {
  if (await stat(path).then(() => true, () => false)) throw new Error(`${path} already exists; a checkpoint is never overwritten`);
}

/** Save the already-validated exact proposal, with atomic collision refusal. */
export async function savePause(path: string, checkpoint: FlowCheckpoint): Promise<FlowCheckpoint> {
  await checkPauseDestination(path);
  if (!(await new FileCheckpointStore(path).write(checkpoint, null))) throw new Error(`${path} is being written by another process`);
  return checkpoint;
}

export function reportPause(checkpoint: FlowCheckpoint, path: string): void {
  for (const line of describe(checkpoint)) process.stdout.write(`${line}\n`);
  process.stdout.write(`paused for review: approve with\n  ifc-lite flow review ${path} --approve ${checkpoint.proposalDigest}\n`);
}

export async function reviewCommand(args: string[], path: string | undefined, json: boolean, approve: string | undefined): Promise<void> {
  if (!path) fatal('Usage: ifc-lite flow review <checkpoint.json> [--approve <proposal digest> | --reject] [--json]');
  const store = new FileCheckpointStore(path);
  const { checkpoint } = await store.load();
  const reject = args.includes('--reject');
  if (approve !== undefined && reject) fatal('pass either --approve or --reject');
  let next = checkpoint;
  try {
    if (approve !== undefined) next = await updateCheckpoint(store, checkpoint.id, (c) => approveCheckpoint(c, approve));
    else if (reject) next = await updateCheckpoint(store, checkpoint.id, (c) => rejectCheckpoint(c));
  } catch (error) {
    fatal((error as Error).message);
  }
  if (json) return printJson({ id: next.id, state: next.state, proposalDigest: next.proposalDigest, reviewNodes: next.reviewNodes,
    proposal: Object.fromEntries([...checkpointProposal(next).keys()].map(node => [node, next.outputs[node]])) });
  for (const line of describe(next)) process.stdout.write(`${line}\n`);
}

/** Ids of the nodes a checkpoint restores. */
export async function checkpointNodes(path: string): Promise<string[]> {
  try {
    return Object.keys((await new FileCheckpointStore(path).load()).checkpoint.outputs);
  } catch (error) {
    fatal(`cannot read checkpoint ${path}: ${(error as Error).message}`);
  }
}

export interface Resume {
  readonly store: FileCheckpointStore;
  readonly checkpoint: FlowCheckpoint;
  readonly owner: string;
}

/** Claim a reviewed checkpoint for this process, after recovering an abandoned claim. */
export async function claimForResume(path: string, doc: FlowDocument, inputs: Record<string, unknown>, sourceDigest: string, registry: NonNullable<Parameters<typeof graphDigest>[2]>): Promise<Resume> {
  const store = new FileCheckpointStore(path);
  const owner = `cli:${process.pid}:${randomUUID()}`;
  try {
    const { checkpoint } = await store.load();
    if (checkpoint.graphId !== doc.id) fatal(`${path} belongs to graph "${checkpoint.graphId}", not "${doc.id}"`);
    if (recoverCheckpoint(checkpoint)) await updateCheckpoint(store, checkpoint.id, (c) => recoverCheckpoint(c) ?? c);
    const claimed = await updateCheckpoint(store, checkpoint.id, (c) => claimCheckpoint(c, { owner, graphDigest: graphDigest(doc, inputs, registry), sourceDigest, leaseMs: LEASE_MS }));
    return { store, checkpoint: claimed, owner };
  } catch (error) {
    fatal((error as Error).message);
  }
}

export async function finishResume(resume: Resume, result: RunResult): Promise<FlowCheckpoint> {
  const failed = result.log.find((l) => l.level === 'error');
  return updateCheckpoint(resume.store, resume.checkpoint.id, (c) => finishCheckpoint(c, resume.owner, {
    ok: result.ok,
    ...(failed ? { message: `${failed.nodeId}: ${failed.message}` } : result.review.length ? { message: `paused again at ${result.review.join(', ')}` } : {}),
  }));
}

/** A failed persistence step must not turn a consumed claim into completed. */
export async function failResume(resume: Resume, message: string): Promise<FlowCheckpoint> {
  return updateCheckpoint(resume.store, resume.checkpoint.id, c => finishCheckpoint(c, resume.owner, { ok: false, message }));
}
