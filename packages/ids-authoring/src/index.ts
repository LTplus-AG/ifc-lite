/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/ids-authoring — the headless IDS authoring core.
 *
 * Every authoring surface (UI, AI agent, imports, CLI, MCP) changes an IDS
 * only by dispatching the typed operations defined here. See
 * `docs/architecture/ids-studio/03-architecture/02-document-model-and-ops.md`.
 */

export { uuidv7, deriveId, isUuid, type Uuid, type UuidV7Source } from './uuid.js';

// Document model (IDS-016)
export {
  STUDIO_SCHEMA_VERSION,
  type StudioDocument,
  type NodeIndex,
  type SpecNodes,
  type FacetNodes,
  type NodeKind,
  type NodeLocation,
  type Section,
  type StudioMeta,
  type Provenance,
  type SourceSpan,
  type CommentThread,
  type Suppression,
  type CustomPsetDecl,
  type UserDefinedTypeDecl,
  type RevisionInfo,
} from './document/types.js';
export type { FacetFieldName } from './document/fields.js';
export { fromIdsDocument, createStudioDocument, type FromIdsOptions } from './document/from-ids.js';
export { locateNode, verifyNodeIndex } from './document/node-index.js';

// Operation vocabulary v1 (IDS-017, IDS-018)
export {
  OPS_VERSION,
  type Op,
  type StudioOp,
  type PrimitiveOp,
  type CompoundOp,
  type OpKind,
  type OpOfKind,
  type Scalar,
  type XsdBase,
  type ConstraintDraft,
  type RawConstraint,
  type ValueInput,
  type FacetDraft,
  type ConstraintIds,
  type InfoField,
  type SpecCardinality,
  type SpecTextField,
  type SpecPatch,
  type FacetPatch,
  type RequirementSnapshot,
  type OpTemplate,
  type TemplateOp,
} from './ops/types.js';
export { OP_KINDS, validateOp, getOpJsonSchema, type OpValidation } from './ops/schema.js';
export type { SchemaError } from './ops/json-schema-lite.js';
export { normaliseValue, facetFromDraft, DraftError } from './ops/draft.js';

// Reducer (IDS-019)
export { apply, OpApplyError, type ApplyResult } from './reducer/apply.js';

// Grounding gate (IDS-021, IDS-022, IDS-023)
export { checkOps } from './gate/check.js';
export { createGateContext, type GateContext, type VersionTables } from './gate/context.js';
export type { GateCode, GateCandidate, GateIssue, GateResult } from './gate/types.js';

// History, transactions, persistence boundary (IDS-024)
export {
  createStudioState,
  commit,
  undo,
  redo,
  canUndo,
  canRedo,
  beginTransaction,
  DEFAULT_HISTORY_LIMIT,
  type StudioState,
  type History,
  type HistoryEntry,
  type HistorySource,
  type CommitInfo,
  type Transaction,
} from './history/history.js';
export {
  toPersisted,
  fromPersisted,
  createMemoryPersistenceAdapter,
  PERSISTED_FORMAT,
  type PersistenceAdapter,
  type PersistedStudioState,
  type PersistedSummary,
} from './history/persistence.js';

// Sidecar and .idsz bundle (IDS-025)
export {
  createSidecar,
  serializeSidecar,
  parseSidecar,
  attachSidecar,
  fingerprintIds,
  SIDECAR_FILENAME,
  SIDECAR_FORMAT,
  type StudioSidecar,
  type AttachResult,
  type AttachOptions,
} from './sidecar/sidecar.js';
export { writeIdsz, readIdsz, type IdszContent } from './sidecar/idsz.js';

// Re-identification (IDS-026)
export { reidentify, type ReidentifyReport, type ReidentifyOptions, type MatchStep } from './match/reidentify.js';

// Plain-language rendering (IDS-027)
export { describeFacet } from './render/describe.js';

// Lint engine (IDS-046)
export { createLintContext } from './lint/context.js';
export { createLinter, lintDocument, lintDocsUrl, type Linter, type LinterOptions } from './lint/engine.js';
export { checkQuickFix } from './lint/fix.js';
export { LINT_RULES } from './lint/rules/index.js';
export { explainXsdPattern, type PatternExplanation } from './lint/rules/xsd-regex.js';
export type {
  Diagnostic,
  DocumentRule,
  FacetView,
  Finding,
  LintArea,
  LintContext,
  LintOptions,
  LintResult,
  LintRule,
  LintRuleMeta,
  LintSeverity,
  QuickFix,
  RuleInput,
  SpecRule,
  SpecView,
  SuppressedDiagnostic,
} from './lint/types.js';

// Headless surfaces: CLI, MCP, SDK, Flow (IDS-115, IDS-118)
export { readStudioDocument, studioDocumentFromIds, parseStudioDocument } from './headless/read.js';
export {
  formatIds,
  writeIdsChecked,
  writeStudioDocument,
  type IdsWriter,
  type WriteOutcome,
  type WriteFailure,
  type FormatOutcome,
} from './headless/write.js';
export { nodePath } from './headless/node-path.js';
export { diffIds, type IdsDiff, type IdsDiffEntry, type IdsDiffChange } from './headless/diff.js';
export { applyOpsGated, type GatedApplyResult } from './headless/apply-gated.js';
export {
  searchSchema,
  describeEntity,
  describePset,
  type SchemaKind,
  type SchemaHit,
  type SchemaSearchOptions,
  type EntityDescription,
  type PsetDescription,
} from './headless/schema-lookup.js';
