/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Public types for IDS document auditing.
 *
 * The auditor inspects an IDS document for authoring issues — invalid XML,
 * missing required attributes, IFC entities or property sets that don't
 * exist for the declared IFC version, malformed restrictions, etc.
 *
 * This is distinct from `IDSValidationReport` (which describes how an IFC
 * model conforms to a valid IDS).
 */

import type { FacetType, IDSDocument, IFCVersion } from '../types.js';

/** Severity buckets for audit issues. */
export type IDSAuditSeverity = 'error' | 'warning' | 'info';

/**
 * Stable string-literal codes for every audit issue the library can raise.
 *
 * Codes are grouped by source: `E_PARSE_*` (parser shim), `E_XSD_*` /
 * `W_XSD_*` (XSD-level checks), `E_IFC_*` / `W_IFC_*` (IFC schema cross-
 * checks), `E_RESTRICTION_*` / `W_REGEX_*` / `E_CARDINALITY_*` /
 * `W_CARDINALITY_*` (coherence checks).
 *
 * Stable across minor versions — additions are backwards-compatible.
 */
export type IDSAuditCode =
  // Parser
  | 'E_PARSE_XML'
  | 'E_PARSE_ROOT'
  | 'E_PARSE_FACET'
  | 'E_PARSE_UNKNOWN'
  // XSD
  | 'E_XSD_REQUIRED_ATTR'
  | 'E_XSD_ENUM'
  | 'E_XSD_PATTERN'
  | 'E_XSD_STRUCTURE'
  | 'W_XSD_DEPRECATED'
  // IFC schema cross-checks
  | 'E_IFC_ENTITY_UNKNOWN'
  | 'E_IFC_PREDEF_TYPE_INVALID'
  | 'E_IFC_PSET_UNKNOWN'
  | 'W_IFC_PSET_RESERVED_PREFIX'
  | 'E_IFC_PROP_NOT_IN_PSET'
  | 'W_IFC_DATATYPE_MISMATCH'
  | 'E_IFC_ATTR_UNKNOWN_FOR_ENTITY'
  | 'E_IFC_PARTOF_RELATION'
  | 'E_IFC_PARTOF_ENTITY'
  // Restriction & cardinality coherence
  | 'E_RESTRICTION_EMPTY'
  | 'E_RESTRICTION_RANGE'
  | 'W_REGEX_UNVERIFIED'
  | 'E_CARDINALITY_INVALID'
  | 'W_CARDINALITY_PROHIBITED_APPLICABILITY';

/** A single audit finding. */
export interface IDSAuditIssue {
  /** Severity bucket. `error` issues fail the audit; `warning`/`info` do not. */
  severity: IDSAuditSeverity;
  /** Stable string-literal code for programmatic dispatch. */
  code: IDSAuditCode;
  /** Human-readable message. Localised via the translator if one is provided. */
  message: string;
  /** XPath-ish path into the document (e.g., `specifications[0].applicability.facets[1]`). */
  path: string;
  /**
   * Optional 1-based source line of the offending node, when the parser
   * exposes it. Present mainly for `E_PARSE_*` issues.
   */
  line?: number;
  /** Optional 1-based source column for the offending node. */
  column?: number;
  /** Originating facet type when the issue is tied to a specific facet. */
  facetType?: FacetType;
  /** Optional structured detail for callers that want to render rich UI. */
  detail?: Record<string, string | number | undefined>;
}

/** Aggregate audit result. */
export interface IDSAuditReport {
  /**
   * Overall status:
   * - `valid`   — no issues raised
   * - `warning` — only `warning` / `info` issues
   * - `error`   — at least one `error` issue
   */
  status: 'valid' | 'warning' | 'error';
  /** Every issue, in document order, regardless of severity. */
  issues: IDSAuditIssue[];
  /**
   * The parsed document, if parsing succeeded. Even partially-malformed
   * documents may produce a parsed object — callers can render whatever
   * portion was salvaged.
   */
  parsedDocument?: IDSDocument;
}

/** Options for `auditIDSDocument` / `auditIDSStructure`. */
export interface IDSAuditOptions {
  /**
   * Run XSD-level checks (default `true`). Controls structural and enum
   * checks against `ids.xsd`.
   */
  xsdValidation?: boolean;
  /**
   * Cross-check facets against the IFC schema (entities, predefined types,
   * pset/property names, attribute names) for the spec's declared IFC
   * version. Default `true`. Disable to skip the network of lazy IFC
   * schema-data lookups.
   */
  ifcSchemaChecks?: boolean;
  /**
   * Override the IFC version used for cross-checks. Useful when the
   * authoring tool has its own source of truth (e.g., a menubar selector
   * in `ids-flow`). When omitted, each specification's declared
   * `ifcVersion` is used.
   */
  ifcVersion?: IFCVersion;
  /**
   * Run coherence checks (restrictions, cardinality). Default `true`.
   */
  coherenceChecks?: boolean;
}
