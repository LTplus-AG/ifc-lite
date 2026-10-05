/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Native document blocks of an AI report (#6918). Every generated text block
 * gets a stable slot and its exact generated text, so a later evidence refresh
 * can regenerate untouched blocks and leave human edits alone. Text is made
 * printable for the standard PDF fonts here, once, so preview and PDF agree.
 */

import { literalTemplateText } from '../document/bindings';
import { freshBlockId } from '../document/persistence';
import type { AiReportRecord } from '../document/ai-report-types';
import type { DocumentBlock, TableBlock, TextBlock } from '../document/types';
import { StandardFontLedger, unprintableShare } from '../document/standard-font-text';
import { parseCapturedEvidence } from './captured-rows';
import { declaredUnit, formatFactValue, valueAt } from './report-facts';
import type { CheckedClaim } from './report-claims';
import { appendixBlocks, narrativeBlocks } from './report-narrative';

export interface SlotBlock { slot: string | null; block: DocumentBlock }

/** What a refresh found for one cited fact, relative to the previous capture. */
export type FactChange = { kind: 'unchanged' } | { kind: 'changed' | 'missing'; previous: unknown; previousUnit?: string };

export interface ClaimPresentation {
  claim: CheckedClaim;
  /** Current citation for a citation as written in the claim; null when the row is gone. */
  current: (citation: string) => string | null;
  /** Per fact, after a refresh only. */
  changes?: FactChange[];
}

export interface ReportBuild {
  title: string;
  record: AiReportRecord;
  claims: ClaimPresentation[];
  tables: TableBlock[];
  /** Citations used by the prose narrative. */
  proseCitations: string[];
  /** Current citation for a citation as written in the narrative or a claim; identity at generation. */
  current?: (citation: string) => string | null;
  /** Present after a refresh: what was re-checked. */
  refreshSummary?: string;
}

const STATUS_LABEL = {
  supported: 'Supported by captured data',
  unverifiable: 'Unverifiable from captured data (treat as interpretation)',
  contradicted: 'Contradicted by captured data',
} as const;

/** A citation as it reads against the current capture: renumbered rows name both numbers, gone rows say so. */
function relabel(citation: string, current: (citation: string) => string | null): string {
  const now = current(citation);
  return now === null ? `${citation} (no longer in the evidence)` : now === citation ? citation : `${now} (cited as ${citation})`;
}

/** Rewrites every row citation in generated text against the current capture. */
const relabelText = (value: string, current: (citation: string) => string | null) =>
  value.replace(/\bE\d+\b/g, citation => relabel(citation, current));

function claimCaption({ claim, current, changes }: ClaimPresentation, rows: ReturnType<typeof parseCapturedEvidence>): string {
  const sources = claim.citations.map(citation => relabel(citation, current));
  const lines = [`${STATUS_LABEL[claim.status]} · Sources: ${sources.length ? sources.join(', ') : 'none'}`];
  claim.results.forEach((result, index) => {
    const { fact, check } = result;
    const now = current(fact.citation) ?? fact.citation;
    const change = changes?.[index];
    const was = change && change.kind !== 'unchanged' ? `; was ${formatFactValue(change.previous, change.previousUnit)}` : '';
    if (check.kind === 'unknown-citation') { lines.push(`${fact.citation} ${fact.field}: missing from the evidence${was}`); return; }
    const data = now === 'summary' ? rows.summary : rows.rows.get(now);
    const captured = formatFactValue(valueAt(data, fact.field), declaredUnit(data, rows.summary, fact.field));
    const claimed = formatFactValue(fact.value, fact.unit);
    if (check.kind === 'match') lines.push(`${now} ${fact.field}: ${captured} (captured)${change?.kind === 'changed' ? ` - changed${was}` : ''}`);
    else if (check.kind === 'mismatch') lines.push(`${now} ${fact.field}: claimed ${claimed}, captured ${captured} - ${check.reason}${was}`);
    else lines.push(`${now} ${fact.field}: claimed ${claimed}; ${check.reason}${was}`);
  });
  if (claim.edited) lines.push('Claim text edited by a reviewer before saving.');
  return lines.join('\n');
}

/** Blocks in document order. Throws when the text is mostly unprintable in the standard PDF fonts. */
export function buildReportBlocks(input: ReportBuild): SlotBlock[] {
  const { record } = input;
  const current = input.current ?? ((citation: string) => citation);
  // Judged on the provider's own text: native values in other scripts are reported, the narrative must print.
  if (unprintableShare([record.narrative, ...record.claims.map(claim => claim.text)].join('\n')) > 0.1) {
    throw new Error('Most of this text cannot be printed with the standard PDF fonts. Choose a Latin-script report language.');
  }
  const evidence = record.evidence;
  const ledger = new StandardFontLedger();
  /** `generated` differs from `value` only for text a reviewer rewrote before saving: the block then reads as human-edited. */
  const text = (slot: string, style: TextBlock['style'], value: string, generated = value): SlotBlock => {
    const stored = literalTemplateText(ledger.print(value));
    const baseline = generated === value ? stored : literalTemplateText(ledger.print(generated));
    return { slot, block: { kind: 'text', id: freshBlockId(), style, text: stored, aiProvenance: { origin: 'ai', slot, generated: baseline } } };
  };
  const counter = (prefix: string) => { let index = 0; return (style: TextBlock['style'], value: string) => text(`${prefix}:${index++}`, style, value); };
  const rows = parseCapturedEvidence(evidence.payload);
  const payload = JSON.parse(evidence.payload) as Record<string, unknown>;
  const head: SlotBlock[] = [
    text('title', 'title', input.title),
    text('provenance', 'small', `AI narrative draft · Source: ${evidence.source} · Captured: ${evidence.capturedAt}\nEvidence identity: ${record.conversationId}`
      + `\nProvider model: ${record.model}\nNarrative language: ${record.language} · Revision ${record.revision}`),
    text('coverage', 'body', `Included evidence: ${evidence.includedRows} of ${evidence.totalRows} native rows.\n`
      + (evidence.includedRows < evidence.totalRows ? 'This is a sample; unseen findings are not evaluated by this narrative.\n' : '')
      + (evidence.projectionTruncated ? 'Some evidence values were shortened or omitted.\n' : '')
      + 'Captured evidence is historical. AI prose requires human verification and does not change native results or certify compliance.'),
    ...(input.refreshSummary ? [text('refresh-summary', 'small', input.refreshSummary)] : []),
  ];
  const body: SlotBlock[] = [];
  if (record.narrative.trim() || !input.claims.length) {
    const narrative = counter('narrative');
    body.push(text('narrative-heading', 'heading', 'Narrative for review'),
      ...narrativeBlocks(record.narrative, (style, value) => narrative(style, relabelText(value, current)).block as TextBlock)
        .map(block => ({ slot: block.aiProvenance!.slot, block })));
  }
  if (input.claims.length) {
    body.push(text('claims-heading', 'heading', 'Claims checked against captured evidence'),
      text('claims-intro', 'small', 'Each claim was checked against the native values it cites. Supported means every cited value matches the captured row; it does not certify the conclusion.'));
    for (const presentation of input.claims) {
      const { claim, changes } = presentation;
      body.push(text(`claim:${claim.id}`, 'body', relabelText(claim.text, presentation.current),
        relabelText(claim.generatedText ?? claim.text, presentation.current)), text(`claim-facts:${claim.id}`, 'caption', claimCaption(presentation, rows)));
      const flagged = changes?.filter(change => change.kind !== 'unchanged') ?? [];
      if (flagged.length) {
        body.push(text(`claim-refresh:${claim.id}`, 'small', `Evidence refreshed (revision ${record.revision}): ${flagged.filter(c => c.kind === 'changed').length} cited value(s) changed`
          + ` and ${flagged.filter(c => c.kind === 'missing').length} are missing since this claim was written. Review the statement above.`));
      }
    }
  }
  body.push(text('citations-note', 'small', input.proseCitations.length
    ? `Referenced evidence: ${input.proseCitations.map(citation => relabel(citation, current)).join(', ')}. Citation existence does not prove that a claim is supported.`
    : input.claims.length ? 'The narrative prose has no row citations; only the claims above were checked against the evidence.'
      : 'The narrative has no row citations. Verify each factual claim against the captured evidence.'));
  if (input.tables.length) body.push(text('native-heading', 'heading', 'Native results'), ...input.tables.map(block => ({ slot: null, block })));
  const appendix = counter('appendix');
  const tail: SlotBlock[] = [
    { slot: null, block: { kind: 'page-break', id: freshBlockId() } },
    text('appendix-heading', 'heading', 'Captured evidence appendix'),
    // Every included row and omission notice travels with the document as literal text, never live bindings.
    ...appendixBlocks(payload, [...rows.rows].map(([citation, data]) => ({ citation, data })),
      (style, value) => appendix(style, value).block as TextBlock).map(block => ({ slot: block.aiProvenance!.slot, block })),
  ];
  const notice = ledger.notice();
  return [...head, ...(notice ? [text('font-notice', 'small', notice)] : []), ...body, ...tail];
}
