/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `@ifc-lite/provenance` — prototype certificate library for node-hash-v0
 * (docs/vision/spec/node-hash-v0.md, M1 "Proof-carrying buildings").
 *
 * Pure and store-agnostic, like `@ifc-lite/diff`: this package never touches
 * a parser, WASM, or a renderer. Callers supply node payloads (extracted
 * however they like) to {@link computeNodeHash}, and an async
 * `nodeId -> payload` {@link NodeResolver} to {@link verifyCertificate}.
 */

export {
  computeNodeHash,
  hashResolvedNode,
  type NodeKind,
  type PayloadForKind,
  type GeometryMeshPayload,
  type PropertySetPayload,
  type PropertyValue,
  type RelationshipPayload,
  type LayerPayload,
  type ElementPayload,
  type ResolvedNode,
} from './node-hash.js';

export {
  CERTIFICATE_VERSION,
  createCertificate,
  verifyCertificate,
  type Certificate,
  type CreateCertificateInput,
  type NodeRef,
  type NodeResolver,
  type Claim,
  type SubtreeUntouchedClaim,
  type HashEqualityClaim,
  type ScalarDeltaClaim,
  type VerifyOptions,
  type VerificationResult,
  type VerificationOk,
  type VerificationFailure,
} from './certificate.js';

export {
  ProvenanceDag,
  type NodeSpec,
  type LeafNodeSpec,
  type CompositeNodeSpec,
  type AnyNodeSpec,
  type AnyLeafNodeSpec,
  type AnyCompositeNodeSpec,
  type RecomputeTelemetry,
} from './dag-engine.js';

export {
  computeFootprint,
  conflictPredicate,
  inflateAabb,
  aabbFromMesh,
  unionAabb,
  DEFAULT_EPSILON_MM,
  type Aabb,
  type EditOp,
  type EditOpKind,
  type Footprint,
  type ConflictResult,
  type ConflictOptions,
  type SpatialRuleMode,
} from './footprint.js';

export {
  applyOp,
  applyOps,
  buildStateDag,
  canonicalStateBytes,
  cloneState,
  computeMergeOpFootprint,
  hashModelState,
  HOST_CONTAINMENT_TOLERANCE_M,
  MERGE_MODEL_ROOT_NODE_ID,
  OpApplicationError,
  SpatialRejectionError,
  stripVoidMarkers,
  type EntityInit,
  type EntityState,
  type MergeOp,
  type ModelState,
} from './merge-model.js';

export {
  attemptBothOrders,
  COMMUTATION_CERTIFICATE_VERSION,
  createCommutationCertificate,
  findCrossConflicts,
  verifyCommutationCertificate,
  type CommutationCertificate,
  type CommutationInput,
  type CommutationOutcome,
  type CommutationVerificationResult,
  type CommutationVerifyOptions,
  type OpConflict,
  type OpSetSummary,
  type ReplayOutcome,
} from './commutation.js';

export {
  buildBaseModel,
  generateClientOps,
  mulberry32,
  runMergeBattery,
  runSpatialAblation,
  wilsonInterval,
  Z_95,
  type MergeBatteryOptions,
  type MergeBatteryReport,
  type Rng,
  type SpatialAblationReport,
  type WilsonInterval,
} from './merge-battery.js';
