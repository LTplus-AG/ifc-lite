/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lint diagnostics as the Studio shows them (IDS-036): grouped by the outline
 * row they belong to, a worst severity per row and per specification, and a
 * before/after preview of a quick fix computed on a throwaway copy of the
 * document. Applying a fix goes through the gate like any edit.
 */

import {
  apply,
  describeFacet,
  locateNode,
  OpApplyError,
  type Diagnostic,
  type LintSeverity,
  type QuickFix,
  type StudioDocument,
  type Uuid,
} from '@ifc-lite/ids-authoring';
import { specCardinality } from './spec-cardinality';

type DescribeLocale = Parameters<typeof describeFacet>[3];

const RANK: Record<LintSeverity, number> = { error: 3, warning: 2, info: 1 };

export function worse(a: LintSeverity | undefined, b: LintSeverity): LintSeverity {
  return a && RANK[a] >= RANK[b] ? a : b;
}

/** A stable key for one diagnostic (code, node and field). */
export function diagnosticKey(d: Diagnostic): string {
  return `${d.code}|${d.nodeId}|${d.field ?? ''}`;
}

/** The outline row a node belongs to: a constraint maps to its facet, everything else to itself. */
export function rowIdOf(doc: StudioDocument, nodeId: Uuid): Uuid {
  const loc = locateNode(doc, nodeId);
  return loc?.kind === 'constraint' ? loc.facetId : nodeId;
}

export interface DiagnosticIndex {
  /** Diagnostics per outline row id (document node, spec or facet). */
  byRow: Map<Uuid, Diagnostic[]>;
  /** Worst severity per row, including everything below a specification. */
  severity: Map<Uuid, LintSeverity>;
  counts: Record<LintSeverity, number>;
}

export function indexDiagnostics(doc: StudioDocument, diagnostics: readonly Diagnostic[]): DiagnosticIndex {
  const byRow = new Map<Uuid, Diagnostic[]>();
  const severity = new Map<Uuid, LintSeverity>();
  const counts: Record<LintSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) {
    counts[d.severity]++;
    const row = rowIdOf(doc, d.nodeId);
    byRow.set(row, [...(byRow.get(row) ?? []), d]);
    severity.set(row, worse(severity.get(row), d.severity));
    if (d.specId && d.specId !== row) severity.set(d.specId, worse(severity.get(d.specId), d.severity));
  }
  return { byRow, severity, counts };
}

/** Errors first, then warnings, then infos; document order within a severity. */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.map((d, i) => ({ d, i })).sort((a, b) => RANK[b.d.severity] - RANK[a.d.severity] || a.i - b.i).map(({ d }) => d);
}

export interface FixChange {
  nodeId: Uuid;
  before: string | null;
  after: string | null;
}

export type FixPreview = { ok: true; changes: FixChange[] } | { ok: false; message: string };

/** One line per facet / spec / document node: what it reads as. */
function describeNode(doc: StudioDocument, id: Uuid, locale: DescribeLocale): string | null {
  if (id === doc.nodes.document) {
    // The document reads as its header fields, so a fix to the author or date is visible.
    return Object.entries(doc.ids.info).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}: “${String(v)}”`).join(' · ');
  }
  const loc = locateNode(doc, id);
  if (!loc || loc.kind === 'document') return null;
  const spec = doc.ids.specifications[loc.specIndex];
  if (!spec) return null;
  switch (loc.kind) {
    case 'spec': {
      return [`“${spec.name}”`, specCardinality(spec), spec.ifcVersions.join(' '), spec.identifier ? `#${spec.identifier}` : ''].filter(Boolean).join(' · ');
    }
    case 'applicabilityFacet':
    case 'requirement':
    case 'constraint': {
      if (loc.section === 'applicability') return describeFacet(spec.applicability.facets[loc.facetIndex], 'applicability', 'required', locale);
      const requirement = spec.requirements[loc.facetIndex];
      return describeFacet(requirement.facet, 'requirements', requirement.optionality, locale);
    }
  }
}

/**
 * What `fix` would change, computed by applying it to a copy (the reducer is
 * pure; the store is untouched). Nodes are reported once, at facet level.
 */
export function previewFix(doc: StudioDocument, fix: QuickFix, locale: DescribeLocale = 'en'): FixPreview {
  let next: StudioDocument;
  let touched: Set<Uuid>;
  try {
    const result = apply(doc, fix.ops);
    next = result.doc;
    touched = result.touched;
  } catch (error) {
    if (error instanceof OpApplyError) return { ok: false, message: error.message };
    throw error;
  }
  const rows = new Set<Uuid>();
  for (const id of touched) rows.add(rowIdOf(locateNode(next, id) ? next : doc, id));
  const changes: FixChange[] = [];
  for (const id of rows) {
    const before = describeNode(doc, id, locale), after = describeNode(next, id, locale);
    if (before !== after) changes.push({ nodeId: id, before, after });
  }
  return { ok: true, changes };
}
