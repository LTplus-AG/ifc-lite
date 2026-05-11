/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Permissive parse layer for the auditor.
 *
 * `parseIDS` is intentionally strict — it throws on the first structural
 * problem so application code never sees a half-parsed document. The audit
 * use case is the opposite: we want to surface every issue at once, and
 * keep going even when individual specs fail to parse. This module wraps
 * `parseIDS` and converts an `IDSParseError` into an `IDSAuditIssue`.
 *
 * For richer salvaging (e.g., parsing each `<specification>` independently
 * so one bad spec doesn't sink the whole document), see Phase 2+ — for now
 * we collect a single parse error and stop.
 */

import { IDSParseError, parseIDS } from '../parser/xml-parser.js';
import type { IDSDocument } from '../types.js';
import type { IDSAuditIssue } from './types.js';

export interface PermissiveParseResult {
  document?: IDSDocument;
  issues: IDSAuditIssue[];
}

/**
 * Try to parse `xml`. On success, returns the document with no issues. On
 * failure, returns an empty issue list with the original `IDSParseError`
 * mapped onto a structured `IDSAuditIssue`.
 */
export function permissiveParse(
  xml: string | ArrayBuffer
): PermissiveParseResult {
  try {
    const document = parseIDS(xml);
    return { document, issues: [] };
  } catch (err) {
    return { issues: [parseErrorToIssue(err)] };
  }
}

function parseErrorToIssue(err: unknown): IDSAuditIssue {
  if (err instanceof IDSParseError) {
    const message = err.details
      ? `${err.message}: ${err.details}`
      : err.message;
    // Heuristic mapping — distinguish the few error sites in `parseIDS` so
    // consumers can dispatch on `code`. The parser throws three families
    // of errors, all surfaced as `IDSParseError`.
    let code: IDSAuditIssue['code'] = 'E_PARSE_UNKNOWN';
    if (
      err.message.includes('Failed to parse IDS XML') ||
      err.message.includes('Invalid XML format') ||
      err.message.includes('No DOMParser')
    ) {
      code = 'E_PARSE_XML';
    } else if (err.message.includes('Invalid root element')) {
      code = 'E_PARSE_ROOT';
    } else if (err.message.includes('facet')) {
      code = 'E_PARSE_FACET';
    }
    return {
      severity: 'error',
      code,
      message,
      path: '',
    };
  }
  return {
    severity: 'error',
    code: 'E_PARSE_UNKNOWN',
    message: err instanceof Error ? err.message : String(err),
    path: '',
  };
}
