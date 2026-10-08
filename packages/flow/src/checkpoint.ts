/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `@ifc-lite/flow/checkpoint`: review checkpoints for runs that paused at a
 * node declaring `review: 'required'` (#6923). A separate entry, so a host
 * that only runs graphs does not load the checkpoint lifecycle.
 */

export { checkpointProposal, createCheckpoint, graphDigest, resumeOutputs } from './checkpoint-record.js';
export type { CheckpointState, CreateCheckpointInput, FlowCheckpoint, PortableFlowData, PortableOutputs } from './checkpoint-record.js';
export {
  approveCheckpoint,
  CheckpointError,
  claimCheckpoint,
  finishCheckpoint,
  parseCheckpoint,
  recoverCheckpoint,
  rejectCheckpoint,
  updateCheckpoint,
} from './checkpoint-state.js';
export type { CheckpointErrorCode, CheckpointStore, ClaimInput, StoredCheckpoint } from './checkpoint-state.js';
