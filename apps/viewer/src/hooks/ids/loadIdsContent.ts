/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Load an IDS document (XML text) into the store: parse + audit, with the
 * same resilience contract `useIDS.loadIDS` always had. Extracted so
 * non-React callers (the tour demo kit) can load a spec without the IDS
 * panel mounted; the hook delegates here.
 */

import type { IDSDocument } from '@ifc-lite/ids';
import { auditIDSDocument, IDSParseError, parseIDS } from '@ifc-lite/ids';
import type { useViewerStore } from '@/store';
import { beginDefinitionImport, type DefinitionImportOwner } from '@/lib/validation/definition-import-owner';

const loads = new WeakMap<typeof useViewerStore, number>();

export function loadIdsContent(store: typeof useViewerStore, xmlContent: string, existingId?: string, request?: DefinitionImportOwner): Promise<void> {
  const owner = request ?? beginDefinitionImport(store, 'ids');
  if (!owner.wanted()) return Promise.resolve();
  const s = store.getState();
  const load = (loads.get(store) ?? 0) + 1;
  loads.set(store, load);
  s.setIdsLoading(true);
  s.setIdsError(null);
  s.setIdsAuditing(true);
  // Clear the previous audit/document up front so a re-load with a
  // malformed file doesn't show stale issues from the previous one.

  // Try to parse synchronously so the panel switches into "document
  // loaded" mode immediately. Capture any parse error but DON'T early-
  // return - the auditor's permissive shim has its own parser and can
  // still surface structured `E_PARSE_XML` / `E_XSD_*` issues even
  // when the strict parser threw.
  let parsed: IDSDocument | null = null;
  let parseErrorMessage: string | null = null;
  try {
    parsed = parseIDS(xmlContent);
    if (!s.addValidationDefinition({ kind: 'ids', xml: xmlContent, document: parsed }, existingId)) {
      s.setIdsError(store.getState().validationDefinitionsError);
      s.setIdsAuditing(false);
      return Promise.resolve();
    }
    owner.committed();
    s.setIdsAuditing(true);
    console.info(
      `[IDS] Loaded: "${parsed.info.title}" (${parsed.specifications.length} specifications)`
    );
  } catch (err) {
    // Drop any previously-loaded document so the panel shows the
    // empty state with the new audit, not the stale prior content.
    if (!s.validationDefinitions.active.ids) s.setIdsDocument(null);
    // Preserve the underlying detail (e.g. xmldom's
    // "unexpected token at line N column M") instead of just the
    // top-level "Invalid XML format" - that's the actionable bit.
    if (err instanceof IDSParseError) {
      parseErrorMessage = err.details
        ? `${err.message}: ${err.details}`
        : err.message;
    } else {
      parseErrorMessage =
        err instanceof Error ? err.message : 'Failed to parse IDS file';
    }
    console.error('[IDS] Parse error:', err);
  } finally {
    s.setIdsLoading(false);
  }

  // An invalid replacement is an import error, not a license to discard the
  // active saved source or attach another document's audit to it.
  if (parseErrorMessage && store.getState().validationDefinitions.active.ids) {
    s.setIdsError(parseErrorMessage);
    s.setIdsAuditing(false);
    return Promise.resolve();
  }
  const wanted = () => owner.isLatest() && loads.get(store) === load
    && store.getState().idsDocument === parsed;

  // Always run the audit, even on parse failure. The permissive
  // shim handles malformed XML gracefully and produces a single
  // `E_PARSE_XML` issue plus whatever else it can salvage.
  return auditIDSDocument(xmlContent)
    .then((report) => {
      if (!wanted()) return;
      s.setIdsAuditReport(report);
      // If parse failed but the audit succeeded with no errors,
      // something is internally inconsistent - keep the parse error
      // visible. If the audit also reported errors (almost always the
      // case on parse failure), the panel will surface those rich
      // issues alongside / instead of the bare error string.
      if (parseErrorMessage && report.issues.length === 0) {
        s.setIdsError(parseErrorMessage);
      } else if (parseErrorMessage) {
        // Audit has structured issues - clear the bare-string error
        // so the panel relies on the audit summary as the source of
        // truth (it carries the same information in richer form).
        s.setIdsError(null);
      }
      if (report.status === 'error') {
        console.warn(
          `[IDS] Audit found ${
            report.issues.filter((i) => i.severity === 'error').length
          } error(s) in the IDS document`
        );
      }
    })
    .catch((auditErr) => {
      if (!wanted()) return;
      // Audit itself crashed - non-fatal but unusual. Clear the audit
      // and fall back to whatever parse error we collected.
      console.error('[IDS] Audit failed:', auditErr);
      s.setIdsAuditReport(null);
      if (parseErrorMessage) s.setIdsError(parseErrorMessage);
    })
    .finally(() => {
      if (wanted()) s.setIdsAuditing(false);
    });
}
