/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Clash } from '@ifc-lite/clash';
import { useViewerStore } from '@/store';
import { manualClashOccurrenceKey } from '../clash/manual-groups';
import { clashDisciplineCandidates } from './clash-taxonomy';
import { evidenceIsCurrent, type EvidenceSnapshot } from './evidence';

interface ProposedGroup { name: string; explanation: string; citations: string[] }
export interface ClashGroupPatch { version: 1; kind: 'clash.groups'; groups: ProposedGroup[] }
export interface ClashGroupPreview {
  evidence: EvidenceSnapshot;
  groups: Array<ProposedGroup & { findings: Array<{
    citation: string; occurrence: string; nativeType: Clash['status']; nativeSeverity: Clash['severity'];
    disciplineCandidates: ReturnType<typeof clashDisciplineCandidates>;
  }> }>;
  totalFindings: number;
  proposedFindings: number;
  unclassifiedFindings: number;
  omittedFromEvidence: number;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const fields = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/** Complete bounded JSON only. Native verdict, review and assignment writes are not in this contract. */
export function parseClashGroupPatch(answer: string): ClashGroupPatch {
  if (answer.length > 48_000) throw new Error('Clash proposal exceeds the text limit');
  const trimmed = answer.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  const value: unknown = JSON.parse(fenced ? fenced[1] : trimmed);
  if (!record(value) || !fields(value, ['version', 'kind', 'groups']) || value.version !== 1
    || value.kind !== 'clash.groups' || !Array.isArray(value.groups) || !value.groups.length || value.groups.length > 30) {
    throw new Error('Invalid bounded clash group envelope');
  }
  const claimed = new Set<string>();
  const names = new Set<string>();
  const groups: ProposedGroup[] = [];
  for (const group of value.groups) {
    if (!record(group) || !fields(group, ['name', 'explanation', 'citations']) || !text(group.name, 100)
      || !text(group.explanation, 1200) || !Array.isArray(group.citations) || !group.citations.length
      || group.citations.length > 100 || names.has(group.name.trim())) throw new Error('Invalid clash group');
    const citations: string[] = [];
    for (const citation of group.citations) {
      if (typeof citation !== 'string' || !/^E(?:[1-9]\d?|100)$/.test(citation) || claimed.has(citation)) {
        throw new Error('Clash references must be unique captured evidence citations');
      }
      claimed.add(citation); citations.push(citation);
    }
    names.add(group.name.trim());
    groups.push({ name: group.name.trim(), explanation: group.explanation, citations });
  }
  return { version: 1, kind: 'clash.groups', groups };
}

function capturedOccurrence(value: unknown): string | null {
  if (!record(value) || typeof value.rule !== 'string') return null;
  function element(value: unknown) {
    if (!record(value) || typeof value.model !== 'string' || typeof value.key !== 'string') return null;
    return { model: value.model, key: value.key, tag: '', ref: 0 };
  }
  const a = element(value.a), b = element(value.b);
  return a && b ? manualClashOccurrenceKey({ rule: value.rule, a, b }) : null;
}

/** Inert full-population accounting: every native finding is proposed once or remains unclassified. */
export function prepareClashGroupPreview(answer: string, evidence: EvidenceSnapshot): ClashGroupPreview {
  if (evidence.source !== 'clash' || !evidenceIsCurrent(evidence)) throw new Error('Clash evidence is stale or unavailable');
  const result = useViewerStore.getState().clashResult;
  if (!result || evidence.totalRows !== result.clashes.length) throw new Error('Clash population changed');
  const patch = parseClashGroupPatch(answer);
  const payload: unknown = JSON.parse(evidence.payload);
  if (!record(payload) || !record(payload.evidence) || !Array.isArray(payload.evidence.rows)) throw new Error('Missing captured clash rows');
  const captured = new Map<string, unknown>();
  for (const row of payload.evidence.rows) {
    if (!record(row) || typeof row.citation !== 'string' || captured.has(row.citation)) throw new Error('Ambiguous evidence citation');
    captured.set(row.citation, row);
  }
  const native = new Map<string, Clash[]>();
  for (const finding of result.clashes) {
    const key = manualClashOccurrenceKey(finding);
    const matches = native.get(key);
    if (matches) matches.push(finding); else native.set(key, [finding]);
  }
  const assigned = new Set<string>();
  const groups = patch.groups.map(group => ({ ...group, findings: group.citations.map(citation => {
    const row = captured.get(citation);
    if (!record(row) || row.rowProjectionTruncated || !record(row.data)) throw new Error('Unknown or incomplete captured clash citation');
    const occurrence = capturedOccurrence(row.data);
    const matches = occurrence ? native.get(occurrence) : undefined;
    if (!occurrence || matches?.length !== 1 || assigned.has(occurrence)) throw new Error('Clash occurrence is missing, ambiguous or repeated');
    const finding = matches[0];
    if (row.data.id !== finding.id || row.data.status !== finding.status || row.data.severity !== finding.severity) {
      throw new Error('Captured native clash facts changed');
    }
    assigned.add(occurrence);
    return { citation, occurrence, nativeType: finding.status, nativeSeverity: finding.severity,
      disciplineCandidates: clashDisciplineCandidates(finding) };
  }) }));
  return { evidence, groups, totalFindings: result.clashes.length, proposedFindings: assigned.size,
    unclassifiedFindings: result.clashes.length - assigned.size, omittedFromEvidence: evidence.totalRows - evidence.includedRows };
}


/**
 * The live native finding a captured citation names, or null when the evidence is
 * stale, the row is not a complete clash row, or the occurrence is gone/ambiguous.
 */
export function resolveCapturedClash(evidence: EvidenceSnapshot, citation: string): Clash | null {
  if (evidence.source !== 'clash' || !evidenceIsCurrent(evidence) || evidence.payload.length > 200_000) return null;
  let payload: unknown;
  try { payload = JSON.parse(evidence.payload); }
  catch (error) { console.warn('[Assistant] Captured clash evidence is not JSON', error); return null; }
  if (!record(payload) || !record(payload.evidence) || !Array.isArray(payload.evidence.rows)) return null;
  const row: unknown = payload.evidence.rows.find(candidate => record(candidate) && candidate.citation === citation);
  if (!record(row) || row.rowProjectionTruncated || !record(row.data)) return null;
  const occurrence = capturedOccurrence(row.data);
  const matches = (useViewerStore.getState().clashResult?.clashes ?? []).filter(clash => manualClashOccurrenceKey(clash) === occurrence);
  return occurrence && matches.length === 1 && matches[0].id === row.data.id ? matches[0] : null;
}

export interface NormalizedClashAnswer {
  /** Strict-contract JSON, safe to hand to `prepareClashGroupPreview`. */
  answer: string;
  removedRepeats: number;
  removedUnknown: number;
  droppedGroups: number;
}

/**
 * Explicit, disclosed fallback for models that repeat or invent citations: the first
 * group keeps a repeated finding, unknown or incomplete citations are dropped, and
 * emptied groups disappear. Envelope, name and explanation limits stay strict.
 * Null when nothing would remain or the envelope itself is invalid.
 */
export function normalizeClashGroupAnswer(answer: string, evidence: EvidenceSnapshot): NormalizedClashAnswer | null {
  return evidence.source === 'clash' ? normalizeClashGroupRows(answer, evidence.payload) : null;
}

/** The same disclosed normalization over any captured clash row envelope, e.g. one full-run chunk. */
export function normalizeClashGroupRows(answer: string, evidencePayload: string): NormalizedClashAnswer | null {
  if (answer.length > 48_000 || evidencePayload.length > 200_000) return null;
  const trimmed = answer.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  let value: unknown, payload: unknown;
  try { value = JSON.parse(fenced ? fenced[1] : trimmed); payload = JSON.parse(evidencePayload); }
  catch (error) { console.warn('[Assistant] Clash proposal cannot be normalized', error); return null; }
  if (!record(value) || value.kind !== 'clash.groups' || value.version !== 1 || !Array.isArray(value.groups)
    || !value.groups.length || value.groups.length > 30) return null;
  if (!record(payload) || !record(payload.evidence) || !Array.isArray(payload.evidence.rows)) return null;
  const complete = new Set(payload.evidence.rows.flatMap(row => record(row) && typeof row.citation === 'string'
    && !row.rowProjectionTruncated && record(row.data) && capturedOccurrence(row.data) ? [row.citation] : []));
  const claimed = new Set<string>();
  let removedRepeats = 0, removedUnknown = 0, droppedGroups = 0;
  const groups: ProposedGroup[] = [];
  for (const group of value.groups) {
    if (!record(group) || !text(group.name, 100) || !text(group.explanation, 1200) || !Array.isArray(group.citations)) return null;
    const name = group.name.trim();
    if (groups.some(existing => existing.name === name)) { droppedGroups++; continue; }
    const citations: string[] = [];
    for (const citation of group.citations.slice(0, 100)) {
      if (typeof citation !== 'string' || !complete.has(citation)) { removedUnknown++; continue; }
      if (claimed.has(citation)) { removedRepeats++; continue; }
      claimed.add(citation); citations.push(citation);
    }
    if (!citations.length) { droppedGroups++; continue; }
    groups.push({ name, explanation: group.explanation, citations });
  }
  if (!groups.length) return null;
  return { answer: JSON.stringify({ version: 1, kind: 'clash.groups', groups }), removedRepeats, removedUnknown, droppedGroups };
}
