/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Presentation of an assistant answer and its captured evidence as native
 * document text blocks. Models answer in Markdown (and sometimes as a typed
 * JSON proposal); a document must read as a document, not as source text.
 */

import type { TextBlock } from '../document/types';
import { parseClashGroupPatch } from './clash-group-proposal';
import { parseMarkdown, plainInline } from './markdown';
import { rowFields } from './captured-rows';

type Text = (style: TextBlock['style'], value: string) => TextBlock;

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function typedClashProposal(answer: string) {
  if (!/"kind"\s*:\s*"clash\.groups"/.test(answer)) return null;
  try { return parseClashGroupPatch(answer); }
  catch (error) {
    // The answer is then presented as written; its citations are still validated by the caller.
    console.warn('[Assistant report] Clash proposal could not be structured', error);
    return null;
  }
}

/** Narrative blocks: typed clash proposals become one section per group; Markdown maps onto text styles. */
export function narrativeBlocks(answer: string, text: Text): TextBlock[] {
  const proposal = typedClashProposal(answer);
  if (proposal) {
    return [
      text('body', `Proposed grouping: ${proposal.groups.length} group${proposal.groups.length === 1 ? '' : 's'}. Groups are AI suggestions over captured rows and do not change native findings or review status.`),
      ...proposal.groups.flatMap(group => [
        text('subheading', group.name),
        text('body', group.explanation),
        text('small', `Findings (${group.citations.length}): ${group.citations.join(', ')}`),
      ]),
    ];
  }
  const blocks: TextBlock[] = [];
  for (const block of parseMarkdown(answer)) {
    switch (block.kind) {
      case 'heading': blocks.push(text('subheading', plainInline(block.text))); break;
      case 'paragraph': blocks.push(text('body', plainInline(block.text))); break;
      case 'list': blocks.push(text('body', block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : '•'} ${plainInline(item)}`).join('\n'))); break;
      case 'table': blocks.push(text('small', [block.header, ...block.rows].map(row => row.map(plainInline).join('  ·  ')).join('\n'))); break;
      case 'code': blocks.push(text('small', block.text)); break;
      case 'rule': break;
    }
  }
  return blocks.length ? blocks : [text('body', answer)];
}

function clashLine(citation: string, data: Record<string, unknown>): string | null {
  const a = data.a, b = data.b;
  if (!record(a) || !record(b)) return null;
  const candidates = record(data.disciplineCandidates) ? data.disciplineCandidates : {};
  const side = (codes: unknown) => Array.isArray(codes) && codes.length ? codes.join('/') : 'unknown';
  const distance = typeof data.distance === 'number' ? `${Number(data.distance.toPrecision(3))} m${data.distanceKind ? ` (${String(data.distanceKind)})` : ''}` : 'distance n/a';
  return `${citation}  ${String(a.tag ?? '?')} vs ${String(b.tag ?? '?')} · ${String(data.status ?? '?')} · ${String(data.severity ?? '?')} · ${distance}`
    + ` · disciplines ${side(candidates.a)} vs ${side(candidates.b)} · ${String(a.key ?? '?')} vs ${String(b.key ?? '?')}`;
}

/** Readable appendix: what was captured, from which models, and every included row on one line. */
export function appendixBlocks(payload: Record<string, unknown>, rows: Array<{ citation: string; data: unknown }>, text: Text): TextBlock[] {
  const models = Array.isArray(payload.models) ? payload.models.filter(record) : [];
  const evidence = record(payload.evidence) ? payload.evidence : {};
  const summary = rowFields(evidence.summary).filter(([, value]) => value !== '—');
  return [
    text('body', `Models at capture: ${models.length ? models.map(model => `${String(model.name)}${model.fingerprint ? ` (${String(model.fingerprint)})` : ''}`).join('; ') : 'not recorded'}.`
      + `\nRows: ${String(payload.includedRows ?? rows.length)} of ${String(payload.totalRows ?? rows.length)} included${payload.sampled ? ' (sample)' : ''}${payload.projectionTruncated ? '; some values shortened' : ''}.`),
    ...(summary.length ? [text('subheading', 'Native summary'), text('small', summary.map(([key, value]) => `${key}: ${value}`).join('\n'))] : []),
    text('subheading', 'Captured rows'),
    text('small', rows.map(({ citation, data }) => (record(data) && clashLine(citation, data))
      || `${citation}  ${rowFields(data).map(([key, value]) => `${key}: ${value}`).join(' · ')}`).join('\n')),
  ];
}
