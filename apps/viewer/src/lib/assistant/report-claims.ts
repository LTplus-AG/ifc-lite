/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Typed report claims (#6918). A provider may append a `report.claims` JSON
 * block to its prose (or answer with it alone). Each claim is checked
 * against the captured evidence: cited rows must exist, and every cited
 * native value must equal the captured value (exactly, or at the decimals a
 * string value writes out) after unit conversion. The check decides one of three states; it never upgrades prose.
 */

import type { AiClaimFact, AiClaimStatus, AiReportClaim } from '../document/ai-report-types';
import type { CapturedEvidence } from './captured-rows';
import { compareFact, declaredUnit, SUMMARY_CITATION, valueAt, type FactCheck } from './report-facts';

export const REPORT_CLAIMS_OUTPUT_GUIDANCE =
  'When asked to draft a report, write the narrative in Markdown, then append one fenced json block '
  + '{"version":1,"kind":"report.claims","language":"<BCP 47 tag>","claims":[{"text":"One checkable statement [E3]",'
  + '"citations":["E3"],"facts":[{"citation":"E3","field":"distance","value":-0.02,"unit":"m"}]}]}. '
  + 'Each claim states one observation; each fact copies a native value exactly from its cited row (field is the JSON path '
  + 'inside the row data, such as a.tag or requirementResults[0].actualValue) or from the native summary with citation "summary". '
  + 'Numbers are compared exactly; to state a rounded value, give it as a string with its decimals, such as "-0.10". '
  + 'Give a unit only when the evidence states one. Interpretations and recommendations belong in the narrative, not in claims. At most 30 claims.';

export interface ProposedClaim { text: string; citations: string[]; facts: AiClaimFact[] }
export interface ReportClaimsEnvelope { language: string | null; claims: ProposedClaim[] }

export type FactResult = { fact: AiClaimFact; check: FactCheck | { kind: 'unknown-citation'; reason: string } };
export interface CheckedClaim extends AiReportClaim { results: FactResult[]; unknownCitations: string[] }

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const CITATION = /^(?:E[1-9]\d{0,2}|summary)$/;
const FENCE = /```(?:json)?[ \t]*\n([\s\S]*?)\n[ \t]*```/g;
const DECLARES = /"kind"\s*:\s*"report\.claims"/;

/** Row citations written in a claim statement; each one is checked like a listed citation. */
function textCitations(statement: string): string[] {
  const named = [...new Set([...statement.matchAll(/\bE\d+\b/g)].map(match => match[0]))];
  const invalid = named.filter(citation => !CITATION.test(citation));
  if (invalid.length) throw new Error(`Claim text cites ${invalid.join(', ')}, which is not a captured row citation such as E3.`);
  return named;
}

/** Splits an answer into prose and its typed claims block. A declared but invalid block is refused, never ignored. */
export function splitReportAnswer(answer: string): { prose: string; envelope: ReportClaimsEnvelope | null } {
  if (!DECLARES.test(answer)) return { prose: answer, envelope: null };
  const trimmed = answer.trim();
  let json: string | null = null;
  let prose = '';
  if (trimmed.startsWith('{')) json = trimmed;
  else {
    for (const match of answer.matchAll(FENCE)) {
      if (!DECLARES.test(match[1])) continue;
      json = match[1];
      prose = (answer.slice(0, match.index) + answer.slice(match.index! + match[0].length)).trim();
      break;
    }
  }
  if (json === null) throw new Error('The typed report claims must be one complete JSON block.');
  let value: unknown;
  try { value = JSON.parse(json); }
  catch (error) { throw new Error(`The typed report claims are not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  return { prose, envelope: parseEnvelope(value) };
}

function parseFact(value: unknown): AiClaimFact {
  if (!record(value) || typeof value.citation !== 'string' || !CITATION.test(value.citation) || !text(value.field, 200)
    || !(typeof value.value === 'string' || typeof value.value === 'boolean' || (typeof value.value === 'number' && Number.isFinite(value.value)))
    || (typeof value.value === 'string' && value.value.length > 500)
    || (value.unit !== undefined && value.unit !== null && !text(value.unit, 40))) {
    throw new Error('Each claim fact needs a citation, a field path, a single value and an optional unit.');
  }
  return { citation: value.citation, field: value.field.trim(), value: value.value,
    ...(typeof value.unit === 'string' ? { unit: value.unit.trim() } : {}) };
}

function parseEnvelope(value: unknown): ReportClaimsEnvelope {
  if (!record(value) || value.version !== 1 || value.kind !== 'report.claims' || !Array.isArray(value.claims) || value.claims.length > 30) {
    throw new Error('Expected {"version":1,"kind":"report.claims","claims":[…]} with at most 30 claims.');
  }
  const claims = value.claims.map((claim): ProposedClaim => {
    if (!record(claim) || !text(claim.text, 1200)) throw new Error('Each claim needs its statement text (at most 1,200 characters).');
    const facts = claim.facts === undefined ? [] : Array.isArray(claim.facts) && claim.facts.length <= 20 ? claim.facts.map(parseFact) : null;
    if (!facts) throw new Error('A claim may cite at most 20 facts.');
    const cited = claim.citations === undefined ? [] : claim.citations;
    if (!Array.isArray(cited) || cited.length > 100 || !cited.every(c => typeof c === 'string' && CITATION.test(c))) {
      throw new Error('Claim citations must be captured row citations such as E3.');
    }
    const statement = claim.text.trim();
    const citations = [...new Set([...cited as string[], ...facts.map(fact => fact.citation), ...textCitations(statement)])];
    return { text: statement, citations, facts };
  });
  return { language: typeof value.language === 'string' && value.language.length <= 35 ? value.language : null, claims };
}

/** Claim status from its fact results. */
export function claimStatus(results: FactResult[], unknownCitations: string[]): AiClaimStatus {
  if (unknownCitations.length || results.some(result => result.check.kind === 'mismatch' || result.check.kind === 'unknown-citation')) return 'contradicted';
  if (!results.length || results.some(result => result.check.kind !== 'match')) return 'unverifiable';
  return 'supported';
}

function source(captured: CapturedEvidence, citation: string): { found: boolean; data: unknown } {
  if (citation === SUMMARY_CITATION) return { found: true, data: captured.summary };
  return { found: captured.rows.has(citation), data: captured.rows.get(citation) };
}

/** One fact against one capture. `resolve` maps a claim citation to the citation it now has (refresh). */
export function checkFact(fact: AiClaimFact, captured: CapturedEvidence, resolve: (citation: string) => string | null = c => c): FactResult {
  const current = resolve(fact.citation);
  const row = current === null ? { found: false, data: undefined } : source(captured, current);
  if (!row.found) return { fact, check: { kind: 'unknown-citation', reason: `${fact.citation} is not in the captured evidence` } };
  const captured_ = valueAt(row.data, fact.field);
  return { fact, check: compareFact(fact.value, fact.unit, captured_, declaredUnit(row.data, captured.summary, fact.field)) };
}

export function checkClaim(claim: Omit<AiReportClaim, 'status'>, captured: CapturedEvidence, resolve?: (citation: string) => string | null): CheckedClaim {
  const results = claim.facts.map(fact => checkFact(fact, captured, resolve));
  const unknownCitations = claim.citations.filter(citation => {
    const current = resolve ? resolve(citation) : citation;
    return current === null || !source(captured, current).found;
  });
  return { ...claim, status: claimStatus(results, unknownCitations), results, unknownCitations };
}

export function checkProposedClaims(claims: ProposedClaim[], captured: CapturedEvidence): CheckedClaim[] {
  return claims.map((claim, index) => checkClaim({ id: `C${index + 1}`, edited: false, ...claim }, captured));
}

/** A reviewer rewrites a claim: its text becomes theirs and its contradicted facts no longer stand. */
export function editClaim(claim: CheckedClaim, textValue: string, captured: CapturedEvidence): CheckedClaim {
  if (!text(textValue, 1200)) throw new Error('A claim needs its statement text (at most 1,200 characters).');
  const kept = claim.results.filter(result => result.check.kind !== 'mismatch' && result.check.kind !== 'unknown-citation').map(result => result.fact);
  const statement = textValue.trim();
  const known = claim.citations.filter(citation => !claim.unknownCitations.includes(citation));
  const citations = [...new Set([...known, ...textCitations(statement)])];
  return checkClaim({ id: claim.id, text: statement, citations, facts: kept, edited: true, generatedText: claim.generatedText ?? claim.text }, captured);
}
