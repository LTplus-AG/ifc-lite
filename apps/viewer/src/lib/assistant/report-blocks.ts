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
import { sampledCapture, type CheckedClaim } from './report-claims';
import { appendixBlocks, narrativeBlocks } from './report-narrative';
import { reportFontNotice, reportTextFor, type ReportText } from './report-text';

export interface SlotBlock { slot: string | null; block: DocumentBlock }

/**
 * What a refresh found for one cited fact, relative to the previous capture. `unsampled`: the row
 * was not found, but the capture is a sample, so it may still exist outside it.
 */
export type FactChange = { kind: 'unchanged' } | { kind: 'changed' | 'missing' | 'unsampled'; previous: unknown; previousUnit?: string };

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

type Current = (citation: string) => string | null;

/**
 * A citation as it reads against the current capture: renumbered rows name both numbers; a row not
 * found is gone, unless the capture is a sample (`partial`) that may simply not include it.
 */
function relabel(citation: string, current: Current, partial: boolean, t: ReportText): string {
  const now = current(citation);
  if (now === null) return `${citation} (${t(partial ? 'citationOutside' : 'citationMissing')})`;
  return now === citation ? citation : `${now} (${t('citedAs', { citation })})`;
}

/** Rewrites every row citation in generated text against the current capture. */
const relabelText = (value: string, current: Current, partial: boolean, t: ReportText) =>
  value.replace(/\bE\d+\b/g, citation => relabel(citation, current, partial, t));

function claimCaption({ claim, current, changes }: ClaimPresentation, rows: ReturnType<typeof parseCapturedEvidence>, partial: boolean, t: ReportText): string {
  const sources = claim.citations.map(citation => relabel(citation, current, partial, t));
  const lines = [`${t(claim.status)} · ${t('sources')}: ${sources.length ? sources.join(', ') : t('none')}`];
  claim.results.forEach((result, index) => {
    const { fact, check } = result;
    const now = current(fact.citation) ?? fact.citation;
    const change = changes?.[index];
    const was = change && change.kind !== 'unchanged' ? `; ${t('was')} ${formatFactValue(change.previous, change.previousUnit)}` : '';
    if (check.kind === 'unknown-citation') { lines.push(`${fact.citation} ${fact.field}: ${t('missingEvidence')}${was}`); return; }
    const data = now === 'summary' ? rows.summary : rows.rows.get(now);
    const captured = formatFactValue(valueAt(data, fact.field), declaredUnit(data, rows.summary, fact.field));
    const claimed = formatFactValue(fact.value, fact.unit);
    if (check.kind === 'match') lines.push(`${now} ${fact.field}: ${captured} (${t('captured')})${change?.kind === 'changed' ? ` - ${t('changed')}${was}` : ''}`);
    else if (check.kind === 'mismatch') lines.push(`${now} ${fact.field}: ${t('claimed')} ${claimed}, ${t('captured')} ${captured} - ${check.reason}${was}`);
    else lines.push(`${now} ${fact.field}: ${t('claimed')} ${claimed}; ${check.reason}${was}`);
  });
  if (claim.edited) lines.push(t('claimEdited'));
  return lines.join('\n');
}

/** Blocks in document order. Throws when the text is mostly unprintable in the standard PDF fonts. */
export function buildReportBlocks(input: ReportBuild): SlotBlock[] {
  const { record } = input;
  const t = reportTextFor(record.language);
  const current: Current = input.current ?? (citation => citation);
  const partial = sampledCapture(record.evidence);
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
    text('provenance', 'small', t('provenance', { source: evidence.source, capturedAt: evidence.capturedAt,
      id: record.conversationId, model: record.model, language: record.language, revision: record.revision })),
    text('coverage', 'body', t('coverage', { included: evidence.includedRows, total: evidence.totalRows })
      + (sampledCapture(evidence) ? t('sample') : '') + (evidence.projectionTruncated ? t('truncated') : '') + t('historical')),
    ...(input.refreshSummary ? [text('refresh-summary', 'small', input.refreshSummary)] : []),
  ];
  const body: SlotBlock[] = [];
  if (record.narrative.trim() || !input.claims.length) {
    const narrative = counter('narrative');
    body.push(text('narrative-heading', 'heading', t('narrativeHeading')),
      ...narrativeBlocks(record.narrative, (style, value) => narrative(style, relabelText(value, current, partial, t)).block as TextBlock, t)
        .map(block => ({ slot: block.aiProvenance!.slot, block })));
  }
  if (input.claims.length) {
    body.push(text('claims-heading', 'heading', t('claimsHeading')),
      text('claims-intro', 'small', t('claimsIntro')));
    for (const presentation of input.claims) {
      const { claim, changes } = presentation;
      body.push(text(`claim:${claim.id}`, 'body', relabelText(claim.text, presentation.current, partial, t),
        relabelText(claim.generatedText ?? claim.text, presentation.current, partial, t)), text(`claim-facts:${claim.id}`, 'caption', claimCaption(presentation, rows, partial, t)));
      const flagged = changes?.filter(change => change.kind !== 'unchanged') ?? [];
      if (flagged.length) {
        const unsampled = flagged.filter(c => c.kind === 'unsampled').length;
        body.push(text(`claim-refresh:${claim.id}`, 'small', t('claimRefresh', { revision: record.revision,
          changed: flagged.filter(c => c.kind === 'changed').length, missing: flagged.filter(c => c.kind === 'missing').length })
          + (unsampled ? t('claimRefreshUnsampled', { count: unsampled }) : '') + t('reviewStatement')));
      }
    }
  }
  body.push(text('citations-note', 'small', input.proseCitations.length
    ? t('citations', { citations: input.proseCitations.map(citation => relabel(citation, current, partial, t)).join(', ') })
    : t(input.claims.length ? 'citationsNoneClaims' : 'citationsNone')));
  if (input.tables.length) body.push(text('native-heading', 'heading', t('nativeHeading')), ...input.tables.map(block => ({ slot: null, block })));
  const appendix = counter('appendix');
  const tail: SlotBlock[] = [
    { slot: null, block: { kind: 'page-break', id: freshBlockId() } },
    text('appendix-heading', 'heading', t('appendixHeading')),
    // Every included row and omission notice travels with the document as literal text, never live bindings.
    ...appendixBlocks(payload, [...rows.rows].map(([citation, data]) => ({ citation, data })),
      (style, value) => appendix(style, value).block as TextBlock, t).map(block => ({ slot: block.aiProvenance!.slot, block })),
  ];
  const notice = reportFontNotice(ledger, t);
  return [...head, ...(notice ? [text('font-notice', 'small', notice)] : []), ...body, ...tail];
}
