/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Bounded JSON/error reads only. Model downloads never use this helper. */
export async function readLimitedText(response: Response, max: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let remaining = max;
  try {
    while (remaining > 0) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      remaining -= value.byteLength;
    }
    await reader.cancel();
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid index object');
  return value as RecordValue;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid index integer');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid index string');
  return value;
}
function attachment(value: unknown): { id: number; name: string } | null {
  if (value === null) return null;
  const item = object(value);
  return { id: integer(item.id), name: text(item.name) };
}
function projectDocument(value: unknown) {
  const doc = object(value);
  const version = object(doc.latestVersion);
  const location = attachment(doc.attachedToLocation);
  const project = attachment(doc.attachedToProject);
  const phase = attachment(doc.attachedToProjectPhase);
  if (!location || typeof doc.allowDownload !== 'boolean') throw new Error('Invalid index document');
  const versionNumber = typeof version.versionNumber === 'number'
    ? String(version.versionNumber) : text(version.versionNumber);
  return {
    documentId: integer(doc.id), documentNumber: text(doc.documentNumber),
    versionNumber, versionId: integer(version.id), fileName: text(version.originalFileName),
    allowDownload: doc.allowDownload, locationId: location.id, locationName: location.name,
    projectId: project?.id ?? null, projectName: project?.name ?? null, projectPhaseName: phase?.name ?? null,
  };
}

/** Fixed POST payload, bounded to ten pages/5000 records regardless of totals. */
export async function readIndex(
  send: (init: RequestInit) => Promise<Response>,
  authorizationHeaders: Headers,
  locationId: number,
  projectId?: number,
): Promise<{ status: number; body: unknown }> {
  const headers = new Headers(authorizationHeaders);
  headers.set('content-type', 'application/json');
  const records: ReturnType<typeof projectDocument>[] = [];
  for (let start = 0; start < 5000; start += 500) {
    const response = await send({ method: 'POST', headers, body: JSON.stringify({
      columns: [], search: { regex: false, value: '' }, order: [], draw: 0,
      start, length: 500, locationId, ...(projectId === undefined ? {} : { projectId }),
      showForSpecificSelectionOnly: false, ignoreUserState: true,
    }) });
    if (!response.ok) return { status: response.status, body: {
      error: response.status === 401 ? 'unauthorized' : 'upstream_error',
      detail: await readLimitedText(response, 4096),
    } };
    // Detect truncation rather than interpreting a partial page as success.
    const pageText = await readLimitedText(response, 2 * 1024 * 1024 + 1);
    if (new TextEncoder().encode(pageText).length > 2 * 1024 * 1024) throw new Error('Index page too large');
    const page = object(JSON.parse(pageText));
    const total = integer(page.recordsTotal);
    if (!Array.isArray(page.data) || page.data.length > 500) throw new Error('Invalid index page');
    // One malformed or version-less document must not hide the rest of the index.
    for (const item of page.data) {
      try { records.push(projectDocument(item)); } catch (error) {
        console.warn('[bimcollab-relay] skipped index record:', error instanceof Error ? error.message : String(error));
      }
    }
    if (start + page.data.length >= Math.min(total, 5000)) break;
    if (page.data.length !== 500) throw new Error('Incomplete index page');
  }
  return { status: 200, body: { records } };
}
