/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { buildExportFilename, csvBlob, isCsvMime, sanitizeFilename, downloadBlob } from '@/lib/export/download';
import type { ToolHost } from '../types';
import { invalidInput, unavailable } from './refusals';

export interface ArtifactMetadata { artifact_id: string; filename: string; mime_type: string; bytes: number }
export interface ArtifactInput { filename: string; mimeType: string; data: string | Uint8Array | Blob }
export interface OperationArtifacts { create(input: ArtifactInput): Promise<ArtifactMetadata> }
/** `needsCsvBom`: a CSV that lacks the UTF-8 BOM, which the user's SAVED copy gets (#11452) but `viewer_artifact_read` bytes do not. */
interface Artifact { metadata: ArtifactMetadata; blob: Blob; needsCsvBom: boolean }
const owned = new WeakMap<ToolHost, Map<string, Artifact>>();
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ARTIFACTS = 32;
function artifacts(host: ToolHost) {
  let entries = owned.get(host);
  if (!entries) {
    entries = new Map(); owned.set(host, entries);
    host.lifetimeSignal?.addEventListener('abort', () => entries?.clear(), { once: true });
  }
  return entries;
}
function live(host: ToolHost) { host.lifetimeSignal?.throwIfAborted(); }
/** Sanitize stem and extension separately, so truncation never drops the extension. */
function artifactFilename(name: string): string {
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1];
  return ext ? buildExportFilename(name.slice(0, -(ext.length + 1)), ext) : sanitizeFilename(name);
}
export function operationArtifacts(host: ToolHost, commit: <T>(write: () => T) => T): OperationArtifacts {
  return { async create(input) {
    live(host);
    if (!input.filename.trim() || input.filename.length > 500 || input.mimeType.length > 200) throw invalidInput('invalid-value', 'Invalid artifact name or MIME type.');
    const blob = input.data instanceof Blob ? input.data : new Blob([
      typeof input.data === 'string' ? input.data : new Uint8Array(input.data),
    ], { type: input.mimeType });
    // The agent reads artifact bytes verbatim, so the BOM Excel needs is added
    // only to the downloaded copy; record here whether it is missing.
    const needsCsvBom = isCsvMime(input.mimeType) && !(await hasUtf8Bom(blob));
    const metadata: ArtifactMetadata = { artifact_id: crypto.randomUUID(), filename: artifactFilename(input.filename), mime_type: input.mimeType, bytes: blob.size };
    return commit(() => {
      live(host);
      const entries = artifacts(host);
      const total = [...entries.values()].reduce((sum, entry) => sum + entry.blob.size, 0);
      if (entries.size >= MAX_ARTIFACTS || total + blob.size > MAX_BYTES) throw unavailable('Host artifact quota reached. Download or delete artifacts before creating more.');
      entries.set(metadata.artifact_id, { metadata, blob, needsCsvBom });
      return { ...metadata };
    });
  } };
}
async function hasUtf8Bom(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  return head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
}
function get(host: ToolHost, id: string): Artifact {
  live(host);
  const artifact = artifacts(host).get(id);
  if (!artifact) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Unknown artifact for this agent host.' });
  return artifact;
}
export function listArtifacts(host: ToolHost): ArtifactMetadata[] {
  live(host); return [...artifacts(host).values()].map(entry => ({ ...entry.metadata }));
}
/** Read a complete JSON artifact only within the operation's decoded byte budget. */
export async function readJsonArtifactText(host: ToolHost, id: string, maxBytes: number): Promise<string> {
  const { blob, metadata } = get(host, id);
  if (metadata.mime_type !== 'application/json') throw invalidInput('invalid-value', 'Expected a JSON artifact.');
  if (blob.size > maxBytes) throw invalidInput('limit', 'The JSON artifact exceeds the import byte limit.', { limit: maxBytes });
  const text = await blob.text();
  live(host);
  return text;
}
export async function readArtifact(host: ToolHost, id: string, offset: number, length: number) {
  const artifact = get(host, id);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > artifact.blob.size || !Number.isSafeInteger(length) || length < 1 || length > 65536) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Read requires a valid byte offset and length from 1 to 65536.' });
  const bytes = new Uint8Array(await artifact.blob.slice(offset, offset + length).arrayBuffer());
  live(host);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { ...artifact.metadata, offset, length: bytes.length, encoding: 'base64', data: btoa(binary), next_offset: offset + bytes.length < artifact.blob.size ? offset + bytes.length : null };
}
export function removeArtifact(host: ToolHost, id: string) { get(host, id); artifacts(host).delete(id); return { removed: id }; }
export function downloadArtifact(host: ToolHost, id: string) {
  const entry = get(host, id);
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') throw unavailable('A mounted browser download host is required.');
  // csvBlob on empty content yields exactly the BOM, in the same Blob type the other CSV saves use.
  const blob = entry.needsCsvBom ? new Blob([csvBlob(new Uint8Array(0)), entry.blob], { type: entry.blob.type || entry.metadata.mime_type }) : entry.blob;
  downloadBlob(blob, entry.metadata.filename);
  return { artifact_id: id, status: 'dispatched' as const };
}
