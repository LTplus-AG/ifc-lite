/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { CloudError } from './config.js';
export async function readBytes(response: Response, limit: number): Promise<Uint8Array> {
  const size = Number(response.headers.get('content-length'));
  if (size > limit) { await response.body?.cancel(); throw new CloudError(413, 'too-large', 'Cloud response exceeds the size limit.'); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) throw new CloudError(413, 'too-large', 'Cloud response exceeds the size limit.');
      chunks.push(next.value);
    }
  } catch (error) { await reader.cancel(); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
export async function readJson(response: Response, limit = 8 * 1024 * 1024): Promise<unknown> {
  const bytes = await readBytes(response, limit);
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new CloudError(502, 'invalid-json', 'Cloud response was not valid JSON.'); }
}
export function stripDownloadUrls(value: unknown): unknown {
  // JSON parse already rejects cyclic values; iterative walk avoids vendor-controlled stack depth.
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    const record = current as Record<string, unknown>;
    delete record['@microsoft.graph.downloadUrl'];
    for (const child of Object.values(record)) pending.push(child);
  }
  return value;
}
