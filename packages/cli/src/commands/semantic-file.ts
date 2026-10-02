/* This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. */
import { open } from 'node:fs/promises';
export async function readSemanticFile(path: string, max = 5 * 1024 * 1024): Promise<string> {
  const file = await open(path, 'r');
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > max) throw new Error('Semantic input must be a regular file within the byte limit');
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += data.byteLength;
      if (bytes > max) throw new Error('Semantic input exceeds byte limit');
      chunks.push(data);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await file.close(); }
}
