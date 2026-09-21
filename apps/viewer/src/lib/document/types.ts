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
import type { ListDefinition } from '@ifc-lite/lists';

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

/** Data rows a table block prints before its "… n more rows" line (#5142): one A4 portrait page by default. */
export const TABLE_ROWS_DEFAULT = 50;
export const TABLE_ROWS_MAX = 500;

/**
 * Where a table block's rows come from: a copy of a list (#5142), or the
 * store's live validation report (#5138) — the discriminator #5142 left
 * room for.
 */
export type TableSource = ListTableSource | ValidationTableSource;

export interface ListTableSource {
  kind: 'list';
  /**
   * A copy of the list (lists live in localStorage; the document must
   * travel), re-run on the loaded models whenever the document is shown or
   * printed. `expressIdsByModel` is never stored: it is keyed by the
   * per-load model id, so a selection snapshot is dead after any reload.
   */
  list: ListDefinition;
  /** Library / preset id the copy came from — enables "Update from saved list". */
  fromListId?: string;
}

/** Which rows a validation-results table prints (#5138). `'sets'` lists one row per `SetResult` (uniqueness/aggregate check) instead of per entity. */
export type ValidationRowsMode = 'failed' | 'passed' | 'all' | 'sets';

/** Every column a validation-results table can show; `resolve-validation-table.ts` picks values by these ids. */
export type TableColumnId =
  | 'rule' | 'result' | 'entityType' | 'name' | 'globalId' | 'model'
  | 'actual' | 'expected' | 'reason' | 'set' | 'members';

export const TABLE_COLUMN_IDS: readonly TableColumnId[] = [
  'rule', 'result', 'entityType', 'name', 'globalId', 'model', 'actual', 'expected', 'reason', 'set', 'members',
];

/**
 * A table block fed by the store's validation report (#5138), resolved at
 * render/print time — never a snapshot copied into the document — so a
 * document opened after re-validating shows THAT run's rows, and one whose
 * report is stale or absent says so instead of printing yesterday's rows.
 */
export interface ValidationTableSource {
  kind: 'validation';
  /** Narrows to one specification/rule; every rule when absent. */
  ruleId?: string;
  rows: ValidationRowsMode;
  columns: TableColumnId[];
}

/**
 * A table printed from either source (#5142, #5138): head + rows, paginated
 * with the head repeated. `TableBlock`'s own shape has not changed since
 * `DOCUMENT_VERSION` 3 added it — `source` grew a second member of its
 * existing union, the same kind of change `migrateDocumentSpec` already
 * treats as a no-op (a block gains a variant, not a field), so adding
 * `ValidationTableSource` here is NOT a version bump: an older-but-still-v3
 * viewer that has never seen `source.kind: 'validation'` still validates
 * every other block in the file correctly, and only refuses the one block
 * it cannot print — the version number would not have told it anything a
 * per-block structural check does not already say better.
 */
export interface TableBlock {
  kind: 'table';
  id: string;
  source: TableSource;
  /** Printed above the table; empty → the list's name (list source) or "Validation results" (validation source). */
  title?: string;
  caption?: string;
  /** Data rows printed before "… n more rows"; 1..TABLE_ROWS_MAX, default TABLE_ROWS_DEFAULT. */
  maxRows?: number;
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
 * `.ifclite-document.json` version 1 -> 2 (#4940) -> 3 (#5142): the shape
 * did not change for existing blocks (v2 added optional `width`/`height`
 * on chart/image, text styles and the spacer block; v3 added the table
 * block), so an older document is the current one with the version number
 * bumped. The bump is still made, so an older viewer refuses a file with a
 * block it cannot print instead of silently dropping it. Anything that is
 * not a recognizable older document passes through unchanged so
 * `validateDocumentSpec` reports the real problem.
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
      case 'table':
        validateTableBlock(block, at, errors);
        break;
      default:
        errors.push({ path: `${at}.kind`, message: 'expected text | image | chart | topic | spacer | table' });
    }
  });
  return errors;
}

const VALIDATION_ROWS_MODES = ['failed', 'passed', 'all', 'sets'];

/** Structural check of a table block (#5142, #5138); the list engine / validation report reading validates the definition's meaning at run time. */
function validateTableBlock(block: Record<string, unknown>, at: string, errors: DocumentValidationError[]): void {
  const source = block.source;
  if (!isRecord(source) || (source.kind !== 'list' && source.kind !== 'validation')) {
    errors.push({ path: `${at}.source`, message: 'expected source.kind list | validation' });
  } else if (source.kind === 'list') {
    const list = source.list;
    const columnsOk = isRecord(list) && Array.isArray(list.columns) && list.columns.every((c: unknown) => isRecord(c) && isString(c.id));
    if (!isRecord(list) || !isString(list.id) || list.id.length === 0 || !isString(list.name) || !Array.isArray(list.entityTypes) || !Array.isArray(list.conditions) || !columnsOk) {
      errors.push({ path: `${at}.source.list`, message: 'expected a list definition' });
    } else if (list.expressIdsByModel !== undefined) {
      errors.push({ path: `${at}.source.list.expressIdsByModel`, message: 'not allowed in a document' });
    }
    if (source.fromListId !== undefined && !isString(source.fromListId)) errors.push({ path: `${at}.source.fromListId`, message: 'expected a string' });
  } else {
    if (source.ruleId !== undefined && !isString(source.ruleId)) errors.push({ path: `${at}.source.ruleId`, message: 'expected a string' });
    if (!VALIDATION_ROWS_MODES.includes(source.rows as string)) errors.push({ path: `${at}.source.rows`, message: `expected ${VALIDATION_ROWS_MODES.join(' | ')}` });
    if (!Array.isArray(source.columns) || source.columns.length === 0 || !source.columns.every((c: unknown) => TABLE_COLUMN_IDS.includes(c as TableColumnId))) {
      errors.push({ path: `${at}.source.columns`, message: `expected a non-empty array of ${TABLE_COLUMN_IDS.join(' | ')}` });
    }
  }
  if (block.title !== undefined && !isString(block.title)) errors.push({ path: `${at}.title`, message: 'expected a string' });
  if (block.caption !== undefined && !isString(block.caption)) errors.push({ path: `${at}.caption`, message: 'expected a string' });
  if (block.maxRows !== undefined && (!Number.isInteger(block.maxRows) || (block.maxRows as number) < 1 || (block.maxRows as number) > TABLE_ROWS_MAX)) {
    errors.push({ path: `${at}.maxRows`, message: `expected an integer between 1 and ${TABLE_ROWS_MAX}` });
  }
}

/** The copy of a list a table block stores: a fresh id, no selection snapshot (see `ListTableSource.list`). */
export function listCopyForDocument(list: ListDefinition, id: string): ListDefinition {
  const { expressIdsByModel: _dropped, ...rest } = list;
  void _dropped;
  return { ...rest, id };
}
