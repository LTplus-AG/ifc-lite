/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An IDS draft ready for the native gates: what is audited, dry-run, saved
 * and exported is the native writer's XML read back by the native parser,
 * so every later step sees exactly what `parseIDS` sees.
 *
 * Drafts come from an accepted IDS-agent proposal (IDS-085). Statements the
 * agent marked unresolved travel inside the IDS: the document description
 * lists them, so a saved or exported file never silently loses them.
 */

import { auditIDSDocument, parseIDS, type IDSAuditIssue, type IDSDocument } from '@ifc-lite/ids';
import { writeIdsXml } from '@ifc-lite/rules';
import { unsupportedNote, type UnsupportedRequirement } from './proposal-json';

export interface IdsDraft {
  title: string;
  xml: string;
  document: IDSDocument;
  /** Kept with the draft (and in the IDS description) so the review shows them. */
  unsupported: UnsupportedRequirement[];
}

/** Write `document` through the native writer and read it back. */
export function idsDraftOf(document: IDSDocument, unsupported: readonly UnsupportedRequirement[] = []): IdsDraft {
  const note = unsupportedNote(unsupported);
  const info = { ...document.info, ...(note ? { description: [document.info.description, note].filter(Boolean).join('\n\n') } : {}) };
  const title = info.title.trim() || 'IDS draft';
  if (!document.specifications.length) return { title, xml: '', document: { info, specifications: [] }, unsupported: [...unsupported] };
  const xml = writeIdsXml({ ...document, info: { ...info, title } });
  return { title, xml, document: parseIDS(xml), unsupported: [...unsupported] };
}

/** The exact XML each audit result describes, so a result cannot be reused for a different draft. */
const auditedXml = new WeakMap<readonly IDSAuditIssue[], string>();

/** Native document audit (XSD, IFC schema, restriction coherence). Errors block saving and export. */
export async function auditIdsDraft(draft: IdsDraft): Promise<IDSAuditIssue[]> {
  if (!draft.xml) return [];
  const issues = (await auditIDSDocument(draft.xml)).issues;
  auditedXml.set(issues, draft.xml);
  return issues;
}

/** Whether `issues` came from auditing exactly `xml`. */
export function isAuditOf(issues: readonly IDSAuditIssue[] | null, xml: string): boolean {
  return issues !== null && auditedXml.get(issues) === xml;
}
