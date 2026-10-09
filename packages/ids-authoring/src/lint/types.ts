/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lint shapes (03-diagnostics-audit-lint.md §1, §4).
 *
 * Lint answers "does this IDS mean what the author intends?", where the
 * audit answers "is this a valid IDS 1.0 file?". Every surface (UI, agent,
 * CLI, MCP) consumes the same `Diagnostic[]`.
 *
 * A quick fix is DATA: a labelled batch of Studio ops. Nothing in lint
 * mutates a document; a host checks the batch with `checkOps` (the
 * grounding gate) and commits it like any other edit. Fixes are never
 * applied automatically.
 */

import type { IfcAttributeInfo, IfcSchemaVersion } from '@ifc-lite/data';
import type { IDSFacet, IDSRequirement, IDSSpecification, IFCVersion } from '@ifc-lite/ids';
import type { FacetFieldName } from '../document/fields.js';
import type { Section, SpecNodes, StudioDocument, Suppression } from '../document/types.js';
import type { BsddUriIndex } from '../bsdd/uri-health.js';
import type { GateContext } from '../gate/context.js';
import type { StudioOp } from '../ops/types.js';
import type { Uuid } from '../uuid.js';

export type LintSeverity = 'error' | 'warning' | 'info';

/** Rule areas of the catalogue (`IDSL-<AREA>-<nnn>`). */
export type LintArea =
  | 'ENT'
  | 'PDT'
  | 'ATT'
  | 'PSET'
  | 'PROP'
  | 'VAL'
  | 'UNIT'
  | 'REGEX'
  | 'CARD'
  | 'SPEC'
  | 'DOC'
  | 'VER'
  | 'PART'
  | 'BSDD';

export interface QuickFix {
  /** Short imperative label, e.g. `Remove the anchors`. */
  label: string;
  /** The op batch. Run it through `checkOps` before committing it. */
  ops: StudioOp[];
}

export interface Diagnostic {
  /** Stable rule code, e.g. `IDSL-REGEX-001`. */
  code: string;
  severity: LintSeverity;
  /**
   * The most specific node the finding is about: a constraint node when
   * `field` is set, else a requirement / applicability facet, a
   * specification or the document node.
   */
  nodeId: Uuid;
  /** The specification the node belongs to (absent for document findings). */
  specId?: Uuid;
  field?: FacetFieldName;
  message: string;
  /** Long-form explanation (the rule's rationale). */
  why?: string;
  fixes?: QuickFix[];
  /** Per-rule documentation page. */
  docsUrl: string;
}

/** A diagnostic silenced by a `Suppression` in `meta.suppressions`. */
export interface SuppressedDiagnostic {
  diagnostic: Diagnostic;
  /** Node the suppression is attached to (the node itself or an ancestor). */
  suppressedAt: Uuid;
  suppression: Suppression;
}

/** One facet of a specification, with its node ids. */
export interface FacetView {
  facet: IDSFacet;
  facetId: Uuid;
  section: Section;
  /** Position within its section. */
  index: number;
  /** Present for requirements. */
  requirement?: IDSRequirement;
  constraintIds: Readonly<Partial<Record<FacetFieldName, Uuid>>>;
}

/** A specification as rules see it. */
export interface SpecView {
  spec: IDSSpecification;
  nodes: SpecNodes;
  specId: Uuid;
  index: number;
  /** Distinct IFC versions of the spec. */
  versions: IFCVersion[];
  applicability: FacetView[];
  requirements: FacetView[];
}

/** What a finding carries before the engine stamps code, severity and docs. */
export interface Finding {
  nodeId: Uuid;
  /**
   * Demote this finding below the rule's default severity (e.g. a construct
   * the reference tools accept in practice). Ignored when the caller
   * overrides the rule's severity.
   */
  severity?: LintSeverity;
  field?: FacetFieldName;
  message: string;
  fixes?: QuickFix[];
}

export interface LintContext {
  /** Schema tables (shared with the grounding gate). */
  readonly gate: GateContext;
  /** Attribute metadata per IFC version, keyed by lower-case attribute name. */
  readonly attributes: Readonly<Record<IfcSchemaVersion, ReadonlyMap<string, IfcAttributeInfo>>>;
  /** Checked bSDD URIs (IDSL-BSDD-*). Without it the bSDD rules find nothing. */
  readonly bsdd?: BsddUriIndex;
}

export interface RuleInput {
  ctx: LintContext;
  doc: StudioDocument;
}

export interface LintRuleMeta {
  code: string;
  area: LintArea;
  defaultSeverity: LintSeverity;
  /** `static` rules need no model; `model` rules are run by the model loop (P-05). */
  kind: 'static' | 'model';
  /** One-line title for tables and the docs index. */
  title: string;
  /** Long-form rationale, shown as `Diagnostic.why` and on the docs page. */
  rationale: string;
  /** What the quick fix does, when the rule offers one. */
  fix?: string;
  /** RAID assumptions the rule depends on, with how they were verified. */
  assumptions?: { id: string; verified: string }[];
  /** Upstream references (IDS issues, documentation). */
  references?: string[];
  /** A minimal triggering example (IDS XML fragment) for the docs. */
  example?: string;
}

/** Re-run when the specification (or the document's custom declarations) changes. */
export interface SpecRule extends LintRuleMeta {
  scope: 'spec';
  check(spec: SpecView, input: RuleInput): Finding[];
}

/** Re-run on every lint pass; sees all specifications at once. */
export interface DocumentRule extends LintRuleMeta {
  scope: 'document';
  check(specs: readonly SpecView[], input: RuleInput): Finding[];
}

export type LintRule = SpecRule | DocumentRule;

export interface LintOptions {
  /** Restrict to these rule codes (default: every registered rule). */
  rules?: readonly string[];
  /** Per-code severity override; `'off'` disables the rule. */
  severity?: Readonly<Record<string, LintSeverity | 'off'>>;
}

export interface LintResult {
  diagnostics: Diagnostic[];
  suppressed: SuppressedDiagnostic[];
  stats: {
    /** Specifications whose spec-scoped rules ran in this pass. */
    specsLinted: number;
    /** Specifications whose cached findings were reused. */
    specsReused: number;
  };
}
