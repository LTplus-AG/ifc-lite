/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A document (#4594): a free-form page — text, logos, charts, BCF topics —
 * whose text is a template over the loaded model. `{IfcProject.Name}`
 * resolves when the document is shown or printed, so the same document
 * opened on the next revision of the file reads that revision's values,
 * and a binding that no longer resolves says so instead of going blank.
 *
 * The shape is plain JSON: it is what `.ifclite-document.json` carries.
 */
import type { ChartSpec, ReportPageSetup } from '@ifc-lite/charts';

export const DOCUMENT_VERSION = 3;

/** A block that can sit two-up in a row (#4940): `'half'` only takes effect when the block right after it is also a chart/image at `'half'`; unpaired, it prints full width. */
export type BlockWidth = 'full' | 'half';

export interface TextBlock {
  kind: 'text';
  id: string;
  /** Template text; `{path}` placeholders resolve against the model (see `bindings.ts`). */
  text: string;
  style: 'title' | 'heading' | 'subheading' | 'body' | 'small' | 'caption';
}

export interface ImageBlock {
  kind: 'image';
  id: string;
  /** `data:image/png;base64,…` or `data:image/jpeg;base64,…` — a logo travels with the file. */
  dataUrl: string;
  /** Printed height in points; the width follows the image's aspect ratio. */
  height: number;
  align: 'left' | 'center' | 'right';
  caption?: string;
  /** `'half'` pairs this block with the next half chart/image into one row (#4940). Default `'full'`. */
  width?: BlockWidth;
}

export interface ChartBlock {
  kind: 'chart';
  id: string;
  /** A copy of the chart spec, so the document does not depend on a dashboard still existing. */
  chart: ChartSpec;
  /** Print a 3D snapshot of the chart's largest bucket next to it. */
  snapshot: boolean;
  /** Printed height in points, 120-600 (#4940). Default 220. */
  height?: number;
  /** `'half'` pairs this block with the next half chart/image into one row (#4940). Default `'full'`. */
  width?: BlockWidth;
}

export interface TopicBlock {
  kind: 'topic';
  id: string;
  /** BCF topic GUID — survives a new IFC revision, and a re-imported BCF. */
  guid: string;
  /** Whether to print the topic's first viewpoint snapshot. */
  snapshot: boolean;
}

/** Blank vertical space between blocks, in points (#4940). Reuses the move/remove block UI; no other content. */
export interface SpacerBlock {
  kind: 'spacer';
  id: string;
  height: number;
}

/** How a `table` block picks rows from the store's validation report (#5138). `'sets'` lists one row per `SetResult` instead of per entity. */
export type TableRowsMode = 'failed' | 'passed' | 'all' | 'sets';
export const TABLE_ROWS_MODES: readonly TableRowsMode[] = ['failed', 'passed', 'all', 'sets'];

/** Every column a table block can show; `bindings.ts`'s row resolver picks values by these ids. */
export type TableColumnId =
  | 'rule' | 'result' | 'entityType' | 'name' | 'globalId' | 'model'
  | 'actual' | 'expected' | 'reason' | 'set' | 'members';

export const TABLE_COLUMN_IDS: readonly TableColumnId[] = [
  'rule', 'result', 'entityType', 'name', 'globalId', 'model', 'actual', 'expected', 'reason', 'set', 'members',
];

/**
 * A table of validation results (#5138): resolved from `idsValidationReport`
 * in the store at render/print time — never a snapshot copied into the
 * document — so a stale or cleared report is caught and shown as a
 * placeholder instead of printing yesterday's rows. See `table-rows.ts`.
 */
export interface TableBlock {
  kind: 'table';
  id: string;
  source: { kind: 'validation'; ruleId?: string; rows: TableRowsMode };
  columns: TableColumnId[];
  title?: string;
  caption?: string;
  width?: BlockWidth;
}

export type DocumentBlock = TextBlock | ImageBlock | ChartBlock | TopicBlock | SpacerBlock | TableBlock;
export type DocumentBlockKind = DocumentBlock['kind'];

export const CHART_BLOCK_HEIGHT_MIN = 120;
export const CHART_BLOCK_HEIGHT_MAX = 600;
export const CHART_BLOCK_HEIGHT_DEFAULT = 220;

export interface DocumentSpec {
  version: typeof DOCUMENT_VERSION;
  id: string;
  name: string;
  page: ReportPageSetup;
  blocks: DocumentBlock[];
}

/** `true` when `block` may pair with an adjacent `'half'` block into one row — chart and image only (#4940). */
export function isHalfPairable(block: DocumentBlock): block is (ChartBlock | ImageBlock) & { width: 'half' } {
  return (block.kind === 'chart' || block.kind === 'image') && block.width === 'half';
}

/**
 * `.ifclite-document.json` version 1 -> 3 (#4940, #5138): the shape has
 * never changed for existing blocks across either bump (v2 added optional
 * chart/image fields and two additive block kinds; v3 adds `table`, itself
 * just another block kind), so a v1 or v2 document is a v3 document with
 * the version number bumped. Anything that is not a recognizable v1/v2
 * document passes through unchanged so `validateDocumentSpec` reports the
 * real problem.
 */
export function migrateDocumentSpec(raw: unknown): unknown {
  if (!isRecord(raw) || (raw.version !== 1 && raw.version !== 2)) return raw;
  return { ...raw, version: DOCUMENT_VERSION };
}

export interface DocumentValidationError {
  path: string;
  message: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';

/** Structural validation of a parsed document; every problem, with its JSON path. */
export function validateDocumentSpec(input: unknown): DocumentValidationError[] {
  const errors: DocumentValidationError[] = [];
  if (!isRecord(input)) return [{ path: '', message: 'expected an object' }];
  if (input.version !== DOCUMENT_VERSION) errors.push({ path: 'version', message: `expected version ${DOCUMENT_VERSION}` });
  if (!isString(input.id) || input.id.length === 0) errors.push({ path: 'id', message: 'expected a non-empty string' });
  if (!isString(input.name)) errors.push({ path: 'name', message: 'expected a string' });
  const page = input.page;
  if (!isRecord(page) || (page.size !== 'A4' && page.size !== 'A3') || (page.orientation !== 'portrait' && page.orientation !== 'landscape')) {
    errors.push({ path: 'page', message: 'expected { size: A4 | A3, orientation: portrait | landscape }' });
  }
  if (!Array.isArray(input.blocks)) {
    errors.push({ path: 'blocks', message: 'expected an array' });
    return errors;
  }
  const ids = new Set<string>();
  const TEXT_STYLE_NAMES = ['title', 'heading', 'subheading', 'body', 'small', 'caption'];
  const checkWidth = (block: Record<string, unknown>, at: string): void => {
    if (block.width !== undefined && block.width !== 'full' && block.width !== 'half') errors.push({ path: `${at}.width`, message: 'expected full | half' });
  };
  input.blocks.forEach((block: unknown, i) => {
    const at = `blocks[${i}]`;
    if (!isRecord(block)) {
      errors.push({ path: at, message: 'expected an object' });
      return;
    }
    if (!isString(block.id) || block.id.length === 0) errors.push({ path: `${at}.id`, message: 'expected a non-empty string' });
    else if (ids.has(block.id)) errors.push({ path: `${at}.id`, message: `duplicate block id "${block.id}"` });
    else ids.add(block.id);
    switch (block.kind) {
      case 'text':
        if (!isString(block.text)) errors.push({ path: `${at}.text`, message: 'expected a string' });
        if (!TEXT_STYLE_NAMES.includes(block.style as string)) errors.push({ path: `${at}.style`, message: `expected ${TEXT_STYLE_NAMES.join(' | ')}` });
        break;
      case 'image':
        if (!isString(block.dataUrl) || !/^data:image\/(png|jpeg);base64,/.test(block.dataUrl)) errors.push({ path: `${at}.dataUrl`, message: 'expected a PNG or JPEG data URL' });
        if (typeof block.height !== 'number' || !(block.height > 0)) errors.push({ path: `${at}.height`, message: 'expected a positive number' });
        if (block.align !== 'left' && block.align !== 'center' && block.align !== 'right') errors.push({ path: `${at}.align`, message: 'expected left | center | right' });
        if (block.caption !== undefined && !isString(block.caption)) errors.push({ path: `${at}.caption`, message: 'expected a string' });
        checkWidth(block, at);
        break;
      case 'chart':
        if (!isRecord(block.chart) || !isString(block.chart.id) || !isString(block.chart.title)) errors.push({ path: `${at}.chart`, message: 'expected a chart spec' });
        if (typeof block.snapshot !== 'boolean') errors.push({ path: `${at}.snapshot`, message: 'expected a boolean' });
        if (block.height !== undefined && (typeof block.height !== 'number' || !Number.isFinite(block.height) || block.height < CHART_BLOCK_HEIGHT_MIN || block.height > CHART_BLOCK_HEIGHT_MAX)) {
          errors.push({ path: `${at}.height`, message: `expected a number between ${CHART_BLOCK_HEIGHT_MIN} and ${CHART_BLOCK_HEIGHT_MAX}` });
        }
        checkWidth(block, at);
        break;
      case 'topic':
        if (!isString(block.guid) || block.guid.length === 0) errors.push({ path: `${at}.guid`, message: 'expected a topic GUID' });
        if (typeof block.snapshot !== 'boolean') errors.push({ path: `${at}.snapshot`, message: 'expected a boolean' });
        break;
      case 'spacer':
        // Number.isFinite also rejects Infinity/-Infinity/NaN — a `1e309` in an imported file
        // parses as Infinity and would otherwise pass "a positive number" straight into a CSS
        // height in the preview (review finding).
        if (typeof block.height !== 'number' || !Number.isFinite(block.height) || !(block.height > 0)) errors.push({ path: `${at}.height`, message: 'expected a positive number' });
        break;
      case 'table': {
        const source = block.source;
        if (!isRecord(source) || source.kind !== 'validation' || (source.ruleId !== undefined && !isString(source.ruleId)) || !TABLE_ROWS_MODES.includes(source.rows as TableRowsMode)) {
          errors.push({ path: `${at}.source`, message: `expected { kind: validation, ruleId?: string, rows: ${TABLE_ROWS_MODES.join(' | ')} }` });
        }
        if (!Array.isArray(block.columns) || block.columns.length === 0 || !block.columns.every((c) => TABLE_COLUMN_IDS.includes(c as TableColumnId))) {
          errors.push({ path: `${at}.columns`, message: `expected a non-empty array of ${TABLE_COLUMN_IDS.join(' | ')}` });
        }
        if (block.title !== undefined && !isString(block.title)) errors.push({ path: `${at}.title`, message: 'expected a string' });
        if (block.caption !== undefined && !isString(block.caption)) errors.push({ path: `${at}.caption`, message: 'expected a string' });
        checkWidth(block, at);
        break;
      }
      default:
        errors.push({ path: `${at}.kind`, message: 'expected text | image | chart | topic | spacer | table' });
    }
  });
  return errors;
}
