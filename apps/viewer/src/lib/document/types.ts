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

export const DOCUMENT_VERSION = 1;

export interface TextBlock {
  kind: 'text';
  id: string;
  /** Template text; `{path}` placeholders resolve against the model (see `bindings.ts`). */
  text: string;
  style: 'title' | 'heading' | 'body';
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
}

export interface ChartBlock {
  kind: 'chart';
  id: string;
  /** A copy of the chart spec, so the document does not depend on a dashboard still existing. */
  chart: ChartSpec;
  /** Print a 3D snapshot of the chart's largest bucket next to it. */
  snapshot: boolean;
}

export interface TopicBlock {
  kind: 'topic';
  id: string;
  /** BCF topic GUID — survives a new IFC revision, and a re-imported BCF. */
  guid: string;
  /** Whether to print the topic's first viewpoint snapshot. */
  snapshot: boolean;
}

export type DocumentBlock = TextBlock | ImageBlock | ChartBlock | TopicBlock;
export type DocumentBlockKind = DocumentBlock['kind'];

export interface DocumentSpec {
  version: typeof DOCUMENT_VERSION;
  id: string;
  name: string;
  page: ReportPageSetup;
  blocks: DocumentBlock[];
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
        if (block.style !== 'title' && block.style !== 'heading' && block.style !== 'body') errors.push({ path: `${at}.style`, message: 'expected title | heading | body' });
        break;
      case 'image':
        if (!isString(block.dataUrl) || !/^data:image\/(png|jpeg);base64,/.test(block.dataUrl)) errors.push({ path: `${at}.dataUrl`, message: 'expected a PNG or JPEG data URL' });
        if (typeof block.height !== 'number' || !(block.height > 0)) errors.push({ path: `${at}.height`, message: 'expected a positive number' });
        if (block.align !== 'left' && block.align !== 'center' && block.align !== 'right') errors.push({ path: `${at}.align`, message: 'expected left | center | right' });
        if (block.caption !== undefined && !isString(block.caption)) errors.push({ path: `${at}.caption`, message: 'expected a string' });
        break;
      case 'chart':
        if (!isRecord(block.chart) || !isString(block.chart.id) || !isString(block.chart.title)) errors.push({ path: `${at}.chart`, message: 'expected a chart spec' });
        if (typeof block.snapshot !== 'boolean') errors.push({ path: `${at}.snapshot`, message: 'expected a boolean' });
        break;
      case 'topic':
        if (!isString(block.guid) || block.guid.length === 0) errors.push({ path: `${at}.guid`, message: 'expected a topic GUID' });
        if (typeof block.snapshot !== 'boolean') errors.push({ path: `${at}.snapshot`, message: 'expected a boolean' });
        break;
      default:
        errors.push({ path: `${at}.kind`, message: 'expected text | image | chart | topic' });
    }
  });
  return errors;
}
