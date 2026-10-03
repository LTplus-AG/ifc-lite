/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash } from 'node:crypto';
import { open, rename, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { public994 } from './sdk-client/contracts.ts';
import { fileHash } from './interleaved-assets.mjs';

// A fixture download only; all ingestion continues through the canonical endpoint.
export async function downloadPinnedFixture(pin, directory) {
  const file = join(directory, pin.path), partial = `${file}.partial`;
  const receiptPath = join(directory, `${pin.path}.download.json`);
  const receipt = { status: 'started', url: pin.url, sourceCommit: pin.sourceCommit,
    requestAcceptEncoding: 'identity',
    expectedBytes: pin.bytes, expectedSha256: pin.sha256, file, bytes: 0, startedUTC: new Date().toISOString() };
  let handle;
  try {
    const response = await fetch(pin.url, { redirect: 'error', signal: AbortSignal.timeout(180000),
      headers: { 'Accept-Encoding': receipt.requestAcceptEncoding } });
    Object.assign(receipt, { responseURL: response.url, httpStatus: response.status,
      contentLength: response.headers.get('content-length'), responseContentEncoding: response.headers.get('content-encoding') });
    if (response.status !== 200 || response.url !== pin.url || !response.body) throw new Error('pinned fixture HTTP response refused');
    if (receipt.responseContentEncoding !== null && receipt.responseContentEncoding !== 'identity') throw new Error('pinned fixture content encoding refused');
    if (receipt.contentLength !== null && receipt.contentLength !== String(pin.bytes)) throw new Error('pinned fixture header size refused');
    handle = await open(partial, 'wx');
    const hash = createHash('sha256');
    for await (const chunk of response.body) {
      receipt.bytes += chunk.byteLength;
      if (receipt.bytes > pin.bytes) throw new Error('pinned fixture body size exceeded');
      hash.update(chunk); await handle.writeFile(chunk);
    }
    receipt.sha256 = hash.digest('hex');
    if (receipt.bytes !== pin.bytes || receipt.sha256 !== pin.sha256) throw new Error('pinned fixture size/SHA refused');
    await handle.close(); handle = undefined;
    await rename(partial, file); receipt.status = 'complete-pinned-fixture-download';
  } catch (error) {
    receipt.status = 'refused'; receipt.reason = String(error); throw error;
  } finally {
    try { if (handle) await handle.close(); await rm(partial, { force: true }); }
    finally { receipt.endedUTC = new Date().toISOString(); await writeFile(receiptPath, JSON.stringify(receipt, null, 2)); }
  }
  return receipt;
}
export function requirePublic994Receipt(receipt, file) {
  if (receipt.status !== 'complete-pinned-fixture-download' || receipt.file !== file
    || receipt.url !== public994.url || receipt.responseURL !== public994.url || receipt.sourceCommit !== public994.sourceCommit
    || receipt.httpStatus !== 200 || receipt.expectedBytes !== public994.bytes || receipt.bytes !== public994.bytes
    || receipt.expectedSha256 !== public994.sha256 || receipt.sha256 !== public994.sha256
    || receipt.requestAcceptEncoding !== 'identity'
    || (receipt.responseContentEncoding !== null && receipt.responseContentEncoding !== 'identity')
    || (receipt.contentLength !== null && receipt.contentLength !== String(public994.bytes))) {
    throw new Error('public994 pinned download receipt/file refused');
  }
}
export async function public994Input(directory, frozenFiles) {
  const file = join(directory, public994.path), receiptPath = join(directory, `${public994.path}.download.json`);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  requirePublic994Receipt(receipt, file);
  if ((await stat(file)).size !== public994.bytes || await fileHash(file) !== public994.sha256) throw new Error('public994 file size/SHA refused');
  const receiptHash = await fileHash(receiptPath);
  if (frozenFiles[receiptPath] && frozenFiles[receiptPath] !== receiptHash) throw new Error('public994 frozen download receipt changed');
  frozenFiles[receiptPath] = receiptHash;
  frozenFiles[file] = public994.sha256;
  return { family: 'public994', ...public994, file, downloadReceipt: receiptPath };
}
