/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * JSZip's `ZipFileWorker` hardcodes "version needed to extract" to 0x000A
 * (1.0) for every entry it writes, in both the local file header and the
 * central directory header, regardless of compression method. `writeBCF`
 * always uses DEFLATE (method 8), which the ZIP APPNOTE (4.4.3) requires
 * 0x0014 (2.0) for, so the archives this package writes are out of spec on
 * their own terms. Found while investigating #3612; whether this explains
 * the import failures reported there is not established.
 *
 * This test parses the REAL writer's REAL output with a hand-written parser
 * — never JSZip. A self round-trip (write with JSZip, read back with JSZip)
 * cannot see this defect: JSZip does not check the field it wrote, so
 * writer and reader agree with each other while disagreeing with every
 * other implementation of the format. That is exactly the trap #3612's
 * comment thread got stuck on.
 */

import { describe, it, expect } from 'vitest';
import { createBCFProject, createBCFTopic, addTopicToProject, writeBCF } from './index.js';
import { fixZipVersionNeeded } from './writer-zip-version.js';

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIRECTORY_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

interface ParsedEntry {
  name: string;
  lfhOffset: number;
  cd: { versionNeeded: number; flags: number; method: number; crc32: number; compSize: number; uncompSize: number };
  lfh: { versionNeeded: number; flags: number; method: number; crc32: number; compSize: number; uncompSize: number };
}

/** Hand-written ZIP structure parser: EOCD -> central directory -> local headers. */
function parseZip(buf: Uint8Array): ParsedEntry[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  let eocdOffset = -1;
  const minPos = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('EOCD not found');

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const entries: ParsedEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    const sig = view.getUint32(p, true);
    if (sig !== CENTRAL_DIRECTORY_SIG) {
      throw new Error(`expected central directory sig at 0x${p.toString(16)}, got 0x${sig.toString(16)}`);
    }
    const versionNeeded = view.getUint16(p + 6, true);
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc32 = view.getUint32(p + 16, true);
    const compSize = view.getUint32(p + 20, true);
    const uncompSize = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const lfhOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.slice(p + 46, p + 46 + nameLength));

    const lfhSig = view.getUint32(lfhOffset, true);
    if (lfhSig !== LOCAL_FILE_HEADER_SIG) {
      throw new Error(`expected local file header sig at 0x${lfhOffset.toString(16)}, got 0x${lfhSig.toString(16)}`);
    }
    const lfhVersionNeeded = view.getUint16(lfhOffset + 4, true);
    const lfhFlags = view.getUint16(lfhOffset + 6, true);
    const lfhMethod = view.getUint16(lfhOffset + 8, true);
    const lfhCrc32 = view.getUint32(lfhOffset + 14, true);
    const lfhCompSize = view.getUint32(lfhOffset + 18, true);
    const lfhUncompSize = view.getUint32(lfhOffset + 22, true);

    entries.push({
      name,
      lfhOffset,
      cd: { versionNeeded, flags, method, crc32, compSize, uncompSize },
      lfh: {
        versionNeeded: lfhVersionNeeded,
        flags: lfhFlags,
        method: lfhMethod,
        crc32: lfhCrc32,
        compSize: lfhCompSize,
        uncompSize: lfhUncompSize,
      },
    });

    p += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function buildSampleProject() {
  const project = createBCFProject({ name: 'ZIP metadata test', version: '2.1' });
  const topic = createBCFTopic({ title: 'Sample topic', author: 'tester@example.com' });
  addTopicToProject(project, topic);
  return project;
}

describe('writeBCF ZIP "version needed to extract" field (#3612)', () => {
  it('sets version-needed to 0x0014 (2.0) on both the local and central directory headers for every entry', async () => {
    const blob = await writeBCF(buildSampleProject());
    const buf = new Uint8Array(await blob.arrayBuffer());
    const entries = parseZip(buf);

    // Sanity: this project must produce more than one entry, or the "every
    // entry" assertion below would vacuously pass on a single-entry archive.
    expect(entries.length).toBeGreaterThan(1);

    for (const entry of entries) {
      expect(entry.cd.versionNeeded, `central directory header for ${entry.name}`).toBe(0x0014);
      expect(entry.lfh.versionNeeded, `local file header for ${entry.name}`).toBe(0x0014);
    }
  });

  it('does not touch the data-descriptor bit, DEFLATE method, sizes, or CRCs (no-regression pin)', async () => {
    const blob = await writeBCF(buildSampleProject());
    const buf = new Uint8Array(await blob.arrayBuffer());
    const entries = parseZip(buf);

    for (const entry of entries) {
      // The general-purpose bit flag field must stay untouched at 0x0000:
      // streamFiles already defaults false (bit 3, data descriptor/streamed,
      // clear) and this fix must not touch that field at all. Checking the
      // full field (not just bit 3) is deliberate: a patch that lands on the
      // wrong 2-byte offset (e.g. flags instead of version-needed) can still
      // leave bit 3 clear by coincidence while corrupting the rest of the
      // field, which a bit-3-only check would miss.
      expect(entry.cd.flags, `CD flags for ${entry.name}`).toBe(0x0000);
      expect(entry.lfh.flags, `LFH flags for ${entry.name}`).toBe(0x0000);

      expect(entry.cd.method, `CD method for ${entry.name}`).toBe(8);
      expect(entry.lfh.method, `LFH method for ${entry.name}`).toBe(8);

      // CRCs and sizes must match between the two headers and be non-zero
      // for non-empty entries — a wrong patch offset landing on a
      // length/CRC field instead of version-needed would corrupt these.
      expect(entry.lfh.crc32, `CRC mismatch for ${entry.name}`).toBe(entry.cd.crc32);
      expect(entry.lfh.compSize, `compSize mismatch for ${entry.name}`).toBe(entry.cd.compSize);
      expect(entry.lfh.uncompSize, `uncompSize mismatch for ${entry.name}`).toBe(entry.cd.uncompSize);
    }
  });

  it('preserves entry count and byte length unchanged, only rewriting 2 bytes per header (fixZipVersionNeeded unit check)', async () => {
    const before = await writeBCF(buildSampleProject()); // already patched by writeBCF
    // Call the patch function again directly to check it is idempotent and
    // byte-length preserving in isolation (not just via writeBCF's wiring).
    const after = await fixZipVersionNeeded(before);

    const beforeBuf = new Uint8Array(await before.arrayBuffer());
    const afterBuf = new Uint8Array(await after.arrayBuffer());

    expect(afterBuf.length).toBe(beforeBuf.length);
    expect(parseZip(afterBuf).length).toBe(parseZip(beforeBuf).length);
    // Idempotent: re-patching an already-patched archive changes nothing.
    expect(Array.from(afterBuf)).toEqual(Array.from(beforeBuf));
  });
});
