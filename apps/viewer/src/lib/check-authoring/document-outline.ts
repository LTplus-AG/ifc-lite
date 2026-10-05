/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `document.outline` (viewer AI P07, #6915): a report outline built from
 * native document blocks. Validation tables are bound to the store's live
 * validation report (`ValidationTableSource`), never filled with values the
 * model wrote; the optional summary is the native report snapshot block taken
 * from the current report. Prose is kept as literal text (no template
 * bindings) and labelled as an unverified draft.
 */

import type { ValidationReport } from '@ifc-lite/ids';
import { literalTemplateText } from '../document/bindings';
import { idsReportBlockFromReport } from '../document/ids-report';
import { freshBlockId, freshDocumentId } from '../document/persistence';
import {
  DOCUMENT_VERSION, TABLE_COLUMN_IDS, TABLE_ROWS_MAX, validateDocumentSpec,
  type DocumentBlock, type DocumentSpec, type TableColumnId, type TextBlock, type ValidationRowsMode,
} from '../document/types';
import { isRecord, onlyKeys, optionalText, parseProposalEnvelope, parseUnsupported, requiredText, unsupportedNote, type UnsupportedRequirement } from './proposal-json';

const PURPOSES = ['summary', 'findings', 'changes', 'actions', 'coverage', 'other'] as const;
const TEXT_STYLES = ['subheading', 'body', 'small', 'caption'] as const;
const ROWS: readonly ValidationRowsMode[] = ['failed', 'passed', 'all', 'sets'];

export type OutlineBlock =
  | { kind: 'text'; style: typeof TEXT_STYLES[number]; text: string }
  | { kind: 'validationTable'; specification?: string; rows: ValidationRowsMode; columns: TableColumnId[]; title?: string; caption?: string; maxRows?: number }
  | { kind: 'validationSummary' }
  | { kind: 'pageBreak' };

export interface OutlineSection { heading: string; purpose: typeof PURPOSES[number]; blocks: OutlineBlock[] }

export interface DocumentOutline {
  title: string;
  rationale?: string;
  sections: OutlineSection[];
  unsupported: UnsupportedRequirement[];
}

function block(value: unknown, at: string): OutlineBlock {
  if (!isRecord(value)) throw new Error(`${at} must be a block object with "kind"`);
  switch (value.kind) {
    case 'text': {
      onlyKeys(value, ['kind', 'style', 'text'], at);
      const style = value.style ?? 'body';
      if (!TEXT_STYLES.includes(style as typeof TEXT_STYLES[number])) throw new Error(`${at}.style must be ${TEXT_STYLES.join(', ')}`);
      return { kind: 'text', style: style as typeof TEXT_STYLES[number], text: requiredText(value, 'text', at, 4000) };
    }
    case 'validationTable': {
      onlyKeys(value, ['kind', 'specification', 'rows', 'columns', 'title', 'caption', 'maxRows'], at);
      if (!ROWS.includes(value.rows as ValidationRowsMode)) throw new Error(`${at}.rows must be ${ROWS.join(', ')}`);
      if (!Array.isArray(value.columns) || value.columns.length === 0 || !value.columns.every(c => TABLE_COLUMN_IDS.includes(c as TableColumnId))) {
        throw new Error(`${at}.columns must list columns from ${TABLE_COLUMN_IDS.join(', ')}`);
      }
      if (value.maxRows !== undefined && (!Number.isInteger(value.maxRows) || (value.maxRows as number) < 1 || (value.maxRows as number) > TABLE_ROWS_MAX)) {
        throw new Error(`${at}.maxRows must be an integer from 1 to ${TABLE_ROWS_MAX}`);
      }
      const specification = optionalText(value, 'specification', at, 200), title = optionalText(value, 'title', at), caption = optionalText(value, 'caption', at, 500);
      return { kind: 'validationTable', rows: value.rows as ValidationRowsMode, columns: [...new Set(value.columns as TableColumnId[])],
        ...(specification ? { specification } : {}), ...(title ? { title } : {}), ...(caption ? { caption } : {}),
        ...(value.maxRows !== undefined ? { maxRows: value.maxRows as number } : {}) };
    }
    case 'validationSummary':
      onlyKeys(value, ['kind'], at);
      return { kind: 'validationSummary' };
    case 'pageBreak':
      onlyKeys(value, ['kind'], at);
      return { kind: 'pageBreak' };
    default:
      throw new Error(`${at}.kind must be text, validationTable, validationSummary or pageBreak; values come from native blocks, not written numbers`);
  }
}

export function parseDocumentOutline(answer: string): DocumentOutline {
  const value = parseProposalEnvelope(answer, 'document.outline');
  onlyKeys(value, ['version', 'kind', 'title', 'rationale', 'sections', 'unsupported'], 'The outline');
  const title = requiredText(value, 'title', 'The outline');
  const rationale = optionalText(value, 'rationale', 'The outline');
  if (!Array.isArray(value.sections) || value.sections.length === 0 || value.sections.length > 20) throw new Error('"sections" must list 1 to 20 sections');
  let total = 0;
  const sections = value.sections.map((section, index): OutlineSection => {
    const at = `sections[${index}]`;
    if (!isRecord(section)) throw new Error(`${at} must be an object {heading, purpose, blocks}`);
    onlyKeys(section, ['heading', 'purpose', 'blocks'], at);
    const purpose = section.purpose ?? 'other';
    if (!PURPOSES.includes(purpose as typeof PURPOSES[number])) throw new Error(`${at}.purpose must be ${PURPOSES.join(', ')}`);
    if (!Array.isArray(section.blocks) || section.blocks.length > 20) throw new Error(`${at}.blocks must list at most 20 blocks`);
    total += section.blocks.length;
    return { heading: requiredText(section, 'heading', at), purpose: purpose as typeof PURPOSES[number],
      blocks: section.blocks.map((item, i) => block(item, `${at}.blocks[${i}]`)) };
  });
  if (total > 200) throw new Error('An outline may hold at most 200 blocks');
  return { title, ...(rationale ? { rationale } : {}), sections, unsupported: parseUnsupported(value.unsupported) };
}

export interface DocumentDraft {
  outline: DocumentOutline;
  document: DocumentSpec;
  /** The native report the tables and summary were bound against; null when none was loaded. */
  report: ValidationReport | null;
}

const PROVENANCE = 'Outline drafted with AI assistance. Validation tables are live native results, resolved whenever this document is shown or printed; '
  + 'a validation summary is the native report snapshot taken when the draft was prepared. Text is an unverified draft: check every statement.';

/** Native document blocks from a parsed outline; refuses tables bound to a specification the current report lacks. */
export function prepareDocumentDraft(outline: DocumentOutline, report: ValidationReport | null): DocumentDraft {
  const text = (style: TextBlock['style'], value: string): TextBlock => ({ kind: 'text', id: freshBlockId(), style, text: literalTemplateText(value) });
  const specs = new Set(report?.specificationResults.map(result => result.specification.id) ?? []);
  const blocks: DocumentBlock[] = [text('title', outline.title), text('small', PROVENANCE)];
  outline.sections.forEach((section, s) => {
    blocks.push(text('heading', section.heading));
    section.blocks.forEach((item, b) => {
      const at = `sections[${s}].blocks[${b}]`;
      if (item.kind === 'text') blocks.push(text(item.style, item.text));
      else if (item.kind === 'pageBreak') blocks.push({ kind: 'page-break', id: freshBlockId() });
      else if (item.kind === 'validationSummary') {
        if (!report) throw new Error(`${at}: a validation summary needs a current validation report; run the native validation first`);
        blocks.push(idsReportBlockFromReport(report, freshBlockId()));
      } else {
        if (item.specification && !report) throw new Error(`${at}: no current validation report to bind "${item.specification}" to; run the native validation first`);
        if (item.specification && !specs.has(item.specification)) {
          throw new Error(`${at}: specification "${item.specification}" is not in the current report; use one of ${[...specs].slice(0, 10).join(', ')}`);
        }
        blocks.push({ kind: 'table', id: freshBlockId(), source: { kind: 'validation', rows: item.rows, columns: item.columns,
          ...(item.specification ? { ruleId: item.specification } : {}) },
          ...(item.title ? { title: item.title } : {}), ...(item.caption ? { caption: item.caption } : {}), ...(item.maxRows ? { maxRows: item.maxRows } : {}) });
      }
    });
  });
  const note = unsupportedNote(outline.unsupported);
  if (note) blocks.push(text('heading', 'Not covered by this report'), text('body', note));
  const document: DocumentSpec = { version: DOCUMENT_VERSION, id: freshDocumentId(), name: outline.title,
    page: { size: 'A4', orientation: 'portrait' }, blocks };
  const errors = validateDocumentSpec(document);
  if (errors.length) throw new Error(`Invalid native document: ${errors.map(error => `${error.path} ${error.message}`).join('; ')}`);
  return { outline, document, report };
}
