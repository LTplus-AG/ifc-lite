/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Human labelling for the AI evaluation (#6928): sheet construction, sheet
 * validation and agreement statistics. A label sheet is what a person fills
 * in; nothing in this module judges whether an answer is right.
 *
 *   claims    one verdict per sentence of a prose answer: supported by the
 *             native evidence it cites (or by any supplied row), unsupported,
 *             not-factual, or cannot-judge. The machine invariants only check
 *             that cited rows EXIST; this is the independent support check.
 *   grouping  the reviewer groups the captured clash findings WITHOUT seeing
 *             the model's proposal (blind sheets omit it), then rates each
 *             proposed group and counts the corrections it needed.
 *
 * Agreement is reported with its denominators; with fewer than two completed
 * reviewers there is no agreement figure, only counts.
 */

import { createHash } from 'node:crypto';
import { validateSchema } from './schema-subset.mjs';

export const CLAIM_VERDICTS = ['supported', 'unsupported', 'not-factual', 'cannot-judge'];
export const GROUP_VERDICTS = ['useful', 'needs-correction', 'wrong'];
export const UNCLASSIFIED = '__unclassified__';

export const answerSha256 = text => createHash('sha256').update(text).digest('hex');

/** Sentences of a prose answer with the evidence rows each cites, in order. */
export function claimUnits(text) {
  const sentences = text.replace(/\r\n?/g, '\n').split(/\n+|(?<=[.!?])\s+(?=[A-Z\[(])/).map(part => part.trim()).filter(Boolean);
  return sentences.map((sentence, index) => ({ id: `c${index + 1}`, text: sentence,
    citations: [...new Set([...sentence.matchAll(/\bE\d+\b/g)].map(match => match[0]))], verdict: null, note: '' }));
}

const label = row => {
  const data = row.data ?? {};
  if (data.a?.tag && data.b?.tag) return `${data.a.tag} "${data.a.name ?? ''}" vs ${data.b.tag} "${data.b.name ?? ''}" (${data.status ?? '?'}, ${data.severity ?? '?'})`;
  return JSON.stringify(data).slice(0, 160);
};

/** The proposed groups of a clash.groups answer, or null when the answer is not one. */
export function proposedGroups(text) {
  try {
    const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1'));
    if (value?.kind !== 'clash.groups' || !Array.isArray(value.groups)) return null;
    return value.groups.map(group => ({ name: String(group.name), citations: Array.isArray(group.citations) ? group.citations.filter(item => typeof item === 'string') : [] }));
  } catch { return null; }
}

/**
 * A blank sheet for one recording and label kind. `answer` is the decoded
 * answer text. Grouping sheets list the captured findings for independent
 * grouping and carry the proposal only for the later rating step.
 */
export function buildSheet({ recording, kind, answer, reviewerId }) {
  const sheet = { version: 1, id: `${recording.id}.${kind}.${reviewerId}`, recording: recording.id, task: recording.task, kind,
    answerSha256: answerSha256(answer), reviewer: { id: reviewerId, status: 'blank' } };
  if (kind === 'claims') return { ...sheet, claims: claimUnits(answer) };
  const groups = proposedGroups(answer);
  if (!groups) throw new Error(`${recording.id}: the answer is not a clash.groups proposal`);
  const rows = Array.isArray(recording.evidence?.evidence?.rows) ? recording.evidence.evidence.rows : [];
  return { ...sheet,
    findings: rows.map(row => ({ citation: row.citation, summary: label(row), group: null })),
    proposal: { groups: groups.map(group => ({ ...group, verdict: null, note: '' })), corrections: null } };
}

/** Errors in a sheet (structure, vocabulary, completeness when it claims to be complete). */
export function sheetErrors(sheet, schema) {
  const errors = validateSchema(schema, sheet);
  if (errors.length) return errors;
  const complete = sheet.reviewer.status === 'complete';
  for (const claim of sheet.claims ?? []) {
    if (claim.verdict !== null && !CLAIM_VERDICTS.includes(claim.verdict)) errors.push(`claim ${claim.id}: unknown verdict ${claim.verdict}`);
    if (complete && claim.verdict === null) errors.push(`claim ${claim.id}: a complete sheet has a verdict for every claim`);
  }
  for (const group of sheet.proposal?.groups ?? []) {
    if (group.verdict !== null && !GROUP_VERDICTS.includes(group.verdict)) errors.push(`group ${group.name}: unknown verdict ${group.verdict}`);
    if (complete && group.verdict === null) errors.push(`group ${group.name}: a complete sheet rates every proposed group`);
  }
  if (complete && sheet.kind === 'grouping') {
    if (sheet.findings.some(finding => !finding.group)) errors.push('findings: a complete sheet assigns every finding a group (use __unclassified__ to leave one out)');
    if (sheet.proposal.corrections === null) errors.push('proposal.corrections: a complete sheet counts the corrections the proposal needed');
  }
  return errors;
}

/** Cohen's kappa over paired categorical labels; null when undefined (no items, or both constant and equal). */
export function cohenKappa(pairs) {
  if (!pairs.length) return null;
  const agree = pairs.filter(([a, b]) => a === b).length / pairs.length;
  const categories = [...new Set(pairs.flat())];
  const expected = categories.reduce((sum, category) =>
    sum + (pairs.filter(([a]) => a === category).length / pairs.length) * (pairs.filter(([, b]) => b === category).length / pairs.length), 0);
  return expected === 1 ? null : (agree - expected) / (1 - expected);
}

const choose2 = n => n * (n - 1) / 2;

/** Adjusted Rand index between two labelings of the same items (`{ item: label }`); null when undefined. */
export function adjustedRandIndex(a, b) {
  const items = Object.keys(a).filter(item => item in b);
  const n = items.length;
  if (n < 2) return null;
  const cells = new Map();
  const rowTotals = new Map();
  const colTotals = new Map();
  for (const item of items) {
    const key = `${a[item]}\u0000${b[item]}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
    rowTotals.set(a[item], (rowTotals.get(a[item]) ?? 0) + 1);
    colTotals.set(b[item], (colTotals.get(b[item]) ?? 0) + 1);
  }
  const sumCells = [...cells.values()].reduce((sum, value) => sum + choose2(value), 0);
  const sumRows = [...rowTotals.values()].reduce((sum, value) => sum + choose2(value), 0);
  const sumCols = [...colTotals.values()].reduce((sum, value) => sum + choose2(value), 0);
  const expected = sumRows * sumCols / choose2(n);
  const max = (sumRows + sumCols) / 2;
  return max === expected ? null : (sumCells - expected) / (max - expected);
}

/** The model's partition of the captured findings: each proposed group a label, every other finding its own singleton. */
export function proposalLabeling(sheet) {
  const labeling = Object.fromEntries(sheet.findings.map(finding => [finding.citation, `single:${finding.citation}`]));
  for (const group of sheet.proposal.groups) for (const citation of group.citations) if (citation in labeling) labeling[citation] = `group:${group.name}`;
  return labeling;
}

const reviewerLabeling = sheet => Object.fromEntries(sheet.findings.map(finding =>
  [finding.citation, finding.group === UNCLASSIFIED ? `single:${finding.citation}` : finding.group]));
const round = value => value === null ? null : Math.round(value * 1000) / 1000;
const pairsOf = list => list.flatMap((first, index) => list.slice(index + 1).map(second => [first, second]));

/**
 * Score completed sheets for one recording and kind. Incomplete or blank
 * sheets are counted and ignored, never guessed.
 */
export function scoreSheets(sheets) {
  const complete = sheets.filter(sheet => sheet.reviewer.status === 'complete');
  const out = { sheets: sheets.length, completeReviewers: complete.length, kind: sheets[0]?.kind ?? null };
  if (!complete.length) return { ...out, note: 'no completed sheet: nothing to report' };
  if (out.kind === 'claims') {
    const supportOnly = verdict => verdict === 'supported' || verdict === 'unsupported';
    out.perReviewer = complete.map(sheet => {
      const counts = Object.fromEntries(CLAIM_VERDICTS.map(verdict => [verdict, sheet.claims.filter(claim => claim.verdict === verdict).length]));
      const judged = counts.supported + counts.unsupported;
      return { reviewer: sheet.reviewer.id, counts, unsupportedRate: judged ? round(counts.unsupported / judged) : null, judged };
    });
    out.agreement = pairsOf(complete).map(([first, second]) => {
      const pairs = first.claims.flatMap(claim => {
        const other = second.claims.find(candidate => candidate.id === claim.id);
        return other && supportOnly(claim.verdict) && supportOnly(other.verdict) ? [[claim.verdict, other.verdict]] : [];
      });
      return { reviewers: [first.reviewer.id, second.reviewer.id], items: pairs.length, kappa: round(cohenKappa(pairs)),
        rawAgreement: pairs.length ? round(pairs.filter(([a, b]) => a === b).length / pairs.length) : null };
    });
    return out;
  }
  out.perReviewer = complete.map(sheet => {
    const groups = sheet.proposal.groups;
    return { reviewer: sheet.reviewer.id, corrections: sheet.proposal.corrections,
      groupVerdicts: Object.fromEntries(GROUP_VERDICTS.map(verdict => [verdict, groups.filter(group => group.verdict === verdict).length])),
      ariVsProposal: round(adjustedRandIndex(reviewerLabeling(sheet), proposalLabeling(sheet))) };
  });
  out.agreement = pairsOf(complete).map(([first, second]) => ({ reviewers: [first.reviewer.id, second.reviewer.id],
    ari: round(adjustedRandIndex(reviewerLabeling(first), reviewerLabeling(second))) }));
  return out;
}
