/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS 1.1 PREVIEW audit checks (IDS-124). Run only when the audit is
 * called with `preview: { ids11: true }`.
 */

import type { IDSDocument } from '../types.js';
import type { IDSAuditIssue } from '../audit/types.js';
import { IDS11_PREVIEW_FEATURES, findIds11Features } from './features.js';

/** The schema location the preview writer uses; accepted only under the preview. */
export const IDS11_PREVIEW_SCHEMA_URL = 'http://standards.buildingsmart.org/IDS/1.1/ids.xsd';

/**
 * Specification identifiers are "for clear and unambiguous identification
 * … It should be unique within an IDS file" (upstream user manual,
 * `ids-metadata.md`, the documentation outcome of #339 via PR #369). The
 * text says "should", so a duplicate is a warning, never an error.
 */
function duplicateIdentifiers(doc: IDSDocument): IDSAuditIssue[] {
  const firstIndex = new Map<string, number>();
  const issues: IDSAuditIssue[] = [];
  doc.specifications.forEach((spec, i) => {
    if (spec.identifier === undefined) return;
    const first = firstIndex.get(spec.identifier);
    if (first === undefined) {
      firstIndex.set(spec.identifier, i);
      return;
    }
    issues.push({
      severity: 'warning',
      code: 'W_IDS11_IDENTIFIER_DUPLICATE',
      message: `specification identifier "${spec.identifier}" is also used by specifications[${first}] (IDS 1.1 preview, #339)`,
      path: `specifications[${i}].identifier`,
      detail: { identifier: spec.identifier, firstIndex: first },
    });
  });
  return issues;
}

/** One `info` issue per IDS 1.1 PREVIEW feature use, so reports carry the label. */
function featureNotices(doc: IDSDocument): IDSAuditIssue[] {
  return findIds11Features(doc).map((use) => {
    const info = IDS11_PREVIEW_FEATURES[use.feature];
    return {
      severity: 'info',
      code: 'I_IDS11_PREVIEW_FEATURE',
      message: `IDS 1.1 preview feature: ${info.label} (${info.upstream.join(', ')}); not valid IDS 1.0`,
      path: use.path,
      detail: { feature: use.feature, upstreamStatus: info.upstreamStatus },
    };
  });
}

/** IDS 1.1 PREVIEW findings for a document parsed with the preview. */
export function runIds11PreviewAudit(doc: IDSDocument): IDSAuditIssue[] {
  return [...featureNotices(doc), ...duplicateIdentifiers(doc)];
}

/**
 * Drop the 1.0 audit's schema-location error for the preview schema URL.
 * Every other schema-location finding stays.
 */
export function acceptIds11SchemaLocation(issues: IDSAuditIssue[]): IDSAuditIssue[] {
  return issues.filter((issue) => !(issue.code === 'E_XSD_SCHEMA_LOCATION' && issue.detail?.url === IDS11_PREVIEW_SCHEMA_URL));
}
