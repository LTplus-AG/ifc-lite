/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { documentContent, copyDocumentBlock, freshBlockId } from './persistence';
import { detachAiProvenance } from './ai-report-types';
import { reorderDocumentBlocks } from './reorder-blocks';
import { validateDocumentSpec, type DocumentSpec, type DocumentBlock } from './types';
const shared = ['width', 'scale', 'title', 'titleFontSize', 'titleTextColor', 'titleBackgroundColor'];
const fields: Record<DocumentBlock['kind'], readonly string[]> = {
  text: [...shared, 'text', 'style', 'font', 'fontSize', 'textColor', 'backgroundColor'], image: [...shared, 'height', 'align', 'caption'],
  chart: [...shared, 'chart', 'snapshot', 'height', 'fontSize'], topic: [...shared, 'guid', 'snapshot'], spacer: ['height'], 'page-break': [],
  table: [...shared, 'source', 'maxRows', 'caption', 'headerBackground', 'headerTextColor', 'groupOrder'],
  'quality-gate': ['scale', 'title', 'titleFontSize', 'titleTextColor', 'titleBackgroundColor', 'clashReportId', 'row'],
  'ids-report': [...shared, 'variant', 'specificationsOnly', 'benchmarks', 'showStamp'], 'manual-report': [...shared, 'variant', 'benchmarks', 'showStamp'],
};
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a native settings object.'); return value as Record<string, unknown>; }
function allowed(value: Record<string, unknown>, keys: readonly string[]) { for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unsupported native edit field: ${key}`); }
function validated(value: unknown): DocumentSpec { const errors = validateDocumentSpec(value); if (errors.length) throw new Error(`Native document validation refused the edit: ${errors.slice(0, 3).map(error => `${error.path}: ${error.message}`).join('; ')}`); const next = documentContent.decode(value); if (!next) throw new Error('Native document validation refused the edit.'); return next; }
/** Preserve all unedited block/media/provenance references, as the panel does. */
export function replaceNativeDocumentBlocks(document: DocumentSpec, blocks: DocumentBlock[]): DocumentSpec { return validated({ ...document, blocks }); }
export function patchNativeDocumentBlock(document: DocumentSpec, id: string, patchValue: unknown): DocumentSpec {
  const block = document.blocks.find(row => row.id === id); if (!block) throw new Error('Unknown native document block.');
  const patch = record(patchValue); allowed(patch, fields[block.kind]);
  // null clears an optional native style override. Required fields remain validated below.
  const updated: Record<string, unknown> = { ...block, ...patch }; for (const key of Object.keys(patch)) if (patch[key] === null) delete updated[key];
  return validated({ ...document, blocks: document.blocks.map(row => row.id === id ? updated : row) });
}
export function patchNativeDocumentPage(document: DocumentSpec, patchValue: unknown): DocumentSpec {
  const patch = record(patchValue); allowed(patch, ['name', 'page', 'pageHeading', 'pageFooter']);
  const next: Record<string, unknown> = { ...document };
  if ('name' in patch) next.name = patch.name;
  if ('page' in patch) { const page = record(patch.page); allowed(page, ['size', 'orientation']); next.page = { ...document.page, ...page }; }
  for (const key of ['pageHeading', 'pageFooter'] as const) {
    if (!(key in patch)) continue;
    if (patch[key] === null) { delete next[key]; continue; }
    const band = record(patch[key]); allowed(band, ['text', 'font', 'fontSize', 'textColor', 'logo', 'showDate', 'showPageNumbers']);
    const old = document[key]; const value: Record<string, unknown> = { ...old, ...band };
    if ('logo' in band) { if (band.logo === null) delete value.logo; else { const logo = record(band.logo); allowed(logo, ['height']); value.logo = { ...old?.logo, ...logo }; } }
    for (const field of ['text', 'font', 'fontSize', 'textColor', 'showDate', 'showPageNumbers']) if (value[field] === null) delete value[field];
    next[key] = value;
  }
  return validated(next);
}
export function moveNativeDocumentBlocks(document: DocumentSpec, ids: ReadonlySet<string>, beforeId: string | null, allowUnfinishedDraft = false): DocumentSpec {
  const blocks = reorderDocumentBlocks(document.blocks, ids, beforeId);
  if (blocks === document.blocks) return document;
  return allowUnfinishedDraft ? { ...document, blocks } : replaceNativeDocumentBlocks(document, blocks);
}
export function copyNativeDocumentBlock(document: DocumentSpec, id: string, allowUnfinishedDraft = false): { document: DocumentSpec; id: string } {
  const index = document.blocks.findIndex(row => row.id === id); if (index < 0) throw new Error('Unknown native document block.');
  const copy = detachAiProvenance(copyDocumentBlock(document.blocks[index]));
  const blocks = [...document.blocks.slice(0, index + 1), copy, ...document.blocks.slice(index + 1)];
  return { document: allowUnfinishedDraft ? { ...document, blocks } : replaceNativeDocumentBlocks(document, blocks), id: copy.id };
}
export function addNativeDocumentBlock(document: DocumentSpec, value: unknown, beforeId: string | null): { document: DocumentSpec; id: string } {
  const block = record(value); const kind = block.kind;
  if (typeof kind !== 'string' || !Object.hasOwn(fields, kind)) throw new Error('Unknown native block kind.');
  allowed(block, ['kind', ...fields[kind as DocumentBlock['kind']], ...(kind === 'image' ? ['dataUrl'] : [])]);
  if (beforeId !== null && !document.blocks.some(row => row.id === beforeId)) throw new Error('Unknown native insertion target.');
  const id = freshBlockId(); const index = beforeId === null ? document.blocks.length : document.blocks.findIndex(row => row.id === beforeId);
  const next = validated({ ...document, blocks: [...document.blocks.slice(0, index), { ...block, id }, ...document.blocks.slice(index)] });
  return { document: next, id };
}
/** Includes media and AI evidence locally; only this compact fingerprint crosses the tool boundary. */
export async function nativeDocumentRevision(document: DocumentSpec): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(document)));
  return `sha256:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
