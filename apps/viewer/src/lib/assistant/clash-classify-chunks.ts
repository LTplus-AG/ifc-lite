/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Full-run clash classification, pure half (P10): page every native finding
 * into bounded chunks with chunk-local citations, estimate the cost against a
 * root budget before anything is sent, and merge chunk answers by group name.
 */

import type { Clash } from '@ifc-lite/clash';
import { manualClashOccurrenceKey } from '../clash/manual-groups';
import type { RootBudgetLimits } from '@ifc-lite/ai';
import { clashDisciplineCandidates, CLASH_TAXONOMY_LIMITATIONS } from './clash-taxonomy';
import { evidenceJson } from './evidence';
import type { DraftFinding } from './clash-group-draft';

/** Matches the discussion sample: at most 100 citations (E1..E100) per request. */
export const CLASSIFY_CHUNK_ROWS = 100;
/** Text budget for one chunk's rows, below the discussion evidence limit. */
export const CLASSIFY_CHUNK_TEXT = 44_000;
export const CLASSIFY_OUTPUT_TOKENS = 4096;
export const CLASSIFY_TIMEOUT_MS = 120_000;
/** One root budget per run: 30 chunks (about 3,000 findings) at the full output ceiling. */
export const CLASSIFY_ROOT_BUDGET: RootBudgetLimits = { maxRequests: 30, maxOutputTokens: 30 * CLASSIFY_OUTPUT_TOKENS };

export interface ClassifyRow {
  citation: string;
  occurrence: string;
  clash: Clash;
  /** A row whose projection was shortened cannot be cited, exactly as in the discussion sample. */
  complete: boolean;
}
export interface ClassifyChunk { index: number; rows: ClassifyRow[]; payload: string }
export interface ClassifyPlan {
  clashes: readonly Clash[];
  chunks: ClassifyChunk[];
  /** Findings sharing one occurrence identity cannot be addressed as group members. */
  unaddressable: Clash[];
}

function rowData(clash: Clash) {
  return { id: clash.id, a: clash.a, b: clash.b, rule: clash.rule, status: clash.status, severity: clash.severity,
    distance: clash.distance, distanceKind: clash.distanceKind, disciplineCandidates: clashDisciplineCandidates(clash) };
}

function chunkPayload(index: number, rows: unknown[], total: number): string {
  return JSON.stringify({ source: 'clash', chunk: index + 1, totalFindings: total, includedRows: rows.length,
    evidence: { summary: { taxonomyLimitations: CLASH_TAXONOMY_LIMITATIONS }, rows } });
}

/** Deterministic: native order, at most 100 rows and CLASSIFY_CHUNK_TEXT characters per chunk. */
export function planClassification(clashes: readonly Clash[]): ClassifyPlan {
  const counts = new Map<string, number>();
  for (const clash of clashes) {
    const key = manualClashOccurrenceKey(clash);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const chunks: ClassifyChunk[] = [];
  const unaddressable: Clash[] = [];
  let rows: ClassifyRow[] = [], projected: unknown[] = [], length = 0;
  const close = () => {
    if (!rows.length) return;
    chunks.push({ index: chunks.length, rows, payload: chunkPayload(chunks.length, projected, clashes.length) });
    rows = []; projected = []; length = 0;
  };
  for (const clash of clashes) {
    const occurrence = manualClashOccurrenceKey(clash);
    if (counts.get(occurrence) !== 1) { unaddressable.push(clash); continue; }
    let projection = evidenceJson({ citation: `E${rows.length + 1}`, data: rowData(clash) });
    if (rows.length === CLASSIFY_CHUNK_ROWS || (rows.length && length + projection.text.length > CLASSIFY_CHUNK_TEXT)) {
      close();
      projection = evidenceJson({ citation: 'E1', data: rowData(clash) });
    }
    const value: unknown = JSON.parse(projection.text);
    const complete = !projection.truncated && typeof value === 'object' && value !== null && 'citation' in value;
    rows.push({ citation: `E${rows.length + 1}`, occurrence, clash, complete });
    projected.push(complete ? value : { citation: `E${rows.length}`, rowProjectionTruncated: true, data: { id: clash.id } });
    length += projection.text.length + 2;
  }
  close();
  return { clashes, chunks, unaddressable };
}

export interface ClassifyEstimate { chunks: number; requests: number; outputTokens: number; fits: boolean }

/** Worst case before starting: every chunk at its full output ceiling. */
export function estimateClassification(plan: ClassifyPlan, limits: RootBudgetLimits, routeCeiling: number): ClassifyEstimate {
  const perChunk = Math.min(CLASSIFY_OUTPUT_TOKENS, routeCeiling);
  const requests = plan.chunks.length;
  const outputTokens = requests * perChunk;
  return { chunks: requests, requests, outputTokens,
    fits: requests > 0 && requests <= limits.maxRequests && outputTokens <= limits.maxOutputTokens };
}

export interface ChunkGroup { name: string; explanation: string; citations: string[] }
export interface MergedGroup {
  name: string;
  explanation: string;
  /** 1-based chunks whose answers contributed, in order. */
  chunks: number[];
  findings: DraftFinding[];
}

const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');

/**
 * Merge accepted chunk answers by group name: names equal after trimming,
 * whitespace collapsing and case folding are one group. The first chunk's
 * spelling and rationale win; members follow chunk order. Chunks own disjoint
 * findings, so the merge cannot duplicate a member.
 */
export function mergeChunkGroups(answers: ReadonlyArray<{ chunk: ClassifyChunk; groups: readonly ChunkGroup[] }>): MergedGroup[] {
  const merged = new Map<string, MergedGroup>();
  for (const { chunk, groups } of [...answers].sort((a, b) => a.chunk.index - b.chunk.index)) {
    const rows = new Map(chunk.rows.map(row => [row.citation, row]));
    for (const group of groups) {
      const key = nameKey(group.name);
      const target = merged.get(key) ?? { name: group.name.trim(), explanation: group.explanation, chunks: [], findings: [] };
      merged.set(key, target);
      if (target.chunks.at(-1) !== chunk.index + 1) target.chunks.push(chunk.index + 1);
      for (const citation of group.citations) {
        const row = rows.get(citation);
        if (!row) throw new Error(`Chunk ${chunk.index + 1} cites unknown ${citation}`);
        target.findings.push({ citation: `C${chunk.index + 1}/${citation}`, occurrence: row.occurrence, nativeType: row.clash.status,
          nativeSeverity: row.clash.severity, disciplineCandidates: clashDisciplineCandidates(row.clash) });
      }
    }
  }
  return [...merged.values()];
}
