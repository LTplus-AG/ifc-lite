/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { DocumentSpec, DocumentBlock } from './types';
import { nativeDocumentRevision } from './native-edit';
/** Strict metadata budget, independent of embedded image/evidence/text size. */
function preview(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length <= 256 ? value : { preview: value.slice(0, 256), characters: value.length, truncated: true };
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return depth >= 2 ? { items: value.length } : { items: value.length, first: value.slice(0, 8).map(row => preview(row, depth + 1)) };
  const entries = Object.entries(value);
  if (depth >= 2) return { fields: entries.slice(0, 12).map(([key]) => key.slice(0, 80)), total_fields: entries.length };
  return Object.fromEntries(entries.slice(0, 12).map(([key, v]) => [key.slice(0, 80), key === 'dataUrl' || key === 'generated' || key === 'payload' ? { omitted: true, characters: typeof v === 'string' ? v.length : 0 } : preview(v, depth + 1)]));
}
export async function nativeDocumentSummary(document: DocumentSpec) {
  return { id: document.id, name: document.name.slice(0, 256), name_truncated: document.name.length > 256, revision: await nativeDocumentRevision(document), blocks: document.blocks.length, page: { size: document.page.size, orientation: document.page.orientation }, has_ai_report: Boolean(document.aiReport) };
}
function metadataJson(value: unknown) { const json = JSON.stringify(preview(value)); return json.length <= 6000 ? json : JSON.stringify({ preview: json.slice(0, 4096), characters: json.length, truncated: true }); }
export function nativeBlockMetadata(block: DocumentBlock, index: number) {
  return { id: block.id, kind: block.kind, index, metadata_json: metadataJson(block) };
}
export function nativeDocumentPageMetadata(document: DocumentSpec) {
  return metadataJson({ name: document.name, page: { size: document.page.size, orientation: document.page.orientation }, pageHeading: document.pageHeading, pageFooter: document.pageFooter });
}
