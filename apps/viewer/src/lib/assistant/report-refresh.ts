/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Evidence refresh of a saved AI report (#6918). The source is recaptured,
 * every claim's cited facts are re-checked against the same native rows (found
 * again by row identity, not by citation number), and generator-owned blocks
 * are regenerated. Blocks a person edited are kept unless the reviewer chooses,
 * block by block, to replace them; deleted generated blocks are not restored.
 */

import { reportTextFor } from './report-text';
import type { TranslationKey } from '@/i18n/en';
import { aiBlockOrigin, type AiClaimStatus, type AiReportRecord } from '../document/ai-report-types';
import { validateDocumentSpec, type DocumentBlock, type DocumentSpec, type TextBlock } from '../document/types';
import { evidenceIsCurrent, type EvidenceSnapshot } from './evidence';
import { buildReportBlocks, type FactChange, type SlotBlock } from './report-blocks';
import { checkClaim } from './report-claims';
import { parseCapturedEvidence, type CapturedEvidence } from './captured-rows';
import { citationsByIdentity, declaredUnit, SUMMARY_CITATION, valueAt } from './report-facts';

export interface RefreshConflict {
  blockId: string;
  slot: string;
  current: string;
  /** Regenerated text; null when the generator no longer produces this block. */
  regenerated: string | null;
}

export interface ClaimRefresh { id: string; before: AiClaimStatus; after: AiClaimStatus; changes: FactChange[] }

export interface ReportRefreshPlan {
  /** The document the plan was computed from; applying to anything else is refused. */
  documentJson: string;
  record: AiReportRecord;
  regenerated: SlotBlock[];
  claims: ClaimRefresh[];
  conflicts: RefreshConflict[];
  /** The loaded models are not the ones the report was first drafted against. */
  modelsChanged: boolean;
}

/** A refusal the reviewer can act on; `key` is its viewer message. */
export class ReportRefreshError extends Error {
  constructor(readonly key: TranslationKey, message: string) {
    super(message);
    this.name = 'ReportRefreshError';
  }
}

/** Source fingerprints of the models in a capture payload, order-free; unknown fingerprints count as ''. */
function modelFingerprints(models: ReadonlyArray<{ fingerprint?: unknown }>): string[] {
  return models.map(model => typeof model.fingerprint === 'string' ? model.fingerprint : '').sort();
}

/** Notices carry new information, so they return even after a person deleted an earlier one. */
const NOTICE = /^(refresh-summary|font-notice|claim-refresh:.+)$/;

function resolver(record: AiReportRecord, rows: CapturedEvidence): (citation: string) => string | null {
  const index = citationsByIdentity(rows.rows);
  return citation => {
    const key = record.citedRows[citation];
    if (key === SUMMARY_CITATION) return SUMMARY_CITATION;
    return key === null || key === undefined ? null : index.get(key) ?? null;
  };
}

/** A cited value and the unit its capture declares for it. */
function lookup(rows: CapturedEvidence, citation: string | null, field: string): { value: unknown; unit?: string } {
  if (citation === null) return { value: undefined };
  const data = citation === SUMMARY_CITATION ? rows.summary : rows.rows.get(citation);
  return { value: valueAt(data, field), unit: declaredUnit(data, rows.summary, field) };
}

export function planReportRefresh(document: DocumentSpec, snapshot: EvidenceSnapshot): ReportRefreshPlan {
  const record = document.aiReport;
  if (!record) throw new Error('This document was not drafted from AI evidence.');
  if (snapshot.source !== record.evidence.source) throw new Error(`The report was drafted from ${record.evidence.source} evidence, not ${snapshot.source}.`);
  const payload = JSON.parse(snapshot.payload) as { sourceAvailability?: string };
  if (payload.sourceAvailability !== 'available') {
    throw new ReportRefreshError('aiReports.noNativeResult', `No native ${snapshot.source} result is available to refresh from.`);
  }
  // Re-checking against a result the model has outgrown would certify values the model no longer has.
  if (!evidenceIsCurrent(snapshot)) {
    throw new ReportRefreshError('aiReports.analysisStale', `The native ${snapshot.source} result predates the current model state.`);
  }
  const originModels = record.originModels
    ?? modelFingerprints((JSON.parse(record.evidence.payload) as { models?: Array<{ fingerprint?: unknown }> }).models ?? []);
  const currentModels = modelFingerprints(snapshot.models);
  // A model without a fingerprint cannot be shown to be the same one, so it never suppresses the warning.
  const modelsChanged = originModels.includes('') || currentModels.includes('') || JSON.stringify(originModels) !== JSON.stringify(currentModels);
  const previous = parseCapturedEvidence(record.evidence.payload);
  const next = parseCapturedEvidence(snapshot.payload);
  const partial = snapshot.includedRows < snapshot.totalRows;
  const before = resolver(record, previous), now = resolver(record, next);
  const claims: ClaimRefresh[] = [];
  const presentations = record.claims.map(claim => {
    const checked = checkClaim({ id: claim.id, text: claim.text, citations: claim.citations, facts: claim.facts, edited: claim.edited,
      ...(claim.generatedText === undefined ? {} : { generatedText: claim.generatedText }) }, next, { resolve: now, partial });
    const changes = claim.facts.map((fact): FactChange => {
      const old = lookup(previous, before(fact.citation), fact.field);
      const current = now(fact.citation);
      const value = lookup(next, current, fact.field);
      const was = { previous: old.value, ...(old.unit ? { previousUnit: old.unit } : {}) };
      if (partial && current === null) return { kind: 'unsampled', ...was };
      if (value.value === undefined) return { kind: 'missing', ...was };
      return JSON.stringify(old) === JSON.stringify(value) ? { kind: 'unchanged' } : { kind: 'changed', ...was };
    });
    claims.push({ id: claim.id, before: claim.status, after: checked.status, changes });
    return { claim: checked, current: now, changes };
  });
  const updated: AiReportRecord = { ...record, revision: record.revision + 1, originModels,
    evidence: { source: snapshot.source, capturedAt: snapshot.capturedAt, payload: snapshot.payload, totalRows: snapshot.totalRows,
      includedRows: snapshot.includedRows, projectionTruncated: snapshot.projectionTruncated },
    claims: record.claims.map((claim, index) => ({ ...claim, status: presentations[index].claim.status })) };
  const count = (kind: FactChange['kind']) => claims.filter(claim => claim.changes.some(change => change.kind === kind)).length;
  const t = reportTextFor(record.language);
  const refreshSummary = t('refreshSummary', { capturedAt: snapshot.capturedAt, revision: updated.revision,
    previousAt: record.evidence.capturedAt, claims: claims.length, changed: count('changed'), missing: count('missing') })
    + (partial ? t('refreshUnsampled', { count: count('unsampled') }) : '') + '. '
    + (modelsChanged ? t('refreshModelsChanged') : '') + t('refreshProse') + t('refreshHuman');
  const regenerated = buildReportBlocks({ title: document.name, record: updated, claims: presentations, refreshSummary, current: now,
    tables: document.blocks.filter(block => block.kind === 'table'),
    proseCitations: [...new Set([...record.narrative.matchAll(/\bE\d+\b/g)].map(match => match[0]))] });
  // Compared on the generator's own baseline: a claim rewritten before saving stays the reviewer's text.
  const generated = new Map(regenerated.flatMap(entry => entry.slot && entry.block.kind === 'text' ? [[entry.slot, entry.block] as const] : []));
  const conflicts: RefreshConflict[] = [];
  for (const block of document.blocks) {
    if (block.kind !== 'text' || aiBlockOrigin(block) !== 'human-edited') continue;
    const slot = block.aiProvenance!.slot;
    const fresh = generated.get(slot);
    if (fresh === undefined) conflicts.push({ blockId: block.id, slot, current: block.text, regenerated: null });
    else if (fresh.aiProvenance?.generated !== block.aiProvenance!.generated) conflicts.push({ blockId: block.id, slot, current: block.text, regenerated: fresh.text });
  }
  return { documentJson: JSON.stringify(document), record: updated, regenerated, claims, conflicts, modelsChanged };
}

/** Applies a plan. `replace` names human-edited blocks the reviewer chose to overwrite; all others keep their text. */
export function applyReportRefresh(document: DocumentSpec, plan: ReportRefreshPlan, replace: ReadonlySet<string> = new Set()): DocumentSpec {
  if (JSON.stringify(document) !== plan.documentJson) {
    throw new ReportRefreshError('aiReports.documentChanged', 'The document changed since the refresh was prepared.');
  }
  const generated = new Map(plan.regenerated.flatMap(entry => entry.slot && entry.block.kind === 'text' ? [[entry.slot, entry.block as TextBlock] as const] : []));
  const present = new Set<string>();
  const blocks: DocumentBlock[] = [];
  for (const block of document.blocks) {
    if (block.kind !== 'text' || !block.aiProvenance) { blocks.push(block); continue; }
    const slot = block.aiProvenance.slot;
    const fresh = generated.get(slot);
    const edited = aiBlockOrigin(block) === 'human-edited' && !replace.has(block.id);
    if (!fresh) { if (edited) blocks.push(block); continue; }
    present.add(slot);
    blocks.push({ ...block, text: edited ? block.text : fresh.text, aiProvenance: { ...block.aiProvenance, generated: fresh.aiProvenance?.generated ?? fresh.text } });
  }
  // New generated blocks go after the nearest preceding generated slot; deleted ones stay deleted.
  const previouslyGenerated = new Set(plan.record.slots);
  let anchor: string | null = null;
  for (const entry of plan.regenerated) {
    if (!entry.slot) continue;
    if (!present.has(entry.slot) && (!previouslyGenerated.has(entry.slot) || NOTICE.test(entry.slot))) {
      const at = anchor === null ? 0 : blocks.findIndex(block => block.kind === 'text' && block.aiProvenance?.slot === anchor) + 1;
      blocks.splice(at, 0, entry.block);
      present.add(entry.slot);
    }
    if (present.has(entry.slot)) anchor = entry.slot;
  }
  const slots = [...new Set([...plan.record.slots, ...generated.keys()])];
  const next: DocumentSpec = { ...document, blocks, aiReport: { ...plan.record, slots } };
  const errors = validateDocumentSpec(next);
  if (errors.length) throw new Error(`Invalid refreshed document: ${errors.map(error => `${error.path} ${error.message}`).join('; ')}`);
  return next;
}
