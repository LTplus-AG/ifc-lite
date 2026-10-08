/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The embedded record of an AI-drafted report (#6918): the captured evidence it
 * was written against, its typed claims and the language it was generated in.
 * Text blocks the generator wrote carry `aiProvenance`; a block whose text no
 * longer equals `generated` was edited by a person, so refresh never rewrites
 * it silently. Both fields are optional and additive within document v12:
 * an older viewer prints and edits such a document as plain text.
 */
import type { DocumentBlock, DocumentValidationError } from './types';

export type AiClaimStatus = 'supported' | 'unverifiable' | 'contradicted';

/** One native value a claim asserts: `field` is a dotted path into the cited row (or the summary). */
export interface AiClaimFact {
  citation: string;
  field: string;
  value: string | number | boolean;
  unit?: string;
}

export interface AiReportClaim {
  id: string;
  text: string;
  /** Citations exactly as the provider wrote them in the original capture. */
  citations: string[];
  facts: AiClaimFact[];
  status: AiClaimStatus;
  /** True once a reviewer rewrote the claim text before saving. */
  edited: boolean;
  /** The provider's own statement, kept once a reviewer rewrote it, so the block reads as human-edited. */
  generatedText?: string;
}

export interface AiReportEvidence {
  source: string;
  capturedAt: string;
  payload: string;
  totalRows: number;
  includedRows: number;
  projectionTruncated: boolean;
}

export interface AiReportRecord {
  version: 1;
  /** BCP 47 tag the narrative was requested in; independent of the UI language. */
  language: string;
  model: string;
  conversationId: string;
  /** 1 at generation; every applied evidence refresh adds one. */
  revision: number;
  evidence: AiReportEvidence;
  /** Row identity of every citation the claims or the narrative used, resolved against the generation capture. */
  citedRows: Record<string, string | null>;
  claims: AiReportClaim[];
  /** The prose part of the answer, kept so refresh can reproduce unedited narrative blocks. */
  narrative: string;
  /** Every block slot the generator has ever produced; a missing one was deleted by a person. */
  slots: string[];
  /** Sorted source fingerprints of the models first drafted against; set by the first refresh. */
  originModels?: string[];
}

/** Marks generator-written text. `generated` is the exact text written, so an edit is observable. */
export interface AiBlockProvenance {
  origin: 'ai';
  slot: string;
  generated: string;
}

export type AiBlockOrigin = 'ai-generated' | 'human-edited' | 'human';

export function aiBlockOrigin(block: { text: string; aiProvenance?: AiBlockProvenance }): AiBlockOrigin {
  if (!block.aiProvenance) return 'human';
  return block.aiProvenance.generated === block.text ? 'ai-generated' : 'human-edited';
}

/**
 * A copy placed elsewhere is the copier's own text: a duplicated block or a
 * template-built document must not be regenerated as if the AI wrote it there.
 */
export function detachAiProvenance(block: DocumentBlock): DocumentBlock {
  if (block.kind !== 'text' || !block.aiProvenance) return block;
  const copy = { ...block };
  delete copy.aiProvenance;
  return copy;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const STATUSES: readonly string[] = ['supported', 'unverifiable', 'contradicted'];

export function validateAiProvenance(value: unknown, at: string, errors: DocumentValidationError[]): void {
  if (!isRecord(value) || value.origin !== 'ai' || !isText(value.slot, 200) || !value.slot || !isText(value.generated, 200_000)) {
    errors.push({ path: `${at}.aiProvenance`, message: 'expected { origin: ai, slot, generated }' });
  }
}

function validClaim(value: unknown): boolean {
  if (!isRecord(value) || !isText(value.id, 100) || !isText(value.text, 4000) || !STATUSES.includes(value.status as string)
    || typeof value.edited !== 'boolean' || !Array.isArray(value.citations) || !value.citations.every(c => isText(c, 20))
    || (value.generatedText !== undefined && !isText(value.generatedText, 4000)) || !Array.isArray(value.facts)) return false;
  return value.facts.every(fact => isRecord(fact) && isText(fact.citation, 20) && isText(fact.field, 200)
    && (typeof fact.value === 'string' || typeof fact.value === 'boolean' || (typeof fact.value === 'number' && Number.isFinite(fact.value)))
    && (fact.unit === undefined || isText(fact.unit, 40)));
}

export function validateAiReportRecord(value: unknown, errors: DocumentValidationError[]): void {
  const fail = (message: string) => errors.push({ path: 'aiReport', message });
  if (!isRecord(value) || value.version !== 1) { fail('expected an AI report record version 1'); return; }
  if (!isText(value.language, 35) || !value.language) fail('expected a language tag');
  if (!isText(value.model, 200) || !isText(value.conversationId, 200)) fail('expected model and conversation identity');
  if (!isCount(value.revision) || value.revision < 1) fail('expected a revision number');
  const evidence = value.evidence;
  if (!isRecord(evidence) || !isText(evidence.source, 100) || !isText(evidence.capturedAt, 50) || !isText(evidence.payload, 48_000)
    || !isCount(evidence.totalRows) || !isCount(evidence.includedRows) || typeof evidence.projectionTruncated !== 'boolean') {
    fail('expected embedded captured evidence');
  }
  if (!isRecord(value.citedRows) || !Object.values(value.citedRows).every(key => key === null || isText(key, 4000))) fail('expected cited row identities');
  if (!Array.isArray(value.claims) || value.claims.length > 50 || !value.claims.every(validClaim)) fail('expected at most 50 valid claims');
  if (!isText(value.narrative, 32_000)) fail('expected the narrative text');
  if (!Array.isArray(value.slots) || !value.slots.every(slot => isText(slot, 200))) fail('expected generated slots');
  if (value.originModels !== undefined && (!Array.isArray(value.originModels) || value.originModels.length > 1000
    || !value.originModels.every(fingerprint => isText(fingerprint, 200)))) fail('expected origin model fingerprints');
}
