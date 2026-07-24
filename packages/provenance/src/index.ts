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
  type RecomputeTelemetry,
} from './dag-engine.js';
