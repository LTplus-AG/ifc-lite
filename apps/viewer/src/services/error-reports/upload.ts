/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ModelUpload, PartAuthorization } from '@ifc-lite/report-contract';
import { ReportClient } from './client';
export async function checksum(bytes: ArrayBuffer): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return btoa(String.fromCharCode(...hash));
}
/** One bounded part in memory. Retry verifies remote parts against this exact File. */
export async function uploadModel(client: ReportClient, reportId: string, initial: ModelUpload, file: File, signal: AbortSignal, progress: (done: number) => void): Promise<void> {
  const path = `/${encodeURIComponent(reportId)}/uploads/${encodeURIComponent(initial.id)}`;
  const remote = await client.request<ModelUpload>(path, 'GET', undefined, signal);
  if (remote.status === 'ready') { progress(file.size); return; }
  if (remote.status === 'verifying') { progress(file.size); await verifyCompletion(client, path, remote, signal); return; }
  if (remote.status !== 'uploading' || !Number.isSafeInteger(remote.partBytes) || remote.partBytes < 1 || remote.partBytes > 64 * 1024 ** 2 || remote.partCount !== Math.ceil(file.size / remote.partBytes)) throw new Error('The upload cannot be resumed');
  let done = 0;
  for (let partNumber = 1; partNumber <= remote.partCount; partNumber++) {
    signal.throwIfAborted();
    const start = (partNumber - 1) * remote.partBytes;
    const bytes = await file.slice(start, Math.min(file.size, start + remote.partBytes)).arrayBuffer();
    const sha256 = await checksum(bytes);
    const previous = remote.uploadedParts.find(part => part.partNumber === partNumber);
    if (previous && (previous.sha256 !== sha256 || previous.size !== bytes.byteLength)) throw new Error('The selected model differs from the uploaded model');
    if (!previous) {
      const part = await client.request<PartAuthorization>(`${path}/parts`, 'POST', { partNumber, sha256 }, signal);
      await client.putPart(part.url, bytes, sha256, signal);
    }
    done += bytes.byteLength;
    progress(done);
  }
  const completed = await client.request<ModelUpload>(`${path}/complete`, 'POST', {}, signal);
  await verifyCompletion(client, path, completed, signal);
}

async function verifyCompletion(client: ReportClient, path: string, initial: ModelUpload, signal: AbortSignal): Promise<void> {
  let completed = initial;
  const deadline = Date.now() + 20 * 60_000;
  while (completed.status === 'verifying') {
    if (Date.now() > deadline) throw new Error('Model verification is still running. Retry to check its status.');
    await waitForVerification(signal);
    completed = await client.request<ModelUpload>(path, 'GET', undefined, signal);
  }
  if (completed.status !== 'ready') throw new Error('The uploaded model could not be verified.');
}

function waitForVerification(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}
