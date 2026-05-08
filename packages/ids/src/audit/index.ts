/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS document auditing.
 *
 * Authoring tools (`ids-flow`, `ids-light-editor`) historically delegated
 * IDS-document validation to buildingSMART's `IfcTester-Service` HTTP
 * endpoint. This module brings that capability in-process so consumers
 * can drop the network round-trip.
 *
 * Three layers of checks run by default:
 *  1. Permissive parse — a wrapper around `parseIDS` that turns each
 *     `IDSParseError` into a structured issue.
 *  2. XSD-level checks — required attributes, enum membership, structural
 *     shape (cf. `ids.xsd`).
 *  3. IFC schema cross-checks — entities, predefined types, property
 *     sets/properties, attribute names against the seed dataset in
 *     `@ifc-lite/data`.
 *  4. Restriction & cardinality coherence — empty enumerations, inverted
 *     bounds, regex patterns that don't compile, etc.
 *
 * All four are independently togglable via `IDSAuditOptions`.
 */

import type { IDSDocument } from '../types.js';
import { runCoherenceAudit } from './coherence/index.js';
import { runIfcSchemaAudit } from './ifc-schema/index.js';
import { permissiveParse } from './parser-shim.js';
import type {
  IDSAuditIssue,
  IDSAuditOptions,
  IDSAuditReport,
} from './types.js';
import { runXsdAudit } from './xsd/index.js';

export type {
  IDSAuditCode,
  IDSAuditIssue,
  IDSAuditOptions,
  IDSAuditReport,
  IDSAuditSeverity,
} from './types.js';

/**
 * Audit an IDS XML document. The report aggregates issues from every
 * enabled check phase. Even when parsing fails, the returned report
 * contains the parse error as a structured issue.
 */
export async function auditIDSDocument(
  xml: string | ArrayBuffer,
  options: IDSAuditOptions = {}
): Promise<IDSAuditReport> {
  const { document, issues } = permissiveParse(xml);
  if (!document) {
    return finalise(issues);
  }
  const downstream = await auditIDSStructure(document, options);
  return finalise([...issues, ...downstream.issues], document);
}

/**
 * Audit an already-parsed IDS document. Skips the parse step — useful
 * when the caller already has an `IDSDocument` (e.g., from an in-app
 * editor that mutates the structure directly).
 */
export async function auditIDSStructure(
  doc: IDSDocument,
  options: IDSAuditOptions = {}
): Promise<IDSAuditReport> {
  const xsdValidation = options.xsdValidation !== false;
  const ifcSchemaChecks = options.ifcSchemaChecks !== false;
  const coherenceChecks = options.coherenceChecks !== false;

  const issues: IDSAuditIssue[] = [];
  if (xsdValidation) issues.push(...runXsdAudit(doc));
  if (coherenceChecks) issues.push(...runCoherenceAudit(doc));
  if (ifcSchemaChecks) {
    issues.push(
      ...(await runIfcSchemaAudit(doc, { ifcVersion: options.ifcVersion }))
    );
  }
  return finalise(issues, doc);
}

function finalise(
  issues: IDSAuditIssue[],
  parsedDocument?: IDSDocument
): IDSAuditReport {
  let status: IDSAuditReport['status'] = 'valid';
  for (const issue of issues) {
    if (issue.severity === 'error') {
      status = 'error';
      break;
    }
    if (issue.severity === 'warning' || issue.severity === 'info') {
      status = 'warning';
    }
  }
  return { status, issues, parsedDocument };
}
